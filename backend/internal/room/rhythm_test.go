package room

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"anitexas/backend/internal/game"
	"anitexas/backend/internal/model"
	"anitexas/backend/internal/store"
)

// 本文件是流程 + UI review 收尾的服务端守约回归（对齐 frontend/src/api/types.ts 契约增量）：
//   1 死桌防护：game.Start 失败回滚半成品、保持 waiting、可重新 ready 开局；
//   2 下一手节奏：settled 后广播 nextHand{startAt}，到点 active≥2 自动开局，全员 ready 提前；
//   3 断线回收：超 DISCONNECT_GRACE 自动离席（waiting 立即 freeSeat、playing 标 pendingLeave）
//     + 对账 snapshot；
//   4 空闲房回收：waiting 且无在座人类持续 IDLE_TTL → closed + Manager 摘除；
//   5 重买上限：MAX_REBUYS 用尽自动离席（bot 补位复用）；
//   7 snapshot 新字段装配（seq 基线 / minRaise / turnMs / seed / box / pool / ready / rebuys）。

// calmBotParams 是不加注的 bot 参数：只过牌/跟注。目的：排除「互 min-raise 拉锯致手牌
// 不收敛」的既有 game/bot 病理路径（与本 slice 无关），保证测试手牌确定性收摊。
func calmBotParams(delayMs int) BotParams {
	return BotParams{DelayMs: delayMs, CallThreshold: 0, RaiseThreshold: 2, MaxCallRatio: 1}
}

// newRhythmRoom 建一张节奏测试桌：harness（座位 0，无链路、botAct 代打）+ 3 bot
// （座位 1 挂 obs），bot 启发式参数显式注入，Timing 显式注入。
func newRhythmRoom(t *testing.T, cfg model.RoomConfig, timing Timing, turnTimeoutSeconds int, bp BotParams) (*Room, *obsLink) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "rhythm.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	r := NewRoom("room-rhythm", "RHY001", "harness", cfg, turnTimeoutSeconds, bp,
		synthLibrary(2000), st, nil, timing)
	t.Cleanup(r.Close)
	obs := newObsLink()
	for i := 1; i < 4; i++ {
		occ := &occupant{nick: BotNick(i), isBot: true, ready: true}
		if i == 1 {
			occ.link = obs // 观测链路挂 bot：房主保持“无链路”，由 botAct 代打
		}
		r.seats[i] = occ
	}
	if _, err := r.Join("harness"); err != nil {
		t.Fatalf("harness 入座: %v", err)
	}
	return r, obs
}

// waitFrame 排队取下行帧直到 pred 命中；超时即失败（跳过无关帧）。
func waitFrame(t *testing.T, obs *obsLink, timeout time.Duration, what string,
	pred func(model.Envelope) bool) model.Envelope {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case raw := <-obs.ch:
			env, err := model.DecodeEnvelope(raw)
			if err != nil {
				t.Fatalf("%s: 解信封: %v", what, err)
			}
			if pred(env) {
				return env
			}
		case <-deadline:
			t.Fatalf("%s: %v 内未等到目标帧", what, timeout)
		}
	}
}

// nextSettled 收帧直到 settled；遇 error 下行即失败（不死桌硬不变量）。
func nextSettled(t *testing.T, obs *obsLink, label string) {
	t.Helper()
	deadline := time.After(30 * time.Second)
	for {
		select {
		case raw := <-obs.ch:
			env, err := model.DecodeEnvelope(raw)
			if err != nil {
				t.Fatalf("%s: 解信封: %v", label, err)
			}
			switch env.T {
			case model.TypeError:
				t.Fatalf("%s: 出现 error 下行（桌不得死）: %s", label, string(env.P))
			case model.TypeSettled:
				return
			}
		case <-deadline:
			t.Fatalf("%s: 30s 未 settled（卡死或开局失败）", label)
		}
	}
}

// drain 清空观测链路在途帧。
func drain(obs *obsLink) {
	for {
		select {
		case <-obs.ch:
		default:
			return
		}
	}
}

// TestStartFailureNoDeadTableAndRecover 死桌防护（改动 1）：装盒成功但 game.Start 失败
// （牌堆不足一手）→ 广播 error（deck_exhausted）、回滚手牌行/手序号、状态保持 waiting；
// 换好牌池后重新 ready 必须能正常开手（不死桌、可重开）。
func TestStartFailureNoDeadTableAndRecover(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "dead.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := baseCfg()
	cfg.DeckSize = 78
	// 卡池只有 5 张，撑不起一手牌（4 人需 2*4+5=13 张）——game.Start 必回 deck_exhausted。
	r := NewRoom("room-dead", "DEAD01", "host", cfg, 0, DefaultBotParams(),
		synthLibrary(5), st, nil, Timing{})
	t.Cleanup(r.Close)
	obs := newObsLink()
	for i := 1; i < 4; i++ {
		r.seats[i] = &occupant{nick: BotNick(i), isBot: true, ready: true}
	}
	if _, err := r.Join("host"); err != nil {
		t.Fatalf("host 入座: %v", err)
	}
	// 命令拒绝只回给房主本人，因此把观测链路挂在房主座位。
	if err := r.Attach(0, obs); err != nil {
		t.Fatalf("挂观测链路: %v", err)
	}

	if err := r.Ready(0); err != nil {
		t.Fatalf("ready: %v", err)
	}
	if err := r.StartGame(0, model.StartPayload{}); err == nil {
		t.Fatal("牌堆不足时开局应失败")
	}
	env := waitFrame(t, obs, 2*time.Second, "开局失败 error",
		func(e model.Envelope) bool { return e.T == model.TypeError })
	var ep model.ErrorPayload
	if err := env.Decode(&ep); err != nil {
		t.Fatalf("解 error: %v", err)
	}
	if ep.Code != game.CodeDeckExhausted {
		t.Fatalf("错误码应 %s，实得 %q（msg=%s）", game.CodeDeckExhausted, ep.Code, ep.Msg)
	}

	r.mu.Lock()
	status, handID, handSeq, seedCommit := r.status, r.handID, r.handSeq, r.handSeedCommit
	r.mu.Unlock()
	if status != model.StatusWaiting || handID != 0 || handSeq != 0 || seedCommit != "" {
		t.Fatalf("开局失败后应保持 waiting 且半成品已回滚：status=%s handID=%d handSeq=%d seedCommit=%q",
			status, handID, handSeq, seedCommit)
	}
	if hands, err := st.ListHands(r.ID()); err != nil || len(hands) != 0 {
		t.Fatalf("回滚后不应残留手牌行（%d 行）：%v", len(hands), err)
	}

	// 可重新 ready 开局：换好牌池再 ready，必须正常开手。
	r.mu.Lock()
	r.deckLib = synthLibrary(2000)
	r.mu.Unlock()
	if err := r.Ready(0); err != nil {
		t.Fatalf("重开 ready: %v", err)
	}
	if err := r.StartGame(0, model.StartPayload{}); err != nil {
		t.Fatalf("重开 start: %v", err)
	}
	waitFrame(t, obs, 2*time.Second, "重开 seedCommit",
		func(e model.Envelope) bool { return e.T == model.TypeSeedCommit })
	r.mu.Lock()
	status, handSeq = r.status, r.handSeq
	r.mu.Unlock()
	if status != model.StatusPlaying || handSeq != 1 {
		t.Fatalf("重开应进入 playing 且手序号为 1：status=%s handSeq=%d", status, handSeq)
	}
	if hands, err := st.ListHands(r.ID()); err != nil || len(hands) != 1 {
		t.Fatalf("重开后应恰 1 行手牌（失败行已删，实际 %d 行）：%v", len(hands), err)
	}
}

// TestNextHandAutoStartAndPause 练习房自动续局：settled 后服务端排程并自动开手；
// 房主切回手动后旧定时器必须失效，不再偷偷开局。
func TestNextHandAutoStartAndPause(t *testing.T) {
	cfg := baseCfg()
	cfg.Chips = 100000
	cfg.DeckSize = 78
	cfg.NextHandPolicy = model.NextHandAutomatic
	delay := 2 * time.Second
	r, obs := newRhythmRoom(t, cfg, Timing{NextHandDelay: delay}, 0, calmBotParams(0))

	readyAndStart(t, r, 0)
	nextSettled(t, obs, "第一手")

	// settled 后广播 nextHand{startAt ≈ 排程时刻+delay}。
	env := waitFrame(t, obs, 2*time.Second, "nextHand",
		func(e model.Envelope) bool { return e.T == model.TypeNextHand })
	var nh model.NextHandPayload
	if err := env.Decode(&nh); err != nil {
		t.Fatalf("解 nextHand: %v", err)
	}
	if d := nh.StartAt - time.Now().UnixMilli(); d < delay.Milliseconds()-2000 || d > delay.Milliseconds()+500 {
		t.Fatalf("nextHand.startAt 距观察时刻 %dms，want ≈ %v（now+delay）", d, delay)
	}

	// 到点自动开局：不点 ready，等下一手 seedCommit。
	waitFrame(t, obs, 3*delay+4*time.Second, "自动开局 seedCommit",
		func(e model.Envelope) bool { return e.T == model.TypeSeedCommit })
	nextSettled(t, obs, "第二手")

	// 暂停自动续局：服务端取消排程，旧定时器不得再开局。
	waitFrame(t, obs, 2*time.Second, "第三手排程", func(e model.Envelope) bool {
		return e.T == model.TypeNextHand
	})
	if err := r.SetNextHandPolicy(0, model.NextPolicyPayload{Policy: model.NextHandManual}); err != nil {
		t.Fatalf("暂停自动续局: %v", err)
	}
	drain(obs)
	select {
	case raw := <-obs.ch:
		env, _ := model.DecodeEnvelope(raw)
		if env.T == model.TypeSeedCommit {
			t.Fatal("切回手动后仍自动开局")
		}
	case <-time.After(delay + 1500*time.Millisecond):
	}
	r.mu.Lock()
	nextHandAt := r.nextHandAt
	r.mu.Unlock()
	if nextHandAt != nil {
		t.Fatalf("手动策略下 nextHandAt 应为 nil，实得 %v", *nextHandAt)
	}

	// 手动模式仍可由房主 ready + start 开下一手。
	readyAndStart(t, r, 0)
	waitFrame(t, obs, 2*time.Second, "手动开局 seedCommit",
		func(e model.Envelope) bool { return e.T == model.TypeSeedCommit })
}

// TestDisconnectRecycleWaiting 断线回收（改动 3/6）：waiting 态真人断线超宽限立即 freeSeat，
// 并向在线座位广播对账 snapshot；宽限期内保留座位（可重连）。
func TestDisconnectRecycleWaiting(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "disc.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	timing := Timing{
		DisconnectGrace: 200 * time.Millisecond,
		ReapInterval:    40 * time.Millisecond,
		IdleTTL:         time.Minute, // 保住房间（回收测试另测）
	}
	r := NewRoom("room-disc", "DISC01", "host", baseCfg(), 0, DefaultBotParams(),
		synthLibrary(200), st, nil, timing)
	t.Cleanup(r.Close)
	alice, err := r.Join("alice")
	if err != nil {
		t.Fatalf("alice 入座: %v", err)
	}
	bob, err := r.Join("bob")
	if err != nil {
		t.Fatalf("bob 入座: %v", err)
	}
	obsAlice, obsBob := newObsLink(), newObsLink()
	if err := r.Attach(alice, obsAlice); err != nil {
		t.Fatalf("alice 挂接: %v", err)
	}
	if err := r.Attach(bob, obsBob); err != nil {
		t.Fatalf("bob 挂接: %v", err)
	}
	drain(obsBob) // 排空 Attach 直发快照

	// ready 广播（改动 3）：alice 准备 → readied{seat}。
	if err := r.Ready(alice); err != nil {
		t.Fatalf("alice ready: %v", err)
	}
	env := waitFrame(t, obsBob, 2*time.Second, "readied",
		func(e model.Envelope) bool { return e.T == model.TypeReadied })
	var rp model.ReadiedPayload
	if err := env.Decode(&rp); err != nil || rp.Seat != alice {
		t.Fatalf("readied 应 {seat:%d}，实得 %+v（%v）", alice, rp, err)
	}

	// alice 断线：宽限期内座位保留。
	r.Detach(alice)
	time.Sleep(80 * time.Millisecond) // < 200ms 宽限
	r.mu.Lock()
	still := r.seats[alice] != nil
	r.mu.Unlock()
	if !still {
		t.Fatal("宽限期内不应离席")
	}

	// 超宽限 + 巡检：waiting 立即 freeSeat + 对账 snapshot 广播。
	waitFrame(t, obsBob, 3*time.Second, "断线回收对账快照",
		func(e model.Envelope) bool { return e.T == model.TypeSnapshot })
	r.mu.Lock()
	gone, status := r.seats[alice] == nil, r.status
	r.mu.Unlock()
	if !gone {
		t.Fatal("断线超宽限应自动离席（waiting 立即释放座位）")
	}
	if status != model.StatusWaiting {
		t.Fatalf("回收不应改房间状态: %s", status)
	}
	// bob 仍在座，房间不回收。
	r.mu.Lock()
	bobKept := r.seats[bob] != nil
	r.mu.Unlock()
	if !bobKept {
		t.Fatal("在座人类不应被回收")
	}
}

// TestDisconnectRecyclePlayingMarksPendingLeave 断线回收（改动 3）：playing 态真人断线
// 超宽限只标 pendingLeave（收手生效），不即时蒸发座位。bot 思考延迟拉长保证手牌仍在进行中。
func TestDisconnectRecyclePlayingMarksPendingLeave(t *testing.T) {
	cfg := baseCfg()
	cfg.Chips = 100000
	cfg.DeckSize = 78
	r, obs := newRhythmRoom(t, cfg, Timing{
		DisconnectGrace: 150 * time.Millisecond,
		ReapInterval:    40 * time.Millisecond,
	}, 0, calmBotParams(3000))

	readyAndStart(t, r, 0)
	waitFrame(t, obs, 5*time.Second, "开局 seedCommit",
		func(e model.Envelope) bool { return e.T == model.TypeSeedCommit })

	r.Detach(0) // harness（真人）断线
	deadline := time.Now().Add(3 * time.Second)
	for {
		r.mu.Lock()
		occ := r.seats[0]
		playing := r.status == model.StatusPlaying
		flag := occ != nil && occ.pendingLeave
		r.mu.Unlock()
		if playing && flag {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("playing 中断线超宽限应收手标记 pendingLeave（playing=%v flag=%v）", playing, flag)
		}
		time.Sleep(30 * time.Millisecond)
	}
	r.mu.Lock()
	still := r.seats[0] != nil
	r.mu.Unlock()
	if !still {
		t.Fatal("局中不应即时蒸发座位（收手生效，见 onSettled）")
	}
}

// TestIdleRoomRecycle 空闲房回收（改动 4）：waiting 且无在座人类持续 IDLE_TTL →
// closed + Manager 摘除（onDissolve 回调）；TTL 内仍存活（可重连/重进）。
func TestIdleRoomRecycle(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "idle.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	dissolved := make(chan *Room, 1)
	timing := Timing{IdleTTL: 250 * time.Millisecond, ReapInterval: 50 * time.Millisecond}
	r := NewRoom("room-idle", "IDLE01", "host", baseCfg(), 0, DefaultBotParams(),
		synthLibrary(200), st, func(rr *Room) { dissolved <- rr }, timing)
	t.Cleanup(r.Close)

	alice, err := r.Join("alice")
	if err != nil {
		t.Fatalf("alice 入座: %v", err)
	}
	if err := r.Leave(alice); err != nil {
		t.Fatalf("alice 离座: %v", err)
	}

	// TTL 内仍存活。
	time.Sleep(100 * time.Millisecond)
	if got := r.Status(); got != model.StatusWaiting {
		t.Fatalf("空闲 TTL 内不应关房，实得 %s", got)
	}

	// 持续空闲超 TTL → closed + Manager 摘除回调。
	select {
	case got := <-dissolved:
		if got != r {
			t.Fatal("解散回调对象不符")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("空闲超 TTL 未回收房间")
	}
	if got := r.Status(); got != model.StatusClosed {
		t.Fatalf("回收后应 closed，实得 %s", got)
	}
}

// TestRebuyCapExhaustedLeaves 重买上限（改动 5）：MAX_REBUYS=1 且唯一一次重买已被预支，
// 破产处置 Rebuy 必回 rebuy_exhausted → 自动离席（bot 补位复用）；
// 全程 rebuys 不越上限、桌不死（零 error 下行）、离席后广播对账 snapshot。
func TestRebuyCapExhaustedLeaves(t *testing.T) {
	cfg := baseCfg()
	cfg.Seats = 2 // 单挑
	// 盲注 = 全栈：每手双方全下必摊牌、必有一人破产——排除 bot 固定弃牌模式的无破产拉锯，
	// 破产处置路径必被走到。
	cfg.Chips = 20
	cfg.SmallBlind = 20
	cfg.BigBlind = 20
	cfg.DeckSize = 78
	st, err := store.Open(filepath.Join(t.TempDir(), "rebuy.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	bp := DefaultBotParams()
	bp.DelayMs = 0
	r := NewRoom("room-rebuy", "REBY01", "harness", cfg, 0, bp, synthLibrary(2000), st, nil,
		Timing{MaxRebuys: 1, IdleTTL: time.Minute})
	t.Cleanup(r.Close)
	obs := newObsLink()
	r.seats[1] = &occupant{nick: BotNick(1), isBot: true, ready: true, link: obs}
	if _, err := r.Join("harness"); err != nil {
		t.Fatalf("harness 入座: %v", err)
	}

	// 第一手跑起来（game 实例就绪）。
	readyAndStart(t, r, 0)
	nextSettled(t, obs, "第 1 手")

	// 预支 harness 的唯一一次重买：破产处置时 Rebuy 必回 rebuy_exhausted。
	// （若第 1 手已破产重买过一次，此处自然耗尽——同为达成态。）
	r.mu.Lock()
	err = r.game.Rebuy(0)
	r.mu.Unlock()
	if err != nil && errCode(err, "") != game.CodeRebuyExhausted {
		t.Fatalf("预支重买: %v", err)
	}

	freed := false
	for h := 2; h <= 24; h++ {
		// 白盒挂回观测链路（与 TestBankruptcySoakNeverDies 同法）：bot 离席后 beginHand
		// 补位的新 bot 不带链路，不挂回测试从下一手起失明（测试观测缺陷，非产品行为）。
		r.mu.Lock()
		if r.seats[1] == nil {
			r.seats[1] = &occupant{nick: BotNick(1), isBot: true, ready: true}
		}
		r.seats[1].link = obs
		r.mu.Unlock()
		readyAndStart(t, r, 0)
		nextSettled(t, obs, fmt.Sprintf("第 %d 手", h))
		// settled 广播与破产处置同临界区：此刻抢到 r.mu 即处置已收尾。
		r.mu.Lock()
		occ := r.seats[0]
		gone := occ == nil || occ.isBot
		rebuys := 0
		if r.game != nil {
			rebuys = r.game.Rebuys(0)
		}
		r.mu.Unlock()
		if rebuys > 1 {
			t.Fatalf("第 %d 手 harness 重买次数 %d 超上限 1（达上限应离席）", h, rebuys)
		}
		if gone {
			freed = true
			// 对账帧（改动 6）：破产处置/离席后广播全量 snapshot。
			waitFrame(t, obs, 2*time.Second, "离席对账快照",
				func(e model.Envelope) bool { return e.T == model.TypeSnapshot })
			break
		}
	}
	if !freed {
		t.Fatal("24 手内未逼出「重买次数用尽 → 自动离席」（MAX_REBUYS 路径未覆盖）")
	}
}

// TestSnapshotContractFields snapshot 装配（改动 7/5）：seq 基线、minRaise/turnMs（game 访问器）、
// seed 摊牌前 null/摊牌后可见、box 只含 L1 公开字段（D7 不下发 elements）、pool 摘要、
// seats ready/rebuys；acted 载荷透传 minRaise。
func TestSnapshotContractFields(t *testing.T) {
	cfg := baseCfg()
	cfg.Chips = 100000
	cfg.DeckSize = 78
	r, obs := newRhythmRoom(t, cfg, Timing{}, 5 /* turnMs=5000 */, calmBotParams(100))

	// waiting 态：ready 真源、池摘要、seq 基线、box 空、seed null。
	r.mu.Lock()
	r.seats[0].ready = true
	r.seats[1].ready = false // 白盒造一真一假，钉死 ready 真源装配
	snap0 := r.snapshotLocked(0)
	r.mu.Unlock()
	if !snap0.Seats[0].Ready || snap0.Seats[1].Ready {
		t.Fatalf("ready 真源装配错误: %+v", snap0.Seats)
	}
	if snap0.Pool.Strategy != "stratified" || snap0.Pool.Theme != nil ||
		snap0.Pool.PoolSize != 2000 || snap0.Pool.Fallback {
		t.Fatalf("pool 摘要错误: %+v", snap0.Pool)
	}
	if snap0.TurnMs != 5000 {
		t.Fatalf("turnMs = %d, want 5000", snap0.TurnMs)
	}
	if snap0.Seed != nil {
		t.Fatalf("未开局/摊牌前 seed 应为 null，实得 %v", *snap0.Seed)
	}
	if len(snap0.Box) != 0 {
		t.Fatalf("未开局 box 应为空，实得 %d", len(snap0.Box))
	}

	// 开局跑到中局（bot 思考 300ms，中局快照安全）。
	readyAndStart(t, r, 0)
	waitFrame(t, obs, 5*time.Second, "开局 seedCommit",
		func(e model.Envelope) bool { return e.T == model.TypeSeedCommit })
	r.mu.Lock()
	snapMid := r.snapshotLocked(1)
	wantMinRaise, wantRebuys, seqNow := r.game.MinRaise(), r.game.Rebuys(1), r.seq
	r.mu.Unlock()
	if snapMid.MinRaise != wantMinRaise {
		t.Fatalf("minRaise = %d, want(game.MinRaise) %d", snapMid.MinRaise, wantMinRaise)
	}
	if snapMid.TurnMs != 5000 {
		t.Fatalf("turnMs = %d, want 5000", snapMid.TurnMs)
	}
	if snapMid.Seq != seqNow {
		t.Fatalf("seq 基线 = %d, want 最后事件序号 %d", snapMid.Seq, seqNow)
	}
	if snapMid.Seed != nil {
		t.Fatalf("摊牌前 seed 应为 null，实得 %v", *snapMid.Seed)
	}
	if len(snapMid.Box) != cfg.DeckSize {
		t.Fatalf("box 应 %d 张（本手牌盒），实得 %d", cfg.DeckSize, len(snapMid.Box))
	}
	if snapMid.Seats[1].Rebuys != wantRebuys {
		t.Fatalf("seats[1].rebuys = %d, want(game.Rebuys) %d", snapMid.Seats[1].Rebuys, wantRebuys)
	}
	// box 只含 L1 公开字段：序列化绝不出现隐藏要素（D7/D17）。
	b, err := json.Marshal(snapMid.Box)
	if err != nil {
		t.Fatalf("编 box: %v", err)
	}
	if strings.Contains(string(b), "elements") || strings.Contains(string(b), "class") {
		t.Fatalf("box 泄露隐藏字段: %s", b)
	}

	// seq 基线语义：resync 快照信封 seq = 载荷 seq + 1（基线即信封 seq 的当前值）。
	r.Resync(1)
	env := waitFrame(t, obs, 2*time.Second, "resync snapshot",
		func(e model.Envelope) bool { return e.T == model.TypeSnapshot })
	var sp model.SnapshotPayload
	if err := env.Decode(&sp); err != nil {
		t.Fatalf("解 snapshot: %v", err)
	}
	if env.Seq != sp.Seq+1 {
		t.Fatalf("信封 seq %d 应 = 载荷 seq 基线 %d + 1", env.Seq, sp.Seq)
	}

	// acted 载荷透传 minRaise（改动 5）。
	waitFrame(t, obs, 60*time.Second, "acted 带 minRaise", func(e model.Envelope) bool {
		if e.T != model.TypeActed {
			return false
		}
		var ap model.ActedPayload
		if err := e.Decode(&ap); err != nil {
			t.Fatalf("解 acted: %v", err)
		}
		if ap.MinRaise == nil {
			t.Fatalf("acted 载荷缺 minRaise: %s", string(e.P))
		}
		return true
	})

	// 摊牌后 seed 可见（与 seedReveal 一致）。
	env = waitFrame(t, obs, 60*time.Second, "seedReveal",
		func(e model.Envelope) bool { return e.T == model.TypeSeedReveal })
	var sr model.SeedRevealPayload
	if err := env.Decode(&sr); err != nil {
		t.Fatalf("解 seedReveal: %v", err)
	}
	r.mu.Lock()
	snapAfter := r.snapshotLocked(1)
	r.mu.Unlock()
	if snapAfter.Seed == nil || *snapAfter.Seed != sr.Seed {
		t.Fatalf("摊牌后 snapshot.seed 应 = %q，实得 %v", sr.Seed, snapAfter.Seed)
	}
}

package room

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"anitexas/backend/internal/model"
	"anitexas/backend/internal/store"
)

// v2 状态帧回归（docs/experience-handoff/02-state-contract.md）：
//   - 开局即有一份完整权威帧（不需要等增量事件拼）；
//   - 每次成功命令 revision 单调递增，同一提交的接收者共享版本；
//   - 结算后在状态帧里能直接恢复 lastResult / nextHandAt；
//   - 命令元数据：stale_state 拒绝、requestId 去重。

func newStateRoom(t *testing.T, seats int, timing Timing) (*Room, *obsLink) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := model.RoomConfig{
		Seats: seats, SmallBlind: 1, BigBlind: 2, Chips: 200, DeckSize: 20,
		DeckStrategy: "stratified", ChatEnabled: true,
		RoomKind: model.RoomKindPractice, BotPolicy: model.BotPolicyFill,
		TargetHumanCount: 2, NextHandPolicy: model.NextHandManual,
	}
	r := NewRoom("room-state", "STA001", "harness", cfg, 30, calmBotParams(3),
		synthLibrary(500), st, nil, timing)
	t.Cleanup(r.Close)
	if _, err := r.Join("harness"); err != nil {
		t.Fatalf("入座: %v", err)
	}
	obs := newObsLink()
	if err := r.Attach(0, obs); err != nil {
		t.Fatalf("挂链: %v", err)
	}
	return r, obs
}

func decodeState(t *testing.T, env model.Envelope) model.StateFrame {
	t.Helper()
	var f model.StateFrame
	if err := env.Decode(&f); err != nil {
		t.Fatalf("解 state 帧: %v", err)
	}
	return f
}

// TestStateFrameOpening 首个权威帧就带有开局完整状态（底牌/阶段/座位参局），
// 且连接打开即收到帧（live 门控），无需等待增量事件。
func TestStateFrameOpening(t *testing.T) {
	r, obs := newStateRoom(t, 4, Timing{NextHandDelay: time.Second})

	join := decodeState(t, waitFrame(t, obs, time.Second, "join 帧", func(e model.Envelope) bool {
		return e.T == model.TypeState
	}))
	if join.Reason != stateReasonJoin || join.ProtocolVersion != 2 || join.RoomInstanceID != "room-state" {
		t.Fatalf("join 帧头部不符: %+v", join)
	}
	if join.State.Phase != model.PhaseWaiting {
		t.Fatalf("入座应为 waiting,实际 %s", join.State.Phase)
	}

	if err := r.ReadyWithMeta(0, model.CommandMeta{ProtocolVersion: 2, RequestID: "req-ready-1"}); err != nil {
		t.Fatalf("准备: %v", err)
	}
	if err := r.StartGame(0, model.StartPayload{CommandMeta: model.CommandMeta{
		ProtocolVersion: 2, RequestID: "req-start-1",
	}}); err != nil {
		t.Fatalf("房主开始: %v", err)
	}
	var frame model.StateFrame
	deadline := time.After(3 * time.Second)
	for deadline != nil && frame.State.Phase == "" {
		env := waitFrame(t, obs, 2*time.Second, "开局帧", func(e model.Envelope) bool { return e.T == model.TypeState })
		f := decodeState(t, env)
		if f.State.Phase == model.PhasePreflop {
			frame = f
		}
	}
	if frame.State.Phase != model.PhasePreflop {
		t.Fatalf("开局应有 preflop 权威帧")
	}
	if frame.State.HandSeq != 1 || frame.State.RoomStatus != model.StatusPlaying {
		t.Fatalf("开局帧 handSeq/roomStatus 不符: %d/%s", frame.State.HandSeq, frame.State.RoomStatus)
	}
	if len(frame.State.MyCards) != 2 {
		t.Fatalf("开局帧应自带本人底牌,实际 %d 张", len(frame.State.MyCards))
	}
	found := false
	for _, e := range frame.Events {
		if e.Kind == model.TypeDealt {
			found = true
		}
	}
	if !found {
		t.Fatal("开局帧 events 应包含 dealt")
	}
	for _, s := range frame.State.Seats {
		if s.OccupantKind == "" {
			t.Fatalf("座位 %d 缺 occupantKind", s.Seat)
		}
	}
	if frame.Revision <= join.Revision {
		t.Fatalf("开局 revision 应递增: join=%d mut=%d", join.Revision, frame.Revision)
	}
	// 私密事件纪律：dealt（含底牌）与 private 揭示只随本人帧下发，不能进共享历史，
	// 否则同帧其他座位会拿到他人底牌。
	for _, ev := range frame.State.RecentEvents {
		if ev.Kind == model.TypeDealt {
			t.Fatalf("dealt 不得进入共享 recentEvents: %+v", ev)
		}
		if _, ok := ev.Payload["cards"]; ok {
			t.Fatalf("recentEvents 不得携带牌面载荷: %+v", ev.Payload)
		}
	}
}

// TestStateFrameProgressionAndResult 用 state 帧驱动一手牌打完：
// 每次本人回合按 legalActions 行动，最终帧必须带 lastResult（结算可得）+ 回到 waiting。
func TestStateFrameProgressionAndResult(t *testing.T) {
	r, obs := newStateRoom(t, 2, Timing{NextHandDelay: 10 * time.Second})
	readyAndStart(t, r, 0)

	deadline := time.After(15 * time.Second)
	lastRev := int64(0)
	actedKey := ""
	sawBetting := false
	for {
		select {
		case <-deadline:
			t.Fatal("15s 内未打完一手并收到结算帧")
		default:
		}
		env := waitFrame(t, obs, 10*time.Second, "过程中状态帧", func(e model.Envelope) bool { return e.T == model.TypeState })
		f := decodeState(t, env)
		if f.Revision < lastRev {
			t.Fatalf("revision 回退: %d -> %d", lastRev, f.Revision)
		}
		lastRev = f.Revision
		st := f.State
		if st.Phase == model.PhasePreflop || st.Phase == model.PhaseFlop || st.Phase == model.PhaseTurn || st.Phase == model.PhaseRiver {
			sawBetting = true
		}
		if st.LastResult != nil && st.RoomStatus == model.StatusWaiting {
			if st.LastResult.HandSeq != 1 {
				t.Fatalf("结算摘要 handSeq 应为 1,实际 %d", st.LastResult.HandSeq)
			}
			if len(st.LastResult.Rows) == 0 {
				t.Fatal("结算摘要应含 rows")
			}
			if !sawBetting {
				t.Fatal("结算前应观察到至少一个下注街")
			}
			if st.NextHandAt == nil && st.NextHandPolicy == "automatic" {
				t.Fatal("自动策略下结算帧应带 nextHandAt")
			}
			return
		}
		if st.TurnSeat != 0 {
			continue
		}
		key := string(st.Phase) + "/" + itoa(st.HandSeq)
		if actedKey == key {
			continue
		}
		actedKey = key
		typ := "check"
		for _, a := range st.LegalActions {
			if a == "check" {
				typ = "check"
				break
			}
			if a == "call" {
				typ = "call"
			}
		}
		if err := r.Action(0, model.ActionPayload{Type: typ}); err != nil {
			t.Fatalf("行动 %s: %v", typ, err)
		}
	}
}

// TestCommandMetaRejectsStaleAndDedupes 校验 stale_state 与 requestId 去重。
func TestCommandMetaRejectsStaleAndDedupes(t *testing.T) {
	r, obs := newStateRoom(t, 2, Timing{})
	readyAndStart(t, r, 0)
	// 等待 preflop 帧，记录 revision
	var frame model.StateFrame
	for frame.State.Phase != model.PhasePreflop {
		frame = decodeState(t, waitFrame(t, obs, 3*time.Second, "开局帧", func(e model.Envelope) bool {
			return e.T == model.TypeState
		}))
	}

	// expectedRevision 过期 → stale_state 拒绝
	err := r.Action(0, model.ActionPayload{Type: "check", CommandMeta: model.CommandMeta{
		ProtocolVersion: 2, RequestID: "req-stale", ExpectedRevision: frame.Revision - 1,
	}})
	if err == nil {
		t.Fatal("期望过期 revision 被拒绝")
	}
	env := waitFrame(t, obs, time.Second, "拒绝回执", func(e model.Envelope) bool { return e.T == model.TypeState })
	rej := decodeState(t, env)
	if len(rej.Receipts) == 0 || rej.Receipts[0].Status != "rejected" || rej.Receipts[0].RequestID != "req-stale" {
		t.Fatalf("应回 rejected receipt,实际 %+v", rej.Receipts)
	}

	// 合法动作 + requestId：applied 回执带 appliedRevision
	if frame.State.TurnSeat != 0 {
		t.Skip("当前不是本人行动，跳过 applied 回执断言")
	}
	legal := ""
	for _, a := range frame.State.LegalActions {
		if a == "check" {
			legal = "check"
			break
		}
		if a == "call" && legal == "" {
			legal = "call"
		}
	}
	if legal == "" {
		t.Fatalf("本人回合应至少可过牌或跟注,legalActions=%v", frame.State.LegalActions)
	}
	if err := r.Action(0, model.ActionPayload{Type: legal, CommandMeta: model.CommandMeta{
		ProtocolVersion: 2, RequestID: "req-ok", ExpectedRevision: frame.Revision,
	}}); err != nil {
		t.Fatalf("合法动作: %v", err)
	}
	seen := false
	for !seen {
		f := decodeState(t, waitFrame(t, obs, 3*time.Second, "applied 帧", func(e model.Envelope) bool { return e.T == model.TypeState }))
		for _, rc := range f.Receipts {
			if rc.RequestID == "req-ok" && rc.Status == "applied" && rc.AppliedRevision != nil {
				seen = true
			}
		}
	}
	// 同 requestId 重放：不再执行（revision 不因重放增长），只重放回执
	revBefore := func() int64 {
		r.mu.Lock()
		defer r.mu.Unlock()
		return r.revision
	}()
	if err := r.Action(0, model.ActionPayload{Type: legal, CommandMeta: model.CommandMeta{
		ProtocolVersion: 2, RequestID: "req-ok",
	}}); err != nil {
		t.Fatalf("重放: %v", err)
	}
	revAfter := func() int64 {
		r.mu.Lock()
		defer r.mu.Unlock()
		return r.revision
	}()
	if revAfter != revBefore {
		t.Fatalf("重放不应推进 revision: %d -> %d", revBefore, revAfter)
	}
}

// TestJoinIdentityNickTakenAndResume 身份契约：无凭据同昵称拒绝，凭据可恢复原座位。
func TestJoinIdentityNickTakenAndResume(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "ident.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := model.RoomConfig{Seats: 4, SmallBlind: 1, BigBlind: 2, Chips: 200, DeckSize: 20, DeckStrategy: "stratified"}
	r := NewRoom("room-ident", "IDE001", "host", cfg, 30, calmBotParams(3), synthLibrary(300), st, nil, Timing{})
	t.Cleanup(r.Close)

	seat, pid, token, err := r.JoinIdentity("alice", "", "j1", "")
	if err != nil || seat != 0 || pid == "" || token == "" {
		t.Fatalf("首次入座: seat=%d pid=%q token=%q err=%v", seat, pid, token, err)
	}
	if _, _, _, err := r.JoinIdentity("alice", "", "", ""); err != ErrNickTaken {
		t.Fatalf("同昵称无凭据应 nick_taken,实际 %v", err)
	}
	seat2, pid2, token2, err := r.JoinIdentity("alice", token, "", "")
	if err != nil || seat2 != seat || pid2 != pid || token2 != token {
		t.Fatalf("凭据恢复应回原座位: seat=%d pid=%q err=%v", seat2, pid2, err)
	}
	// 幂等：同 joinRequestId 复用
	seat3, _, _, _ := r.JoinIdentity("bob", "", "j1", "")
	if seat3 != seat {
		t.Fatalf("同 joinRequestId 应复用座位 %d,实际 %d", seat, seat3)
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

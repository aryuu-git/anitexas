package room

import (
	"path/filepath"
	"testing"

	"anitexas/backend/internal/model"
	"anitexas/backend/internal/store"
)

// 第二轮开局策略回归（docs/experience-handoff/05 §3 / §6 H01–H06、H16）：
// 朋友房 ready 绝不自动开局、只有房主能 start、目标人数不足不静默补人、
// 取消准备真实生效、房主离开后转交/无主关桌。

func newPolicyRoom(t *testing.T, cfg model.RoomConfig) (*Room, *obsLink, *obsLink) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "policy.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	r := NewRoom("room-policy", "POL001", "房主", cfg, 0, DefaultBotParams(),
		synthLibrary(2000), st, nil, Timing{})
	t.Cleanup(r.Close)
	if _, err := r.Join("房主"); err != nil {
		t.Fatalf("房主入座: %v", err)
	}
	if _, err := r.Join("朋友"); err != nil {
		t.Fatalf("朋友入座: %v", err)
	}
	a, b := newObsLink(), newObsLink()
	if err := r.Attach(0, a); err != nil {
		t.Fatalf("房主挂链: %v", err)
	}
	if err := r.Attach(1, b); err != nil {
		t.Fatalf("朋友挂链: %v", err)
	}
	return r, a, b
}

func friendCfg() model.RoomConfig {
	cfg := baseCfg()
	cfg.RoomKind = model.RoomKindFriend
	cfg.BotPolicy = model.BotPolicyOff
	cfg.TargetHumanCount = 2
	cfg.NextHandPolicy = model.NextHandManual
	return cfg
}

func TestFriendRoomExplicitStartOnlyByHost(t *testing.T) {
	r, _, _ := newPolicyRoom(t, friendCfg())

	// H01/H02：全员准备只是满足条件，绝不自动发牌。
	if err := r.Ready(0); err != nil {
		t.Fatalf("房主准备: %v", err)
	}
	if err := r.Ready(1); err != nil {
		t.Fatalf("朋友准备: %v", err)
	}
	r.mu.Lock()
	status, handSeq, bots := r.status, r.handSeq, r.cfg.BotPolicy
	can, _ := r.startStatusLocked()
	r.mu.Unlock()
	if status != model.StatusWaiting || handSeq != 0 {
		t.Fatalf("全员准备后应仍在准备室：status=%s handSeq=%d", status, handSeq)
	}
	if bots != model.BotPolicyOff {
		t.Fatalf("朋友房机器人应关闭：policy=%s", bots)
	}
	if !can {
		t.Fatal("全员准备且两人到齐时应允许房主开始")
	}

	// H06：取消准备真实生效，房主不能再开始。
	if err := r.CancelReadyWithMeta(1, model.CommandMeta{}); err != nil {
		t.Fatalf("取消准备: %v", err)
	}
	r.mu.Lock()
	can, reason := r.startStatusLocked()
	r.mu.Unlock()
	if can || reason != "等待 朋友 准备" {
		t.Fatalf("取消准备后应阻塞并说明原因：can=%v reason=%q", can, reason)
	}
	if err := r.Ready(1); err != nil {
		t.Fatalf("恢复准备: %v", err)
	}

	// H03：非房主 start 必须服务端拒绝。
	if err := r.StartGame(1, model.StartPayload{}); err == nil {
		t.Fatal("非房主 start 应被拒绝")
	}
	// 房主显式开始 + 同 requestId 幂等。
	if err := r.StartGame(0, model.StartPayload{CommandMeta: model.CommandMeta{RequestID: "start-1"}}); err != nil {
		t.Fatalf("房主开始: %v", err)
	}
	if err := r.StartGame(0, model.StartPayload{CommandMeta: model.CommandMeta{RequestID: "start-1"}}); err != nil {
		t.Fatalf("同 requestId 重试应幂等: %v", err)
	}
	r.mu.Lock()
	handSeq, status = r.handSeq, r.status
	r.mu.Unlock()
	if handSeq != 1 || status != model.StatusPlaying {
		t.Fatalf("应恰好开一手：handSeq=%d status=%s", handSeq, status)
	}
}

func TestFriendRoomTargetChangeIsExplicit(t *testing.T) {
	cfg := friendCfg()
	cfg.Seats = 4
	cfg.DeckSize = 78
	cfg.TargetHumanCount = 4
	r, _, _ := newPolicyRoom(t, cfg)
	if err := r.Ready(0); err != nil {
		t.Fatalf("房主准备: %v", err)
	}
	if err := r.Ready(1); err != nil {
		t.Fatalf("朋友准备: %v", err)
	}

	// H04：目标 4 人但只有 2 人 → 拒绝，且不偷偷补机器人。
	if err := r.StartGame(0, model.StartPayload{}); err == nil {
		t.Fatal("人数不足且未明确变更时应拒绝开局")
	}
	r.mu.Lock()
	humans, bots := r.humanBotCountsLocked()
	r.mu.Unlock()
	if humans != 2 || bots != 0 {
		t.Fatalf("拒绝开局不得补人：humans=%d bots=%d", humans, bots)
	}

	// 房主明确添加机器人后再开始。
	if err := r.AddBot(0, model.AddBotPayload{}); err != nil {
		t.Fatalf("添加机器人 1: %v", err)
	}
	if err := r.AddBot(0, model.AddBotPayload{}); err != nil {
		t.Fatalf("添加机器人 2: %v", err)
	}
	if err := r.StartGame(0, model.StartPayload{}); err != nil {
		t.Fatalf("补齐后应可开始: %v", err)
	}
	r.mu.Lock()
	handSeq := r.handSeq
	r.mu.Unlock()
	if handSeq != 1 {
		t.Fatalf("补齐后应恰好开一手，实得 handSeq=%d", handSeq)
	}
}

func TestTargetChangeResetsReady(t *testing.T) {
	cfg := friendCfg()
	cfg.Seats = 4
	r, _, _ := newPolicyRoom(t, cfg)
	if err := r.Ready(0); err != nil {
		t.Fatalf("房主准备: %v", err)
	}
	if err := r.Ready(1); err != nil {
		t.Fatalf("朋友准备: %v", err)
	}
	if err := r.SetTarget(0, model.SetTargetPayload{TargetHumanCount: 3}); err != nil {
		t.Fatalf("调整目标: %v", err)
	}
	r.mu.Lock()
	ready := 0
	for _, o := range r.seats {
		if o != nil && !o.isBot && o.ready {
			ready++
		}
	}
	can, reason := r.startStatusLocked()
	r.mu.Unlock()
	if ready != 0 {
		t.Fatalf("目标变化后应清空真人准备，实得 ready=%d", ready)
	}
	if can || reason != "等待 房主 准备" {
		t.Fatalf("应等待重新准备：can=%v reason=%q", can, reason)
	}
}

func TestHostLeaveTransfersThenCloses(t *testing.T) {
	r, _, _ := newPolicyRoom(t, friendCfg())
	if err := r.LeaveWithMeta(0, model.CommandMeta{}); err != nil {
		t.Fatalf("房主离座: %v", err)
	}
	r.mu.Lock()
	hostSeat, hostNick := r.hostSeat, r.host
	r.mu.Unlock()
	if hostSeat != 1 || hostNick != "朋友" {
		t.Fatalf("房主离开后应转交给仍在座真人：seat=%d nick=%s", hostSeat, hostNick)
	}
	if err := r.LeaveWithMeta(1, model.CommandMeta{}); err != nil {
		t.Fatalf("朋友离座: %v", err)
	}
	if got := r.Status(); got != model.StatusClosed {
		t.Fatalf("最后一位真人离开后房间应关闭，实得 %s", got)
	}
}

func TestPracticeRoomBotsAreExplicitPolicy(t *testing.T) {
	cfg := baseCfg()
	cfg.RoomKind = model.RoomKindPractice
	cfg.BotPolicy = model.BotPolicyFill
	cfg.TargetHumanCount = 2
	r, _, _ := newPolicyRoom(t, cfg)
	r.mu.Lock()
	humans, bots := r.humanBotCountsLocked()
	r.mu.Unlock()
	if humans != 2 || bots != 2 {
		t.Fatalf("练习房应补齐空座：humans=%d bots=%d", humans, bots)
	}
}

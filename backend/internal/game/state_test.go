package game

import (
	"testing"

	"anitexas/backend/internal/engine"
)

// TestTransitionTable 状态转移表驱动(A3.1):5 阶段全矩阵逐对断言,
// 17 种非法转移各一例,非法转移 canTransition=false 且 transition 状态不变。
func TestTransitionTable(t *testing.T) {
	all := []string{PhaseWaiting, PhaseDealing, PhaseBetting, PhaseShowdown, PhaseSettled}
	want := map[[2]string]bool{
		{PhaseWaiting, PhaseDealing}:  true,
		{PhaseDealing, PhaseBetting}:  true,
		{PhaseBetting, PhaseBetting}:  true, // 街推进(preflop->flop->turn->river)
		{PhaseBetting, PhaseShowdown}: true, // 摊牌
		{PhaseBetting, PhaseSettled}:  true, // 摊牌前弃牌即刻结算
		{PhaseShowdown, PhaseSettled}: true,
		{PhaseSettled, PhaseWaiting}:  true, // 清桌回等待
		{PhaseSettled, PhaseDealing}:  true, // 一手牌结束后重开
	}
	illegal := 0
	for _, from := range all {
		for _, to := range all {
			key := [2]string{from, to}
			got := canTransition(from, to)
			if got != want[key] {
				t.Errorf("转移 %s -> %s: canTransition = %v,期望 %v", from, to, got, want[key])
			}
			if !want[key] {
				illegal++
			}
		}
	}
	if illegal != 17 {
		t.Fatalf("非法转移应为 17 种,实际 %d", illegal)
	}
}

// TestTransitionRejectsInGame 非法转移经 Game.transition 报错且状态不变(§4.2)。
func TestTransitionRejectsInGame(t *testing.T) {
	g := newTestGame(t, Config{}, 2, nil)
	err := g.transition(PhaseSettled) // Waiting -> Settled 非法
	if err == nil {
		t.Fatal("Waiting -> Settled 应报错")
	}
	if g.state != PhaseWaiting {
		t.Fatalf("非法转移后状态被改动: %s", g.state)
	}
	if err := g.transition(PhaseDealing); err != nil {
		t.Fatalf("Waiting -> Dealing 合法转移报错: %v", err)
	}
}

// TestIllegalOpsDoNotAdvance 非法操作同步报错/发 error 事件且不推进状态(A3.1)。
func TestIllegalOpsDoNotAdvance(t *testing.T) {
	deck := riggedDeck(2, 0,
		map[int][]engine.Card{
			0: {dudCard(91), dudCard(92)},
			1: {dudCard(93), dudCard(94)},
		},
		[]engine.Card{dudCard(95), dudCard(96), dudCard(97), dudCard(98), dudCard(99)})
	g := newTestGame(t, Config{}, 2, deck)
	// 开局前下注:阶段不对
	if err := g.Submit(Action{Seat: 0, Type: "check"}); errorCodeOf(err) != CodeBadState {
		t.Fatalf("开局前 Submit 应 bad_state,实际 %v", err)
	}
	// 连开两手:第二手时机不对,同步回 bad_state(不再发 error 事件),阶段不变
	if err := g.Start(); err != nil {
		t.Fatalf("首手开局应成功: %v", err)
	}
	if err := g.Start(); errorCodeOf(err) != CodeBadState {
		t.Fatalf("重复 Start 应同步回 bad_state,实际 %v", err)
	}
	evs := drain(g)
	if countEvents(evs, EventError) != 0 {
		t.Fatalf("开局失败应同步回执、不再发 error 事件,实际 %+v", evs)
	}
	if got := g.Phase(); got != StreetPreflop {
		t.Fatalf("重复 Start 后回合被改动: %s", got)
	}
	// 对局进行中换牌:时机不对
	if err := g.SetDeck(nil); errorCodeOf(err) != CodeBadState {
		t.Fatalf("进行中 SetDeck 应 bad_state,实际 %v", err)
	}
}

// TestStartFailureKeepsWaitingRetryable 开局失败不推进状态机且可重试(Start 同步回
// error,复用 bad_state 表):人数不足 -> bad_state 保持 Waiting 且不发事件,补齐人
// 后重开成功;牌堆余量不足 -> deck_exhausted 保持 Waiting,补牌后重开成功。
func TestStartFailureKeepsWaitingRetryable(t *testing.T) {
	board := []engine.Card{dudCard(21), dudCard(22), dudCard(23), dudCard(24), dudCard(25)}
	deck := riggedDeck(2, 0, map[int][]engine.Card{
		0: {dudCard(11), dudCard(12)},
		1: {dudCard(13), dudCard(14)},
	}, board)

	// 人数不足:bad_state,状态保持 Waiting,且不发任何事件
	g := New(Config{Seats: 2, SmallBlind: 5, BigBlind: 10, StartChips: 1000}, deck)
	t.Cleanup(g.Close)
	if err := g.Join(0, "p0", false); err != nil {
		t.Fatalf("Join(0): %v", err)
	}
	if err := g.Start(); errorCodeOf(err) != CodeBadState {
		t.Fatalf("人数不足应同步回 bad_state,实际 %v", err)
	}
	if got := g.Phase(); got != PhaseWaiting {
		t.Fatalf("开局失败应保持 waiting,实际 %s", got)
	}
	if evs := drain(g); len(evs) != 0 {
		t.Fatalf("开局失败不应发任何事件,实际 %+v", evs)
	}
	// 可重试:补齐第二人后同副牌重开成功
	if err := g.Join(1, "p1", false); err != nil {
		t.Fatalf("Join(1): %v", err)
	}
	if err := g.Start(); err != nil {
		t.Fatalf("补齐玩家后重试开局应成功: %v", err)
	}
	if got := g.Phase(); got != StreetPreflop {
		t.Fatalf("重试开局后应回合 preflop,实际 %s", got)
	}

	// 牌堆余量不足:deck_exhausted,状态保持 Waiting(2 人需 2*2+5 = 9 张,只给 8 张)
	g2 := New(Config{Seats: 2, SmallBlind: 5, BigBlind: 10, StartChips: 1000}, deck[:8])
	t.Cleanup(g2.Close)
	if err := g2.Join(0, "p0", false); err != nil {
		t.Fatalf("Join(0): %v", err)
	}
	if err := g2.Join(1, "p1", false); err != nil {
		t.Fatalf("Join(1): %v", err)
	}
	if err := g2.Start(); errorCodeOf(err) != CodeDeckExhausted {
		t.Fatalf("牌堆不足应同步回 deck_exhausted,实际 %v", err)
	}
	if got := g2.Phase(); got != PhaseWaiting {
		t.Fatalf("开局失败应保持 waiting,实际 %s", got)
	}
	// 可重试:补牌后重开成功
	if err := g2.SetDeck(deck); err != nil {
		t.Fatalf("补牌: %v", err)
	}
	if err := g2.Start(); err != nil {
		t.Fatalf("补牌后重试开局应成功: %v", err)
	}
	if got := g2.Phase(); got != StreetPreflop {
		t.Fatalf("重试开局后应回合 preflop,实际 %s", got)
	}
}

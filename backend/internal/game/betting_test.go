package game

import (
	"testing"
	"time"

	"anitexas/backend/internal/engine"
)

// headsUpDeck 两人桌一副牌:seat0 拿 a/b,seat1 拿 c/d,公共牌 board。
func headsUpDeck(a, b, c, d engine.Card, board []engine.Card) []engine.Card {
	return riggedDeck(2, 0, map[int][]engine.Card{
		0: {a, b},
		1: {c, d},
	}, board)
}

// TestBettingLegality 下注合法性(A3.2):逐条非法动作断言回执 code 且状态不推进,
// 合法动作(跟注/下注/加注/全下)生效并正确轮转。
func TestBettingLegality(t *testing.T) {
	board := []engine.Card{dudCard(21), dudCard(22), dudCard(23), dudCard(24), dudCard(25)}
	g := newTestGame(t, Config{StartChips: 1000}, 2,
		headsUpDeck(dudCard(11), dudCard(12), dudCard(13), dudCard(14), board))
	g.Start()
	drain(g)

	// 两人桌:button=seat0 即小盲,preflop 先行动;小盲 5 < 大盲 10,面对下注
	if g.turn != 0 {
		t.Fatalf("preflop 应小盲先行动,实际 turn=%d", g.turn)
	}
	if err := g.Submit(Action{Seat: 0, Type: "check"}); errorCodeOf(err) != CodeCheckFacingBet {
		t.Fatalf("面对下注过牌应 check_facing_bet,实际 %v", err)
	}
	if err := g.Submit(Action{Seat: 0, Type: "bet", Amount: 20}); errorCodeOf(err) != CodeBadAction {
		t.Fatalf("已有注时 bet 应 bad_action,实际 %v", err)
	}
	if err := g.Submit(Action{Seat: 0, Type: "raise", Amount: -5}); errorCodeOf(err) != CodeBadAmount {
		t.Fatalf("负数金额应 bad_amount,实际 %v", err)
	}
	if err := g.Submit(Action{Seat: 0, Type: "raise", Amount: 15}); errorCodeOf(err) != CodeMinRaise {
		t.Fatalf("低于最小加注应 min_raise,实际 %v", err)
	}
	if err := g.Submit(Action{Seat: 0, Type: "raise", Amount: 2000}); errorCodeOf(err) != CodeChipOverbet {
		t.Fatalf("超额下注应 chip_overbet,实际 %v", err)
	}
	if err := g.Submit(Action{Seat: 1, Type: "call"}); errorCodeOf(err) != CodeNotYourTurn {
		t.Fatalf("非轮到者应 not_your_turn,实际 %v", err)
	}
	if err := g.Submit(Action{Seat: 0, Type: "call", Amount: 999}); err != nil {
		t.Fatalf("跟注应成功(忽略 amount): %v", err)
	}
	// 轮转到大盲;大盲 10 == 本轮最高注,面对无注
	if g.turn != 1 {
		t.Fatalf("跟注后应轮到大盲,实际 turn=%d", g.turn)
	}
	if err := g.Submit(Action{Seat: 1, Type: "call"}); errorCodeOf(err) != CodeNoBet {
		t.Fatalf("无注可跟时 call 应 no_bet,实际 %v", err)
	}
	// 大盲加注到 30(最小加注 = 初始 10) -> 小盲 49 不足最小(50) -> 60 合法
	if err := g.Submit(Action{Seat: 1, Type: "raise", Amount: 30}); err != nil {
		t.Fatalf("大盲加注应成功: %v", err)
	}
	if err := g.Submit(Action{Seat: 0, Type: "raise", Amount: 49}); errorCodeOf(err) != CodeMinRaise {
		t.Fatalf("低于最小加注(50)应 min_raise,实际 %v", err)
	}
	mustSubmit(t, g, Action{Seat: 0, Type: "raise", Amount: 60})
	if g.currentBet != 60 || g.minRaise != 30 {
		t.Fatalf("加注后 currentBet/minRaise = %d/%d,期望 60/30", g.currentBet, g.minRaise)
	}
	// 大盲跟注补齐,下注轮结束进 flop(两家均未全下,正常开轮)
	mustSubmit(t, g, Action{Seat: 1, Type: "call"})
	if got := g.Phase(); got != StreetFlop {
		t.Fatalf("下注轮结束应进 flop,实际 %s", got)
	}
	if g.turn != 1 {
		t.Fatalf("flop 应大盲先行动,实际 turn=%d", g.turn)
	}
	// 翻牌圈无注:bet 低于大盲应 min_bet;合法下注生效
	if err := g.Submit(Action{Seat: 1, Type: "bet", Amount: 3}); errorCodeOf(err) != CodeMinBet {
		t.Fatalf("低于大盲的下注应 min_bet,实际 %v", err)
	}
	mustSubmit(t, g, Action{Seat: 1, Type: "bet", Amount: 20})
	if g.currentBet != 20 {
		t.Fatalf("下注后 currentBet = %d,期望 20", g.currentBet)
	}
	// 加注不足最小增量(20)应 min_raise;弃牌即刻结算(A3.1 Betting->Settled)
	if err := g.Submit(Action{Seat: 0, Type: "raise", Amount: 35}); errorCodeOf(err) != CodeMinRaise {
		t.Fatalf("低于最小加注(40)应 min_raise,实际 %v", err)
	}
	mustSubmit(t, g, Action{Seat: 0, Type: "fold"})
	if _, ok := findEvent(t, drain(g), EventSettled).(*SettledPayload); !ok {
		t.Fatal("摊牌前弃牌应即刻结算")
	}
	if got := g.Phase(); got != PhaseSettled {
		t.Fatalf("弃牌赢后回合应 settled,实际 %s", got)
	}
}

// TestAllInRunout 全下扎堆:跳过剩余下注轮直发公共牌进摊牌(A3.3 一手内不重复发牌)。
func TestAllInRunout(t *testing.T) {
	board := []engine.Card{dudCard(21), dudCard(22), dudCard(23), dudCard(24), dudCard(25)}
	g := newTestGame(t, Config{StartChips: 200}, 2,
		headsUpDeck(dudCard(11), dudCard(12), dudCard(13), dudCard(14), board))
	g.Start()
	drain(g)
	mustSubmit(t, g, Action{Seat: 0, Type: "call"})
	mustSubmit(t, g, Action{Seat: 1, Type: "allin"})
	mustSubmit(t, g, Action{Seat: 0, Type: "call"}) // 等码对等,双方全下,直发摊牌
	evs := drain(g)
	if _, ok := findEvent(t, evs, EventShowdown).(*ShowdownPayload); !ok {
		t.Fatal("全下扎堆应直接摊牌")
	}
	if _, ok := findEvent(t, evs, EventSettled).(*SettledPayload); !ok {
		t.Fatal("全下扎堆应结算")
	}
	if len(g.community) != 5 {
		t.Fatalf("公共牌应发满 5 张,实际 %d", len(g.community))
	}
	if countEvents(evs, EventFlop)+countEvents(evs, EventTurn)+countEvents(evs, EventRiver) != 3 {
		t.Fatal("直发街应逐街亮出公共牌事件")
	}
}

// TestTimeoutFacesBetFolds 倒计时超时分支一(A3.6):本轮有注 -> 自动弃牌,
// 两人桌即刻弃牌赢结算(Betting->Settled)。
func TestTimeoutFacesBetFolds(t *testing.T) {
	board := []engine.Card{dudCard(21), dudCard(22), dudCard(23), dudCard(24), dudCard(25)}
	g := newTestGame(t, Config{TurnTimeoutMs: 50}, 2,
		headsUpDeck(dudCard(11), dudCard(12), dudCard(13), dudCard(14), board))
	g.Start()
	drain(g)                                 // 清掉发牌事件
	evs := waitEvents(t, g, 2, 3*time.Second) // acted(超时弃牌) + settled
	acted, ok := findEvent(t, evs, EventActed).(*ActedPayload)
	if !ok || acted.Seat != 0 || acted.Type != "fold" {
		t.Fatalf("超时应自动弃牌(小盲面对下注),实际 %+v", acted)
	}
	if _, ok := findEvent(t, evs, EventSettled).(*SettledPayload); !ok {
		t.Fatal("弃牌赢应即刻结算")
	}
	if got := g.Phase(); got != PhaseSettled {
		t.Fatalf("结算后回合应 settled,实际 %s", got)
	}
}

// TestTimeoutNoBetChecks 倒计时超时分支二(A3.6):本轮无注 -> 自动过牌。
func TestTimeoutNoBetChecks(t *testing.T) {
	board := []engine.Card{dudCard(21), dudCard(22), dudCard(23), dudCard(24), dudCard(25)}
	g := newTestGame(t, Config{TurnTimeoutMs: 50}, 2,
		headsUpDeck(dudCard(11), dudCard(12), dudCard(13), dudCard(14), board))
	g.Start()
	drain(g)                                  // 清掉发牌事件
	mustSubmit(t, g, Action{Seat: 0, Type: "call"}) // 小盲补齐,大盲无注可跟
	evs := waitEvents(t, g, 2, 3*time.Second) // acted(call) + acted(超时过牌)
	checked := false
	for _, ev := range evs {
		if acted, ok := ev.Payload.(*ActedPayload); ok && acted.Seat == 1 && acted.Type == "check" {
			checked = true
		}
	}
	if !checked {
		t.Fatalf("超时应自动过牌(大盲无注),实际 %+v", evs)
	}
}

// TestMinRaiseUpdatesAndPayload 最小加注增量随加注正确更新并进事件载荷(服务端权威):
// 满额加注抬高增量、短全下加注不动增量(且不重开加注权),acted 载荷恒带 minRaise;
// 换街后 minRaise 重置为大盲并进 flop/turn/river 载荷。
func TestMinRaiseUpdatesAndPayload(t *testing.T) {
	board := []engine.Card{dudCard(21), dudCard(22), dudCard(23), dudCard(24), dudCard(25)}
	g := newTestGame(t, Config{StartChips: 1000}, 2,
		headsUpDeck(dudCard(11), dudCard(12), dudCard(13), dudCard(14), board))
	// 白盒把 seat1 掰成短码 45(扣大盲 10 后剩 35,全下加注将不足最小加注增量)
	if err := g.call(func() error {
		g.seats[1].chips = 45
		return nil
	}); err != nil {
		t.Fatalf("白盒改码: %v", err)
	}
	if err := g.Start(); err != nil {
		t.Fatalf("开局: %v", err)
	}
	drain(g)

	// 满额加注:小盲加到 30(增量 20 >= 最小 10) -> minRaise 抬到 20 并进载荷
	mustSubmit(t, g, Action{Seat: 0, Type: "raise", Amount: 30})
	acted, ok := findEvent(t, drain(g), EventActed).(*ActedPayload)
	if !ok || acted.MinRaise == nil || *acted.MinRaise != 20 {
		t.Fatalf("满额加注后 acted.minRaise 应为 20,实际 %+v", acted)
	}
	if got := g.MinRaise(); got != 20 {
		t.Fatalf("满额加注后 minRaise = %d,期望 20", got)
	}

	// 短全下加注:seat1 全下加到 45(增量 15 < 20) -> minRaise 不动,载荷仍 20
	mustSubmit(t, g, Action{Seat: 1, Type: "allin"})
	acted, ok = findEvent(t, drain(g), EventActed).(*ActedPayload)
	if !ok || acted.MinRaise == nil || *acted.MinRaise != 20 {
		t.Fatalf("短全下加注不应抬高 minRaise,载荷 %+v,期望 20", acted)
	}
	if got := g.MinRaise(); got != 20 {
		t.Fatalf("短全下加注后 minRaise = %d,期望仍 20", got)
	}
	// 短全下加注不重开加注权:seat0 只能跟/弃
	if err := g.Submit(Action{Seat: 0, Type: "raise", Amount: 70}); errorCodeOf(err) != CodeMinRaise {
		t.Fatalf("短全下加注后应不可再加注,实际 %v", err)
	}

	// 跟注收轮 -> 全下扎堆直发街:flipStreet 载荷 minRaise 重置为大盲 10
	mustSubmit(t, g, Action{Seat: 0, Type: "call"})
	evs := drain(g)
	if countEvents(evs, EventFlop)+countEvents(evs, EventTurn)+countEvents(evs, EventRiver) != 3 {
		t.Fatalf("收轮应直发三条街,实际 %+v", evs)
	}
	for _, ev := range evs {
		cp, ok := ev.Payload.(*CommunityPayload)
		if !ok {
			continue
		}
		if cp.MinRaise == nil || *cp.MinRaise != 10 {
			t.Fatalf("换街载荷 minRaise 应重置为大盲 10,实际 %+v", cp.MinRaise)
		}
	}
}

package game

import (
	"testing"

	"anitexas/backend/internal/engine"
)

// eqLayers 校验拆池结果与期望逐层一致(金额 + 可赢座位)。
func eqLayers(t *testing.T, got []potLayer, want []potLayer) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("层数 %d != 期望 %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i].Amount != want[i].Amount {
			t.Errorf("第 %d 层金额 %d != 期望 %d", i, got[i].Amount, want[i].Amount)
		}
		if len(got[i].Eligible) != len(want[i].Eligible) {
			t.Fatalf("第 %d 层可赢者 %v != 期望 %v", i, got[i].Eligible, want[i].Eligible)
		}
		for j := range want[i].Eligible {
			if got[i].Eligible[j] != want[i].Eligible[j] {
				t.Errorf("第 %d 层可赢者 %v != 期望 %v", i, got[i].Eligible, want[i].Eligible)
			}
		}
	}
}

// TestSplitPotsTwoLayers 边池两层一例(A3.3):三家投入 100/100/300,
// 主池 300 三家可赢,边池 200 仅深筹码可赢。
func TestSplitPotsTwoLayers(t *testing.T) {
	got := splitPots([]int{100, 100, 300}, []bool{false, false, false})
	eqLayers(t, got, []potLayer{
		{Amount: 300, Eligible: []int{0, 1, 2}},
		{Amount: 200, Eligible: []int{2}},
	})
}

// TestSplitPotsThreeLayers 边池三层一例(A3.3):三家投入 50/100/300。
func TestSplitPotsThreeLayers(t *testing.T) {
	got := splitPots([]int{50, 100, 300}, []bool{false, false, false})
	eqLayers(t, got, []potLayer{
		{Amount: 150, Eligible: []int{0, 1, 2}},
		{Amount: 100, Eligible: []int{1, 2}},
		{Amount: 200, Eligible: []int{2}},
	})
}

// TestSplitPotsFoldedTopMerges 顶层投入者弃牌:该层无可赢者,层额并入上一层。
func TestSplitPotsFoldedTopMerges(t *testing.T) {
	got := splitPots([]int{100, 100, 300}, []bool{false, false, true})
	eqLayers(t, got, []potLayer{
		{Amount: 500, Eligible: []int{0, 1}},
	})
}

// TestDistributeOddChips 奇数余筹给按钮后靠前者(温州惯例,规则书 §7)。
func TestDistributeOddChips(t *testing.T) {
	order := buttonOrder(3, 0) // = [1, 2, 0]:庄家下家起
	got := distribute(7, []int{2, 0}, order)
	if got[2] != 4 || got[0] != 3 {
		t.Fatalf("7 筹均分两赢家:靠前者(座位2)应得 4,座位0 得 3,实际 %v", got)
	}
}

// TestSettleThreeLayerLive 三层边池全链一例(A3.3):三家筹码 100/60/30 逐家全下,
// 短筹码拿最强牌赢主池 90,深筹码赢两层边池 100,中筹码颗粒无收。
func TestSettleThreeLayerLive(t *testing.T) {
	// 牌力:S2 最强(10.0/9.5)> S0(9.0/8.5)> S1(8.0/7.5);公共牌全杂鱼不成组
	holes := map[int][]engine.Card{
		0: {testCard(1, "中0", 9.0, 1921), testCard(2, "中1", 8.5, 1923)},
		1: {testCard(3, "弱0", 8.0, 1927), testCard(4, "弱1", 7.5, 1929)},
		2: {testCard(5, "强0", 10.0, 1931), testCard(6, "强1", 9.5, 1933)},
	}
	board := []engine.Card{
		testCard(7, "公0", 5.0, 1937, engine.Element{Class: engine.ClassTag, Value: "杂A"}),
		testCard(8, "公1", 4.5, 1939, engine.Element{Class: engine.ClassTag, Value: "杂B"}),
		testCard(9, "公2", 4.0, 1941, engine.Element{Class: engine.ClassTag, Value: "杂C"}),
		testCard(10, "公3", 3.5, 1943, engine.Element{Class: engine.ClassTag, Value: "杂D"}),
		testCard(11, "公4", 3.0, 1945, engine.Element{Class: engine.ClassTag, Value: "杂E"}),
	}
	g := newTestGame(t, Config{StartChips: 1000}, 3, riggedDeck(3, 0, holes, board))
	// 座位筹码 100/60/30(直接改内部状态,经表 goroutine 串行执行,无竞态)
	if err := g.call(func() error {
		g.seats[0].chips, g.seats[1].chips, g.seats[2].chips = 100, 60, 30
		return nil
	}); err != nil {
		t.Fatalf("设置筹码: %v", err)
	}
	g.Start()
	drain(g)
	// 三人桌:button=seat0,SB=seat1,BB=seat2;preflop 从 button 后行动 = seat0
	if g.turn != 0 {
		t.Fatalf("三人桌 preflop 应 button 后第一家行动,实际 turn=%d", g.turn)
	}
	mustSubmit(t, g, Action{Seat: 0, Type: "allin"}) // 100
	mustSubmit(t, g, Action{Seat: 1, Type: "allin"}) // 60(短跟全下)
	mustSubmit(t, g, Action{Seat: 2, Type: "allin"}) // 30(短跟全下)

	evs := drain(g)
	settled, ok := findEvent(t, evs, EventSettled).(*SettledPayload)
	if !ok {
		t.Fatal("三家全下应结算")
	}
	// 注池 = 100 + 60 + 30 = 190;主池 90 -> 座位2,边池 60 + 40 -> 座位0
	if settled.PotWins[2] != 90 {
		t.Fatalf("座位2 赢主池 90,实际 %d", settled.PotWins[2])
	}
	if settled.PotWins[0] != 100 {
		t.Fatalf("座位0 赢两层边池 100,实际 %d", settled.PotWins[0])
	}
	if settled.PotWins[1] != 0 {
		t.Fatalf("座位1 应颗粒无收,实际 %d", settled.PotWins[1])
	}
	// 筹码盈亏 = 赢池 - 投入:座位2 +60,座位1 -60,座位0 归零
	want := map[int]int{0: 0, 1: -60, 2: 60}
	for _, row := range settled.Rows {
		if row.ChipsDelta != want[row.Seat] {
			t.Errorf("座位%d 筹码盈亏 %d != 期望 %d", row.Seat, row.ChipsDelta, want[row.Seat])
		}
		if row.Seat != 1 && row.Points.HandScore != TierPointsPerLevel {
			t.Errorf("座位%d 赢池应得牌型积分 %d,实际 %d", row.Seat, TierPointsPerLevel, row.Points.HandScore)
		}
		if row.Seat == 1 && row.Points.HandScore != 0 {
			t.Errorf("座位1 未赢池不应得牌型积分,实际 %d", row.Points.HandScore)
		}
	}
	// 筹码账落账:净盈亏正确之外,余额 = 赢池(全下归零后入账)
	if g.seats[0].chips != 100 || g.seats[1].chips != 0 || g.seats[2].chips != 90 {
		t.Fatalf("落账后筹码 0/1/2 = %d/%d/%d,期望 100/0/90",
			g.seats[0].chips, g.seats[1].chips, g.seats[2].chips)
	}
}

package game

import "anitexas/backend/internal/engine"

// TierPointsPerLevel 是积分账的「每级积分」可配项(v1 数值:赢家 +级数×10;
// §1.4 取舍:积分数值规则随平衡性调,默认 10)。
var TierPointsPerLevel = 10

// showdown 摊牌:未弃牌家的底牌与公共牌全部解密(D2 L3),逐家 Best7,
// 发 showdown 事件后进结算(Showdown -> Settled)。弃牌家底牌永不出局。
func (g *Game) showdown() {
	g.turn = -1
	g.stopTurnTimer()
	if err := g.transition(PhaseShowdown); err != nil {
		g.emitErr(CodeInternal, err.Error())
		return
	}
	// 摊牌解密:此前未揭示的要素此时全桌可见
	for i := range g.seats {
		s := &g.seats[i]
		if g.inHand(s) && !s.folded {
			for _, c := range s.hole {
				g.publicRevealed[c.ID] = true
			}
		}
	}
	for _, c := range g.community {
		g.publicRevealed[c.ID] = true
	}

	// 逐家 Best7(2 底牌 + 5 公共;坐标系即 cards 顺序,groups 同坐标系)
	evals := map[int]engine.HandEval{}
	hands := []ShowdownHand{}
	for i := range g.seats {
		s := &g.seats[i]
		if !g.inHand(s) || s.folded {
			continue
		}
		cards := append(append([]engine.Card(nil), s.hole...), g.community...)
		if len(cards) != 7 {
			continue // 防御:摊牌必有 7 张
		}
		eval, _ := engine.Best7(cards)
		evals[i] = eval
		hands = append(hands, ShowdownHand{
			Seat:     i,
			Cards:    g.cardViews(i, cards),
			Groups:   eval.Groups,
			Tier:     eval.Tier,
			Tiebreak: eval.Tiebreak,
		})
	}
	g.emit(EventShowdown, &ShowdownPayload{Hands: hands})

	if err := g.transition(PhaseSettled); err != nil {
		g.emitErr(CodeInternal, err.Error())
		return
	}
	potWins, rows := g.settlePots(evals)
	g.emit(EventSettled, &SettledPayload{Rows: rows, PotWins: potWins})
}

// settleFoldWin 摊牌前只剩一家未弃牌:即刻结算(Betting -> Settled,不发 showdown,
// 弃牌家底牌不出局)。赢家若已凑满 7 张(river 才弃)仍按 Best7 记牌型积分。
func (g *Game) settleFoldWin() {
	g.turn = -1
	g.stopTurnTimer()
	if err := g.transition(PhaseSettled); err != nil {
		g.emitErr(CodeInternal, err.Error())
		return
	}
	evals := map[int]engine.HandEval{}
	winner := -1
	for i := range g.seats {
		if g.inHand(&g.seats[i]) && !g.seats[i].folded {
			winner = i
		}
	}
	if winner >= 0 {
		cards := append(append([]engine.Card(nil), g.seats[winner].hole...), g.community...)
		if len(cards) == 7 {
			evals[winner], _ = engine.Best7(cards)
		}
	}
	potWins, rows := g.settlePots(evals)
	g.emit(EventSettled, &SettledPayload{Rows: rows, PotWins: potWins})
}

// settlePots 分池结算并落账(筹码/积分两本账,§1.4):
//   - 主/边池按投入封顶拆层(splitPots),每层赢家 = 可赢者中 Compare 最大者;
//   - 筹码盈亏 = 赢池 - 本手投入(赢家自己投入的超额下注随之自动回归);
//   - 积分 v1 数值:赢家 +级数×TierPointsPerLevel,全员 -Σ揭示成本,可配;
//   - 结算行覆盖本手所有拿到牌的座位(含弃牌家)。
//
// evals 缺席的座位(弃牌赢且牌不足 7 张)不计牌型积分。
func (g *Game) settlePots(evals map[int]engine.HandEval) (map[int]int, []SettleRow) {
	committed := make([]int, g.cfg.Seats)
	folded := make([]bool, g.cfg.Seats)
	for i := range g.seats {
		s := &g.seats[i]
		committed[i] = s.committed
		folded[i] = !g.inHand(s) || s.folded
	}
	potWins := map[int]int{}
	for _, layer := range splitPots(committed, folded) {
		winners := g.layerWinners(layer, evals)
		got := distribute(layer.Amount, winners, buttonOrder(g.cfg.Seats, g.button))
		for seat, amt := range got {
			potWins[seat] += amt
			g.seats[seat].chips += amt
		}
	}

	// 结算行 + 积分账(牌型积分只给赢池者;揭示成本全员照扣)
	order := make([]int, 0, len(g.dealt))
	for _, seat := range g.dealt {
		order = append(order, seat)
	}
	sortInts(order)
	rows := make([]SettleRow, 0, len(order))
	for _, seat := range order {
		s := &g.seats[seat]
		handScore := 0
		if potWins[seat] > 0 {
			if eval, ok := evals[seat]; ok {
				handScore = eval.Tier * TierPointsPerLevel
			}
		}
		row := SettleRow{
			Seat:       seat,
			ChipsDelta: potWins[seat] - s.committed,
			Points: SettlePoints{
				HandScore:  handScore,
				BondBonus:  0, // v1 无羁绊加成(§1.4 结构先立,规则后配)
				RevealCost: s.revealCost,
			},
		}
		s.points += handScore + row.Points.BondBonus - s.revealCost
		rows = append(rows, row)
	}

	// 清本轮注与本手投入(注池已分完;底牌/弃牌态保留到下一手重置)
	for i := range g.seats {
		s := &g.seats[i]
		s.bet, s.committed = 0, 0
	}
	g.pot, g.currentBet, g.minRaise = 0, 0, g.cfg.BigBlind
	g.pending = map[int]bool{}
	return potWins, rows
}

// layerWinners 返回一层的赢家:可赢者中 Best7/Compare 最大者(全序无平局,
// engine.Compare 永不 0;同牌集自比除外)。仅一家可赢时直接判,不依赖 eval。
func (g *Game) layerWinners(layer potLayer, evals map[int]engine.HandEval) []int {
	if len(layer.Eligible) == 0 {
		return nil
	}
	if len(layer.Eligible) == 1 {
		return append([]int(nil), layer.Eligible...)
	}
	winners := []int{}
	var best engine.HandEval
	first := true
	for _, seat := range layer.Eligible {
		eval, ok := evals[seat]
		if !ok {
			continue // 防御:多人可赢必有 eval(摊牌场景)
		}
		if first {
			winners, best, first = []int{seat}, eval, false
			continue
		}
		switch engine.Compare(eval, best) {
		case 1:
			winners, best = []int{seat}, eval
		case 0:
			winners = append(winners, seat) // 理论不可达:同牌集才平局
		}
	}
	return winners
}

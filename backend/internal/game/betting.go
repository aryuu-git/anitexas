package game

import (
	"fmt"
	"strings"

	"anitexas/backend/internal/engine"
)

// streetOrder 是下注街推进顺序(preflop->flop->turn->river)。
var streetOrder = []string{StreetPreflop, StreetFlop, StreetTurn, StreetRiver}

// streetAfter 返回下一条下注街;river 已是最后一条,返回 false(该摊牌了)。
func streetAfter(st string) (string, bool) {
	for i, s := range streetOrder {
		if s == st && i+1 < len(streetOrder) {
			return streetOrder[i+1], true
		}
	}
	return "", false
}

// actionErr 构造带回执 code 的同步错误(与 ServerRuntime 的 error 事件约定)。
func actionErr(code, msg string) error {
	return fmt.Errorf("%s: %s", code, msg)
}

// errorCodeOf 从同步错误中取回执 code(错误消息以 code 起头)。
func errorCodeOf(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	if i := strings.Index(msg, ":"); i > 0 {
		return msg[:i]
	}
	return CodeInternal
}

// inHand 判断是否参与本手(在局且已发底牌)。
func (g *Game) inHand(s *seatState) bool {
	return s.inPlay && len(s.hole) > 0
}

// canAct 判断当前是否可行动(在手、未弃牌、未全下)。
func (g *Game) canAct(s *seatState) bool {
	return g.inHand(s) && !s.folded && !s.allIn
}

// nonFoldedCount 统计未弃牌人数(=1 即弃牌赢,摊牌前弃牌即刻结算)。
func (g *Game) nonFoldedCount() int {
	n := 0
	for i := range g.seats {
		s := &g.seats[i]
		if g.inHand(s) && !s.folded {
			n++
		}
	}
	return n
}

// actionableCount 统计仍可行动的人数(<=1 且本轮结束后即全下扎堆,直发公共牌)。
func (g *Game) actionableCount() int {
	n := 0
	for i := range g.seats {
		s := &g.seats[i]
		if g.canAct(s) {
			n++
		}
	}
	return n
}

// applyAction 应用一次下注动作并在同一条命令内推进对局(表 goroutine,持 g.mu)。
// 金额非法(超额/负数/目标不合法)/非轮到者/阶段不对 -> 同步回 error,状态不推进。
//
// Amount 语义:bet/raise 为「加到」本轮总投入的目标值;call/check/fold/allin 忽略。
// 短全下加注不重开已行动者(只能跟/弃,canRaise=false);满额加注重开全桌。
func (g *Game) applyAction(a Action) error {
	if g.state != PhaseBetting {
		return actionErr(CodeBadState, "当前阶段不可下注")
	}
	if a.Seat < 0 || a.Seat >= g.cfg.Seats {
		return actionErr(CodeBadSeat, "座位号非法")
	}
	s := &g.seats[a.Seat]
	if !s.inPlay {
		return actionErr(CodeNotInPlay, "未入座")
	}
	if !g.inHand(s) {
		return actionErr(CodeNotInPlay, "未参与本手")
	}
	if s.folded {
		return actionErr(CodeNotInPlay, "已弃牌")
	}
	if s.allIn {
		return actionErr(CodeNotInPlay, "已全下,无可投入")
	}
	if a.Seat != g.turn {
		return actionErr(CodeNotYourTurn, "非轮到者")
	}
	if a.Amount < 0 {
		return actionErr(CodeBadAmount, "金额不能为负")
	}

	added := 0
	target := 0
	switch a.Type {
	case "check":
		if s.bet != g.currentBet {
			return actionErr(CodeCheckFacingBet, "本轮有注,不能过牌")
		}
	case "fold":
		s.folded = true
	case "call":
		need := g.currentBet - s.bet
		if need <= 0 {
			return actionErr(CodeNoBet, "无注可跟")
		}
		if need > s.chips {
			return actionErr(CodeChipOverbet, "筹码不足,请用 allin")
		}
		added = need
	case "bet", "raise":
		if a.Type == "bet" && g.currentBet != 0 {
			return actionErr(CodeBadAction, "已有注,请用 raise")
		}
		if a.Type == "raise" {
			if g.currentBet == 0 {
				return actionErr(CodeNoBet, "无注可加,请用 bet")
			}
			if !s.canRaise {
				return actionErr(CodeMinRaise, "短全下加注后本轮不可再加注,只能跟/弃")
			}
		}
		target = a.Amount
		added = target - s.bet
		if added <= 0 {
			return actionErr(CodeBadAmount, "目标必须高于本轮已投入")
		}
		if added > s.chips {
			return actionErr(CodeChipOverbet, "超额下注(超出自身筹码)")
		}
		if added < s.chips {
			// 非全下必须满足最小下注/最小加注;短全下不受此限
			if a.Type == "bet" && target < g.cfg.BigBlind {
				return actionErr(CodeMinBet, "下注低于大盲")
			}
			if a.Type == "raise" && target < g.currentBet+g.minRaise {
				return actionErr(CodeMinRaise, "加注低于最小加注")
			}
		}
	case "allin":
		added = s.chips
		if added <= 0 {
			return actionErr(CodeChipOverbet, "已全下,无可投入")
		}
		target = s.bet + added
		// 全下同样受「短全下不重开加注」约束：超过当前注即视为加注。
		if target > g.currentBet && !s.canRaise {
			return actionErr(CodeMinRaise, "短全下后本轮不可再加注,只能跟/弃")
		}
	default:
		return actionErr(CodeBadAction, "未知动作类型")
	}

	// 动作生效:投入进池
	oldBet := g.currentBet
	if added > 0 {
		s.chips -= added
		s.bet += added
		s.committed += added
		g.pot += added
		if s.chips == 0 {
			s.allIn = true
		}
	}
	s.acted = true
	delete(g.pending, a.Seat)

	// 开注/加注(目标高于原最高注):更新最高注与最小加注增量
	if s.bet > oldBet {
		g.currentBet = s.bet
		inc := g.currentBet - oldBet
		full := inc >= g.minRaise
		if full {
			g.minRaise = inc
		}
		// 满额加注重开全桌行动;短全下加注只重开已行动者(且不可再加注)
		for i := range g.seats {
			o := &g.seats[i]
			if i == a.Seat || !g.canAct(o) {
				continue
			}
			if o.bet < g.currentBet && (full || o.acted) {
				g.pending[i] = true
				o.canRaise = full
				o.acted = false
			}
		}
	}

	// 事件保序:先回放动作(载荷指针稍后补最终倒计时/最小加注增量),再发推进产生的事件
	acted := &ActedPayload{Seat: a.Seat, Type: a.Type, Amount: added}
	g.emit(EventActed, acted)
	g.resolveAfterAction()
	acted.TurnSeat = g.turnPtr()
	acted.Deadline = g.deadlinePtr()
	acted.MinRaise = g.minRaisePtr()
	return nil
}

// resolveAfterAction 动作生效后的推进:弃牌赢即刻结算 / 本轮结束推进街 / 轮转。
// 只能在表 goroutine 内调用(调用方持 g.mu)。
func (g *Game) resolveAfterAction() {
	if g.nonFoldedCount() <= 1 {
		g.settleFoldWin()
		return
	}
	if len(g.pending) > 0 {
		g.turn = g.nextPending(g.turn)
		g.startTurnTimer()
		return
	}
	// 本轮结束:可行动者 <=1(其余全下)则不再开下注轮,直发剩余公共牌进摊牌
	if g.actionableCount() <= 1 {
		g.runout()
		return
	}
	g.advanceStreet()
}

// advanceStreet 推进到下一条下注街(转移表 Betting->Betting 街推进);
// river 下注结束后进摊牌。
func (g *Game) advanceStreet() {
	next, ok := streetAfter(g.street)
	if !ok {
		g.showdown()
		return
	}
	g.flipStreet(next, true)
}

// flipStreet 亮出一条街的公共牌并重置本轮下注(withBetting=false 表示全下扎堆
// 的直发街:无下注轮、无行动者)。
func (g *Game) flipStreet(next string, withBetting bool) {
	if err := g.transition(PhaseBetting); err != nil { // 街推进走显式转移表
		g.emitErr(CodeInternal, err.Error())
		return
	}
	g.street = next
	var newCards []engine.Card
	switch next {
	case StreetFlop:
		newCards = g.board[0:3]
	case StreetTurn:
		newCards = g.board[3:4]
	default: // StreetRiver
		newCards = g.board[4:5]
	}
	g.community = append(g.community, newCards...)

	// 重置本轮下注状态
	for i := range g.seats {
		s := &g.seats[i]
		s.bet, s.acted, s.canRaise = 0, false, true
	}
	g.currentBet, g.minRaise = 0, g.cfg.BigBlind
	g.pending = map[int]bool{}
	for i := range g.seats {
		if g.canAct(&g.seats[i]) {
			g.pending[i] = true
		}
	}
	g.turn = -1
	g.stopTurnTimer()
	typ := EventFlop
	switch next {
	case StreetTurn:
		typ = EventTurn
	case StreetRiver:
		typ = EventRiver
	}
	if withBetting {
		g.turn = g.nextPending(g.button)
		g.startTurnTimer()
	}
	// 公共牌只随街亮出 L1;L2 要素仍需揭示(D2/D7),故用 viewer=-1 构造;
	// minRaise 为换街重置后的服务端权威增量
	g.emit(typ, &CommunityPayload{
		Cards:    g.cardViews(-1, newCards),
		TurnSeat: g.turnPtr(),
		Deadline: g.deadlinePtr(),
		MinRaise: g.minRaisePtr(),
	})
}

// runout 全下扎堆:跳过剩余下注轮,直接发完剩余公共牌(无行动者)进摊牌。
func (g *Game) runout() {
	g.turn = -1
	g.runoutFlag = true
	g.stopTurnTimer()
	for {
		next, ok := streetAfter(g.street)
		if !ok {
			break
		}
		g.flipStreet(next, false)
	}
	g.showdown()
}

package game

import "fmt"

// 对局阶段:手牌生命周期 Waiting -> Dealing -> Betting(preflop/flop/turn/river)
// -> Showdown -> Settled(architecture.md §4.2)。非法转移报错、状态不变。
const (
	PhaseWaiting  = "waiting"  // 等待开局
	PhaseDealing  = "dealing"  // 发牌期(底牌/公共牌发放中)
	PhaseBetting  = "betting"  // 下注期(按街推进:preflop/flop/turn/river)
	PhaseShowdown = "showdown" // 摊牌
	PhaseSettled  = "settled"  // 结算完毕,可重新开局
)

// betting 阶段内的下注街(与 wire Phase 枚举同名,Snapshot.phase 直接取用)。
const (
	StreetPreflop = "preflop"
	StreetFlop    = "flop"
	StreetTurn    = "turn"
	StreetRiver   = "river"
)

// transitionTable 是显式转移表(from -> 允许的 to 集合),状态机唯一真源。
//   - Betting->Betting:街推进(preflop->flop->turn->river),由 advanceStreet 保证单调。
//   - Betting->Settled:摊牌前全员弃牌即刻结算(规则书 §5)。
//   - Settled->Dealing:一手牌结束后直接重开下一手;Settled->Waiting:清桌回等待。
var transitionTable = map[string][]string{
	PhaseWaiting:  {PhaseDealing},
	PhaseDealing:  {PhaseBetting},
	PhaseBetting:  {PhaseBetting, PhaseShowdown, PhaseSettled},
	PhaseShowdown: {PhaseSettled},
	PhaseSettled:  {PhaseWaiting, PhaseDealing},
}

// canTransition 判断阶段转移是否合法(纯函数,表驱动)。
func canTransition(from, to string) bool {
	for _, next := range transitionTable[from] {
		if next == to {
			return true
		}
	}
	return false
}

// transition 校验并推进阶段;非法转移返回 error 且状态不变(§4.2)。
// 只能在表 goroutine 内调用(调用方持 g.mu)。
func (g *Game) transition(to string) error {
	if !canTransition(g.state, to) {
		return fmt.Errorf("非法状态转移: %s -> %s", g.state, to)
	}
	g.state = to
	return nil
}

// Phase 返回对局回合枚举(Snapshot.phase;waiting|preflop|flop|turn|river|
// showdown|settled)。发牌期对外并入 preflop;Betting 取当前街名。
func (g *Game) Phase() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.phaseLocked()
}

// phaseLocked 是 Phase 的持锁版本(表 goroutine 内用)。
func (g *Game) phaseLocked() string {
	switch g.state {
	case PhaseWaiting:
		return "waiting"
	case PhaseDealing:
		return StreetPreflop
	case PhaseShowdown:
		return "showdown"
	case PhaseSettled:
		return "settled"
	default: // PhaseBetting
		return g.street
	}
}

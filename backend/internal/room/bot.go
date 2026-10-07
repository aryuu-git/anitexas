package room

import (
	"anitexas/backend/internal/model"
)

// BotParams 是 bot 启发式参数（§4.3 bot.go：不做 GTO，先保证合法与流畅；参数可配，D 记录见 rules 风险表「bot 太弱/太强」）。
type BotParams struct {
	// DelayMs 是 bot 思考延迟（模拟出牌节奏，须远小于 TurnTimeoutMs）。
	DelayMs int
	// CallThreshold 是跟注强度阈值（0–1）：低于它面对下注即弃。
	CallThreshold float64
	// RaiseThreshold 是加注/下注强度阈值（0–1）。
	RaiseThreshold float64
	// MaxCallRatio 是单次跟注占自身筹码的上限比例，超过则弃（除非极强）。
	MaxCallRatio float64
	// MaxRaises 是每条街每个 bot 面对下注的再加注次数上限：强牌也只再加注这么多次，
	// 超出后降级为跟注/全下/弃牌决策。防两强 bot 互 min-raise 拉锯导致下注轮事实不收敛
	//（筹码极深时一手牌可打上千个动作）。0 = 不限（测试可放开）。
	MaxRaises int
}

// DefaultBotParams 返回 v1 默认启发式参数。
func DefaultBotParams() BotParams {
	return BotParams{
		DelayMs:        800,
		CallThreshold:  0.35,
		RaiseThreshold: 0.72,
		MaxCallRatio:   0.25,
		MaxRaises:      1,
	}
}

// botNames 是 bot 昵称池（按座位轮取）。
var botNames = []string{"墨镜", "樱", "老K", "小满", "阿紫", "竹取", "铃", "遥"}

// BotNick 生成某座位 bot 的昵称。
func BotNick(seat int) string {
	return "bot·" + botNames[seat%len(botNames)]
}

// botStrength 估算 bot 手牌强度（0–1）：档位分为主，已揭示要素的羁绊潜力加成。
// 输入快照为该 bot 视角（未揭示牌无 elements，D7——bot 与人同权，只用已知信息）。
func botStrength(s model.SnapshotPayload, seat int) float64 {
	if len(s.MyCards) == 0 {
		return 0.3 // 没看清牌按中下处理
	}
	// 档位分（0.5–10）归一到 0–1。
	sum := 0.0
	for _, c := range s.MyCards {
		sum += c.Bucket
	}
	strength := sum / (10 * float64(len(s.MyCards)))

	// 自己手牌之间的同要素羁绊（对子/成组潜力）。
	if len(s.MyCards) >= 2 {
		first := map[model.Element]bool{}
		for _, e := range s.MyCards[0].Elements {
			first[e] = true
		}
		for _, c := range s.MyCards[1:] {
			for _, e := range c.Elements {
				if first[e] {
					strength += 0.12
					break
				}
			}
		}
	}

	// 与已揭示公共牌的要素呼应（凑羁绊的公开线索）。
	match := 0.0
	seen := map[model.Element]bool{}
	for _, c := range s.MyCards {
		for _, e := range c.Elements {
			seen[e] = true
		}
	}
	for _, c := range s.Community {
		for _, e := range c.Elements {
			if seen[e] {
				match += 0.05
			}
		}
	}
	strength += minFloat(match, 0.2)

	return clampFloat(strength, 0, 1)
}

// botAction 决定 bot 的一个动作。返回 false 表示不该行动（非本座位行动/已结束）。
// 动作只从合法集合里挑，金额按上行语义（bet/raise 的 amount = 「加到」本轮总投入目标）；
// 真正合法性由 game.Submit 把关，调用方对失败动作走回退链（见 room.botAct），
// 保证 bot 永远以合法动作收尾（A3.4）。
// raisedThisStreet 是本 bot 本条街已做出的面对下注再加注次数（调用方计数），
// 超过 p.MaxRaises 后不再加注，防 min-raise 拉锯不收敛。
func botAction(s model.SnapshotPayload, seat int, p BotParams, raisedThisStreet int) (model.ActionPayload, bool) {
	if s.TurnSeat != seat {
		return model.ActionPayload{}, false
	}
	switch s.Phase {
	case model.PhasePreflop, model.PhaseFlop, model.PhaseTurn, model.PhaseRiver:
	default:
		return model.ActionPayload{}, false // 不在下注轮
	}
	me := s.Seats[seat]
	toCall := s.CurrentBet - me.Bet
	strength := botStrength(s, seat)

	if toCall <= 0 {
		// 无注：强则下注，弱则过牌。
		if strength >= p.RaiseThreshold && me.Chips > 2*s.BigBlind {
			return model.ActionPayload{Type: model.ActBet, Amount: s.CurrentBet + 2*s.BigBlind}, true
		}
		return model.ActionPayload{Type: model.ActCheck}, true
	}

	// 面对下注。
	if toCall >= me.Chips {
		// 跟不动：够强全下，否则弃。
		if strength >= p.CallThreshold {
			return model.ActionPayload{Type: model.ActAllin}, true
		}
		return model.ActionPayload{Type: model.ActFold}, true
	}
	if toCall > int(p.MaxCallRatio*float64(me.Chips)) && strength < p.RaiseThreshold {
		return model.ActionPayload{Type: model.ActFold}, true
	}
	// 再加注封顶：超出 MaxRaises 后强牌也只跟注（防 min-raise 拉锯不收敛）。
	if strength >= p.RaiseThreshold && me.Chips > 2*toCall && (p.MaxRaises <= 0 || raisedThisStreet < p.MaxRaises) {
		target := s.CurrentBet + maxInt(s.BigBlind, toCall)
		if target >= me.Bet+me.Chips {
			return model.ActionPayload{Type: model.ActAllin}, true
		}
		return model.ActionPayload{Type: model.ActRaise, Amount: target}, true
	}
	return model.ActionPayload{Type: model.ActCall}, true
}

// botFallback 是 Submit 失败后的回退链：跟注 -> 全下 -> 过牌/弃牌，
// 保证最终一定发出合法动作（A3.4「永不发非法动作」的兜底）。
func botFallback(s model.SnapshotPayload, seat int) []model.ActionPayload {
	me := s.Seats[seat]
	toCall := s.CurrentBet - me.Bet
	if toCall <= 0 {
		return []model.ActionPayload{{Type: model.ActCheck}}
	}
	return []model.ActionPayload{
		{Type: model.ActCall},
		{Type: model.ActAllin},
		{Type: model.ActFold},
	}
}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func clampFloat(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

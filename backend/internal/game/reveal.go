package game

import (
	"anitexas/backend/internal/engine"
)

// locateCard 在本手的牌里定位一张牌:
// 自己/对手底牌返回 owner 座位号与牌指针;已翻公共牌返回 owner=-1、community=true;
// 未翻公共牌与非本手的牌一律返回 nil。
func (g *Game) locateCard(cardID int64) (owner int, card *engine.Card, community bool) {
	for i := range g.seats {
		s := &g.seats[i]
		if !g.inHand(s) {
			continue
		}
		for j := range s.hole {
			if s.hole[j].ID == cardID {
				return i, &s.hole[j], false
			}
		}
	}
	for i := range g.community {
		if g.community[i].ID == cardID {
			return -1, &g.community[i], true
		}
	}
	return -1, nil, false
}

// applyReveal 校验并应用一次揭示(§1.3,表 goroutine,持 g.mu):
//   - 时机:下注轮内随时(仅 Betting 阶段);
//   - 自己底牌:scope=private 私看(默认)或 public 当众亮牌(D15);
//   - 公共牌:只能 public(当众亮);对手底牌:一律拒绝(D2);
//   - 不可逆:已公开揭示重复请求为幂等 no-op(不重复记账、不发事件);
//   - 成本 = cfg.RevealFee(v1 恒 0,账照记,§1.3/D4),累计进本手揭示成本。
//
// 返回本次记账成本(v1 恒 0)与错误;错误同步回执不推进状态。
func (g *Game) applyReveal(r RevealReq) (int, error) {
	if g.state != PhaseBetting {
		return 0, actionErr(CodeBadState, "只能在下注轮内揭示")
	}
	if r.Seat < 0 || r.Seat >= g.cfg.Seats {
		return 0, actionErr(CodeBadSeat, "座位号非法")
	}
	s := &g.seats[r.Seat]
	if !s.inPlay {
		return 0, actionErr(CodeNotInPlay, "未入座")
	}
	if !g.inHand(s) || s.folded {
		return 0, actionErr(CodeNotInPlay, "未参与本手")
	}
	if r.Scope != "private" && r.Scope != "public" {
		return 0, actionErr(CodeBadScope, "可见范围只能 private/public")
	}
	owner, card, community := g.locateCard(r.CardID)
	if card == nil {
		return 0, actionErr(CodeBadCard, "非本手的牌或尚未亮出")
	}
	if owner >= 0 && owner != r.Seat {
		return 0, actionErr(CodeNotYourCard, "对手底牌不可揭示")
	}
	if community && r.Scope != "public" {
		return 0, actionErr(CodeBadScope, "公共牌只能 public")
	}
	// 不可逆(D3):已公开 -> 幂等 no-op;已私看 -> 重复私看幂等 no-op
	if g.publicRevealed[r.CardID] {
		return 0, nil
	}
	if r.Scope == "private" && g.revPrivate[r.CardID][r.Seat] {
		return 0, nil
	}
	// 初始可见性登记:private 仅本人;public 全桌(自己底牌 public = 当众亮牌,D15)
	if r.Scope == "public" {
		g.publicRevealed[r.CardID] = true
		g.revPrivate[r.CardID] = nil
	} else {
		if g.revPrivate[r.CardID] == nil {
			g.revPrivate[r.CardID] = map[int]bool{}
		}
		g.revPrivate[r.CardID][r.Seat] = true
	}
	// 记账:成本照记(预留扣分能力,D4)
	cost := g.cfg.RevealFee
	s.revealCost += cost
	g.reveals = append(g.reveals, RevealRecord{
		Seat: r.Seat, CardID: r.CardID, Scope: r.Scope, Cost: cost,
	})
	g.emit(EventRevealed, &RevealedPayload{
		Seat: r.Seat, CardID: r.CardID, Scope: r.Scope, Cost: cost,
		Elements: wireElements(card.Elements),
	})
	return cost, nil
}

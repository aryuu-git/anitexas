package game

import (
	"testing"

	"anitexas/backend/internal/engine"
)

// revealedEvents 提取事件流里的 revealed 载荷。
func revealedEvents(evs []Event) []*RevealedPayload {
	out := []*RevealedPayload{}
	for _, ev := range evs {
		if p, ok := ev.Payload.(*RevealedPayload); ok {
			out = append(out, p)
		}
	}
	return out
}

// TestRevealValidation 揭示校验(§1.3/A4.5):时机、归属、范围、幂等逐条断言。
func TestRevealValidation(t *testing.T) {
	holes := map[int][]engine.Card{
		0: {testCard(1, "甲", 8.0, 2001, engine.Element{Class: engine.ClassDirector, Value: "导A"}),
			testCard(2, "乙", 7.5, 2002, engine.Element{Class: engine.ClassDirector, Value: "导B"}),
		},
		1: {testCard(3, "丙", 7.0, 2003, engine.Element{Class: engine.ClassStudio, Value: "社B"}),
			testCard(4, "丁", 6.5, 2004)},
	}
	board := []engine.Card{
		testCard(5, "公0", 5.0, 2005, engine.Element{Class: engine.ClassTag, Value: "杂A"}),
		dudCard(6), dudCard(7), dudCard(8), dudCard(9),
	}
	g := newTestGame(t, Config{}, 2, riggedDeck(2, 0, holes, board))

	// 开局前揭示:时机不对
	if _, err := g.Reveal(RevealReq{Seat: 0, CardID: 1, Scope: "private"}); errorCodeOf(err) != CodeBadState {
		t.Fatalf("开局前揭示应 bad_state,实际 %v", err)
	}
	g.Start()
	drain(g)

	// 对手底牌一律拒绝(D2)
	if _, err := g.Reveal(RevealReq{Seat: 0, CardID: 3, Scope: "public"}); errorCodeOf(err) != CodeNotYourCard {
		t.Fatalf("揭示对手底牌应 not_your_card,实际 %v", err)
	}
	// 未亮出的公共牌不可揭示
	if _, err := g.Reveal(RevealReq{Seat: 0, CardID: 6, Scope: "public"}); errorCodeOf(err) != CodeBadCard {
		t.Fatalf("揭示未翻公共牌应 bad_card,实际 %v", err)
	}
	// 非本手的牌
	if _, err := g.Reveal(RevealReq{Seat: 0, CardID: 999, Scope: "private"}); errorCodeOf(err) != CodeBadCard {
		t.Fatalf("揭示未知牌应 bad_card,实际 %v", err)
	}
	// 范围非法
	if _, err := g.Reveal(RevealReq{Seat: 0, CardID: 1, Scope: "friends"}); errorCodeOf(err) != CodeBadScope {
		t.Fatalf("非法范围应 bad_scope,实际 %v", err)
	}
	// 自己底牌私看(默认)
	cost, err := g.Reveal(RevealReq{Seat: 0, CardID: 1, Scope: "private"})
	if err != nil || cost != 0 {
		t.Fatalf("私看自己底牌应成功且成本 0,实际 cost=%d err=%v", cost, err)
	}
	// 不可逆:重复私看幂等 no-op(不重复记账、不发事件)
	if cost, err := g.Reveal(RevealReq{Seat: 0, CardID: 1, Scope: "private"}); err != nil || cost != 0 {
		t.Fatalf("重复私看应幂等 no-op,实际 cost=%d err=%v", cost, err)
	}
	if n := countEvents(drain(g), EventRevealed); n != 1 {
		t.Fatalf("两次私看应只发 1 条 revealed,实际 %d", n)
	}

	// D15:自己底牌 public = 当众亮牌,事件照发 scope=public
	cost, err = g.Reveal(RevealReq{Seat: 0, CardID: 2, Scope: "public"})
	if err != nil || cost != 0 {
		t.Fatalf("当众亮自己底牌应成功且成本 0,实际 cost=%d err=%v", cost, err)
	}
	evs := drain(g)
	pubs := revealedEvents(evs)
	if len(pubs) != 1 || pubs[0].Scope != "public" || pubs[0].CardID != 2 {
		t.Fatalf("当众亮牌应发 revealed{scope:public},实际 %+v", pubs)
	}
	if len(pubs[0].Elements) == 0 {
		t.Fatal("revealed 载荷应携带揭示出的要素")
	}

	// 进 flop:公共牌只能 public;公开揭示成功后幂等
	mustSubmit(t, g, Action{Seat: 0, Type: "call"})
	mustSubmit(t, g, Action{Seat: 1, Type: "check"})
	drain(g)
	if _, err := g.Reveal(RevealReq{Seat: 1, CardID: 5, Scope: "private"}); errorCodeOf(err) != CodeBadScope {
		t.Fatalf("公共牌私看应 bad_scope,实际 %v", err)
	}
	cost, err = g.Reveal(RevealReq{Seat: 1, CardID: 5, Scope: "public"})
	if err != nil || cost != 0 {
		t.Fatalf("公共牌 public 揭示应成功,实际 cost=%d err=%v", cost, err)
	}
	if _, err := g.Reveal(RevealReq{Seat: 1, CardID: 5, Scope: "public"}); err != nil {
		t.Fatalf("重复公开揭示应幂等: %v", err)
	}
	if n := countEvents(drain(g), EventRevealed); n != 1 {
		t.Fatalf("重复公开揭示应只发 1 条 revealed,实际 %d", n)
	}
}

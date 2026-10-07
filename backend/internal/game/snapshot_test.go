package game

import (
	"encoding/json"
	"strings"
	"testing"

	"anitexas/backend/internal/engine"
)

// TestHiddenFieldsNotSerialized 隐藏字段 JSON 断言(A4.8/D7):未揭示牌序列化后
// 无 elements 字段;私看仅本人可见;对手底牌永不出现在任何序列化结果。
func TestHiddenFieldsNotSerialized(t *testing.T) {
	holes := map[int][]engine.Card{
		0: {testCard(1, "甲", 8.0, 2001, engine.Element{Class: engine.ClassDirector, Value: "导A"}),
			testCard(2, "乙", 7.5, 2002)},
		1: {testCard(3, "丙", 7.0, 2003, engine.Element{Class: engine.ClassStudio, Value: "社B"}),
			testCard(4, "丁", 6.5, 2004)},
	}
	board := []engine.Card{
		testCard(5, "公0", 5.0, 2005, engine.Element{Class: engine.ClassTag, Value: "杂A"}),
		dudCard(6), dudCard(7), dudCard(8), dudCard(9),
	}
	g := newTestGame(t, Config{}, 2, riggedDeck(2, 0, holes, board))
	g.Start()
	drain(g)

	// 未揭示:自己的底牌序列化无 elements 字段;对手底牌整卡不出现
	s0 := marshalJSON(t, g.SnapshotFor(0))
	if strings.Contains(s0, `"elements"`) {
		t.Fatalf("未揭示牌不得出现 elements 字段: %s", s0)
	}
	if strings.Contains(s0, "丙") || strings.Contains(s0, "社B") {
		t.Fatalf("对手底牌不得出现在任何序列化结果: %s", s0)
	}

	// 私看自己底牌:本人快照出现要素(线上小写键),他人快照仍无泄露
	if _, err := g.Reveal(RevealReq{Seat: 0, CardID: 1, Scope: "private"}); err != nil {
		t.Fatalf("私看: %v", err)
	}
	drain(g)
	s0 = marshalJSON(t, g.SnapshotFor(0))
	if !strings.Contains(s0, `"elements":[{"class":1,"value":"导A"}]`) {
		t.Fatalf("私看后本人快照应含要素(小写键): %s", s0)
	}
	s1 := marshalJSON(t, g.SnapshotFor(1))
	if strings.Contains(s1, "导A") || strings.Contains(s1, `"cardId":1`) {
		t.Fatalf("私看记录/要素不得进他人快照(D7): %s", s1)
	}

	// 翻牌:公共牌未揭示同样无 elements;public 揭示后全桌可见(含 revealed 记录)
	mustSubmit(t, g, Action{Seat: 0, Type: "call"})
	mustSubmit(t, g, Action{Seat: 1, Type: "check"})
	drain(g)
	for _, cv := range g.SnapshotFor(0).Community {
		s := marshalJSON(t, cv)
		if strings.Contains(s, `"elements"`) {
			t.Fatalf("未揭示公共牌不得出现 elements: %s", s)
		}
	}
	if _, err := g.Reveal(RevealReq{Seat: 1, CardID: 5, Scope: "public"}); err != nil {
		t.Fatalf("揭示公共牌: %v", err)
	}
	drain(g)
	s0 = marshalJSON(t, g.SnapshotFor(0))
	s1 = marshalJSON(t, g.SnapshotFor(1))
	for _, s := range []string{s0, s1} {
		if !strings.Contains(s, "杂A") || !strings.Contains(s, `"cardId":5`) {
			t.Fatalf("public 揭示后全桌应见要素与记录: %s", s)
		}
	}
}

// TestAutoRevealInitialState D14:AutoReveal=true 开局即见全部要素
// (只是初始可见性状态,揭示机制本身不变)。
func TestAutoRevealInitialState(t *testing.T) {
	holes := map[int][]engine.Card{
		0: {testCard(1, "甲", 8.0, 2001, engine.Element{Class: engine.ClassDirector, Value: "导A"}),
			testCard(2, "乙", 7.5, 2002)},
		1: {testCard(3, "丙", 7.0, 2003, engine.Element{Class: engine.ClassStudio, Value: "社B"}),
			testCard(4, "丁", 6.5, 2004)},
	}
	board := []engine.Card{
		testCard(5, "公0", 5.0, 2005, engine.Element{Class: engine.ClassTag, Value: "杂A"}),
		dudCard(6), dudCard(7), dudCard(8), dudCard(9),
	}
	g := newTestGame(t, Config{AutoReveal: true}, 2, riggedDeck(2, 0, holes, board))
	g.Start()
	drain(g)

	snap := g.SnapshotFor(0)
	if !snap.AutoReveal {
		t.Fatal("快照 autoReveal 应为 true")
	}
	s0 := marshalJSON(t, snap)
	if !strings.Contains(s0, "导A") {
		t.Fatalf("AutoReveal 桌开局即应见自己底牌要素: %s", s0)
	}
	mustSubmit(t, g, Action{Seat: 0, Type: "call"})
	mustSubmit(t, g, Action{Seat: 1, Type: "check"})
	s0 = marshalJSON(t, g.SnapshotFor(0))
	if !strings.Contains(s0, "杂A") {
		t.Fatalf("AutoReveal 桌公共牌亮出即应带要素: %s", s0)
	}
}

// TestBoxListOmitsHiddenFields 盒名单访问器(D17 公开名单):只含 id/title/score/
// bucket/year 五个公开字段,绝不携带 elements 等隐藏要素(D7);返回副本防内部改写。
func TestBoxListOmitsHiddenFields(t *testing.T) {
	deck := []engine.Card{
		testCard(1, "甲", 8.0, 2001, engine.Element{Class: engine.ClassDirector, Value: "导A"}),
		testCard(2, "乙", 7.5, 2002),
		dudCard(3),
	}
	g := newTestGame(t, Config{}, 2, deck)
	box := g.Box()
	if len(box) != len(deck) {
		t.Fatalf("盒名单应含全部 %d 张,实得 %d", len(deck), len(box))
	}
	if box[0].ID != 1 || box[0].Title != "甲" || box[0].Score != 8.0 ||
		box[0].Bucket != 8.0 || box[0].Year != 2001 {
		t.Fatalf("盒名单公开字段取值错误: %+v", box[0])
	}

	// JSON 键集恰好 {id,title,score,bucket,year},无 elements/隐藏要素值泄露
	raw := marshalJSON(t, box)
	if strings.Contains(raw, `"elements"`) || strings.Contains(raw, "导A") {
		t.Fatalf("盒名单不得携带隐藏要素(D7): %s", raw)
	}
	var arr []map[string]any
	if err := json.Unmarshal([]byte(raw), &arr); err != nil {
		t.Fatalf("盒名单解析: %v", err)
	}
	wantKeys := map[string]bool{"id": true, "title": true, "score": true, "bucket": true, "year": true}
	for i, m := range arr {
		for k := range m {
			if !wantKeys[k] {
				t.Fatalf("盒名单第 %d 张出现计划外字段 %q: %s", i, k, raw)
			}
		}
		for k := range wantKeys {
			if _, ok := m[k]; !ok {
				t.Fatalf("盒名单第 %d 张缺公开字段 %q: %s", i, k, raw)
			}
		}
	}

	// 返回副本:改写返回值不影响内部
	box[0].Title = "改写"
	if got := g.Box()[0].Title; got != "甲" {
		t.Fatalf("Box() 应返回副本,内部被改写: %s", got)
	}
}

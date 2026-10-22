package game

import (
	"encoding/json"
	"os"
	"testing"

	"anitexas/backend/internal/engine"
)

// goldenCard 是黄金夹具的单张牌(engine/testdata/golden.json,与引擎黄金测试同源)。
type goldenCard struct {
	ID       int64   `json:"id"`
	Key      string  `json:"key"`
	Title    string  `json:"title"`
	Score    float64 `json:"score"`
	Bucket   float64 `json:"bucket"`
	Year     int     `json:"year"`
	Elements []struct {
		Class int    `json:"class"`
		Value string `json:"value"`
	} `json:"elements"`
}

// loadGolden 读取黄金十手要素集快照,按 key 建索引(测试运行时不依赖管线产物)。
func loadGolden(t *testing.T) map[string]engine.Card {
	t.Helper()
	raw, err := os.ReadFile("../engine/testdata/golden.json")
	if err != nil {
		t.Fatalf("读取 golden.json: %v", err)
	}
	var fx struct {
		Cards []goldenCard `json:"cards"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("解析 golden.json: %v", err)
	}
	out := map[string]engine.Card{}
	for _, f := range fx.Cards {
		c := testCard(f.ID, f.Title, f.Bucket, f.Year)
		c.Score = f.Score
		for _, e := range f.Elements {
			c.Elements = append(c.Elements, engine.Element{Class: e.Class, Value: e.Value})
		}
		out[f.Key] = c
	}
	return out
}

// goldenHandOf 按 key 取五张黄金牌。
func goldenHandOf(t *testing.T, golden map[string]engine.Card, keys []string) []engine.Card {
	t.Helper()
	cards := make([]engine.Card, 0, len(keys))
	for _, k := range keys {
		c, ok := golden[k]
		if !ok {
			t.Fatalf("golden.json 缺牌 %s", k)
		}
		cards = append(cards, c)
	}
	return cards
}

// TestGoldenTenHandsFullChain 黄金十手接入 settle 走一遍全链(A1 回归 / A3 全链):
// 同一桌连续十手(每手 SetDeck -> Start -> 四街跟注/过牌 -> 摊牌 Best7 ->
// 分池 -> 双账本落账),断言:级数 = 规则书期望、持有黄金五张者必胜、
// 筹码盈亏 ±10、牌型积分 = 级数 × 每级积分、一手结束后可重新开局。
func TestGoldenTenHandsFullChain(t *testing.T) {
	golden := loadGolden(t)
	hands := []struct {
		name string
		tier int
		keys []string
	}{
		{"G1 黄金世代", engine.TierGoldGen, []string{"凉宫春日的忧郁", "CLANNAD", "CLANNAD_AS", "轻音少女", "轻音少女 第二季"}},
		{"G2 命运共同体", engine.TierFateUnion, []string{"凉宫春日的忧郁", "CLANNAD", "轻音少女", "声之形", "紫罗兰永恒花园"}},
		{"G3 四大名作", engine.TierMasterwork, []string{"钢之炼金术师 FULLMETAL", "我的英雄学院", "文豪野犬", "灵能百分百", "命运石之门"}},
		{"G4 合奏", engine.TierEnsemble, []string{"CLANNAD", "轻音少女", "紫罗兰永恒花园", "你的名字", "天气之子"}},
		{"G5 年代物语", engine.TierEra, []string{"命运石之门", "心理测量者", "辉夜姬物语", "Fate/stay night [Unlimited", "一拳超人"}},
		{"G6 三部曲物语", engine.TierTrilogy, []string{"凉宫春日的忧郁", "CLANNAD", "CLANNAD_AS", "命运石之门", "一拳超人"}},
		{"G7 三连星", engine.TierTriple, []string{"CLANNAD", "命运石之门", "Fate/stay night [Unlimited", "进击的巨人", "你的名字"}},
		{"G8 四手联弹", engine.TierQuartet, []string{"你的名字", "天气之子", "CLANNAD", "轻音少女", "命运石之门"}},
		{"G9 二重唱", engine.TierDuet, []string{"你的名字", "天气之子", "命运石之门", "一拳超人", "凉宫春日的忧郁"}},
		{"G10 独奏", engine.TierSolo, []string{"你的名字", "一拳超人", "命运石之门", "凉宫春日的忧郁", "大和号永恒不灭"}},
	}

	g := newTestGame(t, Config{StartChips: 10000}, 2, nil)
	for i, h := range hands {
		cards := goldenHandOf(t, golden, h.keys)
		duds := []engine.Card{
			dudCard(int64(900001 + i*10)), dudCard(int64(900002 + i*10)),
			dudCard(int64(900003 + i*10)), dudCard(int64(900004 + i*10)),
		}
		// 座位0 持黄金五张中的两张 + 公共三张;座位1 全杂鱼;两张杂鱼垫牌进公共
		holes := map[int][]engine.Card{
			0: {cards[0], cards[1]},
			1: {duds[0], duds[1]},
		}
		board := []engine.Card{cards[2], cards[3], cards[4], duds[2], duds[3]}
		button := i % 2 // 庄家逐手轮转,发牌顺序随之变化
		if err := g.SetDeck(riggedDeck(2, button, holes, board)); err != nil {
			t.Fatalf("%s SetDeck: %v", h.name, err)
		}
		g.Start()
		drain(g)
		other := 1 - button
		// 四街打满:小盲补齐 -> 大盲过牌 -> 翻牌后大盲先过 -> 双家过牌 ×3
		mustSubmit(t, g, Action{Seat: button, Type: "call"})
		mustSubmit(t, g, Action{Seat: other, Type: "check"})
		for k := 0; k < 3; k++ {
			mustSubmit(t, g, Action{Seat: other, Type: "check"})
			mustSubmit(t, g, Action{Seat: button, Type: "check"})
		}
		evs := drain(g)

		// 摊牌:持有黄金五张的座位0 级数 = 规则书期望
		show, ok := findEvent(t, evs, EventShowdown).(*ShowdownPayload)
		if !ok {
			t.Fatalf("%s 未摊牌", h.name)
		}
		found := false
		for _, hd := range show.Hands {
			if hd.Seat != 0 {
				continue
			}
			found = true
			if hd.Tier != h.tier {
				t.Errorf("%s: 期望 %d 级,实算 %d 级", h.name, h.tier, hd.Tier)
			}
			if len(hd.Cards) != 7 || len(hd.Tiebreak) == 0 {
				t.Errorf("%s: 摊牌载荷应含 7 张牌与比较向量", h.name)
			}
		}
		if !found {
			t.Fatalf("%s: 摊牌缺座位0", h.name)
		}

		// 结算:赢家 +10(小盲补齐后两家各投入 10),输家 -10;积分 = 级数 × 每级
		settled, ok := findEvent(t, evs, EventSettled).(*SettledPayload)
		if !ok {
			t.Fatalf("%s 未结算", h.name)
		}
		if settled.PotWins[0] != 20 || settled.PotWins[1] != 0 {
			t.Errorf("%s: 座位0 应赢 20,实际 potWins=%v", h.name, settled.PotWins)
		}
		for _, row := range settled.Rows {
			switch row.Seat {
			case 0:
				if row.ChipsDelta != 10 {
					t.Errorf("%s: 赢家筹码盈亏 %d != 10", h.name, row.ChipsDelta)
				}
				if row.Points.HandScore != h.tier*TierPointsPerLevel {
					t.Errorf("%s: 牌型积分 %d != 级数×%d", h.name, row.Points.HandScore, TierPointsPerLevel)
				}
			case 1:
				if row.ChipsDelta != -10 {
					t.Errorf("%s: 输家筹码盈亏 %d != -10", h.name, row.ChipsDelta)
				}
				if row.Points.HandScore != 0 {
					t.Errorf("%s: 输家不应得牌型积分,实际 %d", h.name, row.Points.HandScore)
				}
			}
		}
	}
}

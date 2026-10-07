package engine

import (
	_ "embed"
	"encoding/json"
	"testing"
)

//go:embed testdata/golden.json
var goldenJSON []byte // 黄金十手要素集快照（一次性脚本固化；测试运行不依赖 Python）

// fixtureCard 是 golden.json 里一张牌的快照。
type fixtureCard struct {
	ID       int64  `json:"id"`
	Key      string `json:"key"`
	Title    string `json:"title"`
	Score    float64 `json:"score"`
	Bucket   float64 `json:"bucket"`
	Year     int    `json:"year"`
	Elements []struct {
		Class int    `json:"class"`
		Value string `json:"value"`
	} `json:"elements"`
}

// loadGolden 解析要素集快照，按 key 建索引；顺手校验快照档位分与 Bucket() 一致。
func loadGolden(t *testing.T) map[string]Card {
	t.Helper()
	var fx struct {
		Cards []fixtureCard `json:"cards"`
	}
	if err := json.Unmarshal(goldenJSON, &fx); err != nil {
		t.Fatalf("解析 golden.json 失败: %v", err)
	}
	out := make(map[string]Card, len(fx.Cards))
	for _, f := range fx.Cards {
		c := Card{ID: f.ID, Title: f.Title, Score: f.Score, Bucket: f.Bucket, Year: f.Year}
		for _, e := range f.Elements {
			c.Elements = append(c.Elements, Element{Class: e.Class, Value: e.Value})
		}
		if got := Bucket(c.Score); got != c.Bucket {
			t.Fatalf("golden.json %s 档位分不一致: 快照 %v != Bucket(%v)=%v", f.Key, c.Bucket, c.Score, got)
		}
		out[f.Key] = c
	}
	return out
}

// handOf 按 key 取五张牌。
func handOf(t *testing.T, golden map[string]Card, keys []string) []Card {
	t.Helper()
	cards := make([]Card, 0, len(keys))
	for _, k := range keys {
		c, ok := golden[k]
		if !ok {
			t.Fatalf("golden.json 缺牌 %s", k)
		}
		cards = append(cards, c)
	}
	return cards
}

// TestBucket 半值向上（规则书 §2：20 档，round(score*2)/2）。
func TestBucket(t *testing.T) {
	for _, tc := range []struct {
		score float64
		want  float64
	}{
		{8.4, 8.5}, {8.2, 8.0}, {8.25, 8.5}, // 半值向上
		{7.75, 8.0}, {5.0, 5.0}, {9.95, 10.0},
	} {
		if got := Bucket(tc.score); got != tc.want {
			t.Errorf("Bucket(%v) = %v, 期望 %v", tc.score, got, tc.want)
		}
	}
}

// TestGoldenTen 黄金十手（规则书 §4 / architecture.md §4.1）：G1-G10 期望级数全绿，
// 并两两比较验证全序（A1.4 前半：反对称、永不平局、级高者胜）。
func TestGoldenTen(t *testing.T) {
	golden := loadGolden(t)
	hands := []struct {
		name string
		tier int
		keys []string
	}{
		{"G1 黄金世代", TierGoldGen, []string{"凉宫春日的忧郁", "CLANNAD", "CLANNAD_AS", "轻音少女", "轻音少女 第二季"}},
		{"G2 命运共同体", TierFateUnion, []string{"凉宫春日的忧郁", "CLANNAD", "轻音少女", "声之形", "紫罗兰永恒花园"}},
		{"G3 四大名作", TierMasterwork, []string{"钢之炼金术师 FULLMETAL", "我的英雄学院", "文豪野犬", "灵能百分百", "命运石之门"}},
		{"G4 合奏", TierEnsemble, []string{"CLANNAD", "轻音少女", "紫罗兰永恒花园", "你的名字", "天气之子"}},
		{"G5 年代物语", TierEra, []string{"命运石之门", "心理测量者", "辉夜姬物语", "Fate/stay night [Unlimited", "一拳超人"}},
		{"G6 三部曲物语", TierTrilogy, []string{"凉宫春日的忧郁", "CLANNAD", "CLANNAD_AS", "命运石之门", "一拳超人"}},
		{"G7 三连星", TierTriple, []string{"CLANNAD", "命运石之门", "Fate/stay night [Unlimited", "进击的巨人", "你的名字"}},
		{"G8 四手联弹", TierQuartet, []string{"你的名字", "天气之子", "CLANNAD", "轻音少女", "命运石之门"}},
		{"G9 二重唱", TierDuet, []string{"你的名字", "天气之子", "命运石之门", "一拳超人", "凉宫春日的忧郁"}},
		{"G10 独奏", TierSolo, []string{"你的名字", "一拳超人", "命运石之门", "凉宫春日的忧郁", "大和号永恒不灭"}},
	}
	evals := make([]HandEval, 0, len(hands))
	for _, h := range hands {
		got := Eval5(handOf(t, golden, h.keys))
		if got.Tier != h.tier {
			t.Errorf("%s: 期望 %d 级，实算 %d 级", h.name, h.tier, got.Tier)
		}
		evals = append(evals, got)
	}
	// 十手两两比较：表内级数严格递减，故前者必须胜后者
	for i := 0; i < len(evals); i++ {
		for j := i + 1; j < len(evals); j++ {
			ab, ba := Compare(evals[i], evals[j]), Compare(evals[j], evals[i])
			if ab == 0 {
				t.Fatalf("G%d 与 G%d 平局", i+1, j+1)
			}
			if ab != -ba {
				t.Fatalf("G%d 与 G%d 反对称失败: %d vs %d", i+1, j+1, ab, ba)
			}
			if ab != 1 {
				t.Fatalf("G%d 级数高于 G%d 却未胜出", i+1, j+1)
			}
		}
	}
}

// synCard 构造合成牌（专项用例用）：档位分 = 原始分，要素按需拼。
func synCard(id int64, year int, bucket float64, els ...Element) Card {
	return Card{ID: id, Score: bucket, Bucket: bucket, Year: year, Elements: els}
}

// TestCollisionOnlyOneGroup A1.2①：撞要素只算一组——两卡同公司+同标签+同年份+同原作类型
// 仍只计一组，且类取共享类里最高的一档；一对不能因多类命中而冒充两对（判二重唱非四手联弹）。
func TestCollisionOnlyOneGroup(t *testing.T) {
	// A、B 三类要素相撞（公司/标签/年份/原作类型）；C、D、E 与谁都不撞
	cards := []Card{
		synCard(1, 2020, 8.0, Element{ClassStudio, "社X"}, Element{ClassTag, "标X"}, Element{ClassYear, "2020"}, Element{ClassOriginType, "原创"}),
		synCard(2, 2020, 7.5, Element{ClassStudio, "社X"}, Element{ClassTag, "标X"}, Element{ClassYear, "2020"}, Element{ClassOriginType, "原创"}),
		synCard(3, 2022, 7.0, Element{ClassOriginType, "漫画改"}),
		synCard(4, 2023, 6.5, Element{ClassOriginType, "轻小说改"}),
		synCard(5, 2024, 6.0, Element{ClassOriginType, "小说改"}),
	}
	gs := candidateGroups(cards)
	if len(gs) != 1 {
		t.Fatalf("撞要素应折叠为 1 组，实得 %d 组: %+v", len(gs), gs)
	}
	if gs[0].class != ClassStudio || gs[0].mask != 0b00011 {
		t.Fatalf("类应取最高一档(公司=2)且卡集 {0,1}，实得 class=%d mask=%b", gs[0].class, gs[0].mask)
	}
	got := Eval5(cards)
	if got.Tier != TierDuet {
		t.Fatalf("一对判二重唱(2)，实得 %d 级", got.Tier)
	}
	if len(got.Groups) != 1 || len(got.Groups[0]) != 2 {
		t.Fatalf("应恰有一组两卡: %+v", got.Groups)
	}
	// 再撞上监督：类升到最高一档（监督=1）
	cards[0].Elements = append(cards[0].Elements, Element{ClassDirector, "导X"})
	cards[1].Elements = append(cards[1].Elements, Element{ClassDirector, "导X"})
	gs = candidateGroups(cards)
	if len(gs) != 1 || gs[0].class != ClassDirector {
		t.Fatalf("同监督后应仍为 1 组且类=监督(1)，实得 %+v", gs)
	}
}

// TestGroupsOverlapOnlyOne A1.2②：组间卡不相交——两组重叠卡只取其一（不能拼成两对）。
func TestGroupsOverlapOnlyOne(t *testing.T) {
	// A、B 共享监督（强对），A、C 共享标签（弱对），两对都含 A → 只能取其一，判二重唱
	cards := []Card{
		synCard(1, 2001, 8.0, Element{ClassDirector, "导X"}, Element{ClassTag, "标Y"}),
		synCard(2, 2002, 7.5, Element{ClassDirector, "导X"}),
		synCard(3, 2003, 7.0, Element{ClassTag, "标Y"}),
		synCard(4, 2004, 6.5, Element{ClassOriginType, "原创"}),
		synCard(5, 2008, 6.0, Element{ClassOriginType, "漫画改"}), // 年份断开：避免 2001-2005 五连误触年代物语
	}
	got := Eval5(cards)
	if got.Tier != TierDuet {
		t.Fatalf("两对重叠卡不相交不成立，应判二重唱(2)，实得 %d 级", got.Tier)
	}
	if len(got.Groups) != 1 || got.Groups[0][0] != 0 || got.Groups[0][1] != 1 {
		t.Fatalf("应取强对 {A,B} = 下标 [0 1]，实得 %+v", got.Groups)
	}
	// 对照：换成卡不相交的两对 → 四手联弹
	cards[2] = synCard(3, 2003, 7.0, Element{ClassTag, "标Z"})
	cards[3] = synCard(4, 2004, 6.5, Element{ClassTag, "标Z"})
	got = Eval5(cards)
	if got.Tier != TierQuartet {
		t.Fatalf("两对卡不相交应判四手联弹(3)，实得 %d 级", got.Tier)
	}
	if len(got.Groups) != 2 || got.Groups[0][0] != 0 || got.Groups[0][1] != 1 {
		t.Fatalf("组序应为强对(监督)在前: %+v", got.Groups)
	}
}

// TestMultiReadBestTier A1.3：多重解读取最高——年份五连内藏两对（G5 情形的合成版），
// 仍判年代物语而不是四手联弹。
func TestMultiReadBestTier(t *testing.T) {
	// 年份 2011-2015 一年一张；同时 (卡1,卡2) 同标签、(卡3,卡4) 同标签 → 既可读四手联弹也读顺子
	cards := []Card{
		synCard(1, 2011, 8.0, Element{ClassTag, "标A"}, Element{ClassYear, "2011"}),
		synCard(2, 2012, 7.5, Element{ClassTag, "标A"}, Element{ClassYear, "2012"}),
		synCard(3, 2013, 7.0, Element{ClassTag, "标B"}, Element{ClassYear, "2013"}),
		synCard(4, 2014, 6.5, Element{ClassTag, "标B"}, Element{ClassYear, "2014"}),
		synCard(5, 2015, 6.0, Element{ClassYear, "2015"}),
	}
	gs := candidateGroups(cards)
	pairs := 0
	for _, g := range gs {
		if len(g.cards) == 2 {
			pairs++
		}
	}
	if pairs < 2 {
		t.Fatalf("前提不成立：应存在至少两对，实得 %+v", gs)
	}
	if got := Eval5(cards); got.Tier != TierEra {
		t.Fatalf("年份五连内藏两对，应判年代物语(6)，实得 %d 级", got.Tier)
	}
}

// TestBest7PicksHigher A1.5：七选五取最大——7 张里可组两副（合奏 7 级 / 三部曲物语 5 级），取高者，
// 且入选下标/组下标都回归入参 7 张的坐标系。
func TestBest7PicksHigher(t *testing.T) {
	// A,B,C 同标签 T（年份 2000-2002 三连）；D,E 同标签 U；F,G 谁也不撞
	a := synCard(1, 2000, 8.0, Element{ClassTag, "T"}, Element{ClassYear, "2000"})
	b := synCard(2, 2001, 7.5, Element{ClassTag, "T"}, Element{ClassYear, "2001"})
	c := synCard(3, 2002, 7.0, Element{ClassTag, "T"}, Element{ClassYear, "2002"})
	d := synCard(4, 2005, 6.5, Element{ClassTag, "U"}, Element{ClassYear, "2005"})
	e := synCard(5, 2006, 6.0, Element{ClassTag, "U"}, Element{ClassYear, "2006"})
	f := synCard(6, 2010, 5.5, Element{ClassYear, "2010"})
	g := synCard(7, 2011, 5.0, Element{ClassYear, "2011"})
	cards := []Card{a, e, b, g, c, d, f} // 乱序喂入：A=0 E=1 B=2 G=3 C=4 D=5 F=6

	// 弱的一副先存在：A,B,C + F,G = 三部曲物语（5）
	if got := Eval5([]Card{a, b, c, f, g}); got.Tier != TierTrilogy {
		t.Fatalf("对照副应为三部曲物语(5)，实得 %d 级", got.Tier)
	}

	best, idx := Best7(cards)
	if best.Tier != TierEnsemble {
		t.Fatalf("应取合奏(7)那副，实得 %d 级", best.Tier)
	}
	want := []int{0, 1, 2, 4, 5} // A,B,C,D,E 的下标升序
	if len(idx) != 5 {
		t.Fatalf("入选应 5 张: %v", idx)
	}
	for i := range want {
		if idx[i] != want[i] {
			t.Fatalf("入选下标 = %v，期望 %v", idx, want)
		}
	}
	// 组下标同为七张坐标系，且强张在前（档位分降序）：三条组 A,B,C = [0 2 4]，对子 D,E = [5 1]
	if len(best.Groups) != 2 || len(best.Groups[0]) != 3 || len(best.Groups[1]) != 2 {
		t.Fatalf("组形态应为 3+2: %+v", best.Groups)
	}
	if best.Groups[0][0] != 0 || best.Groups[0][1] != 2 || best.Groups[0][2] != 4 ||
		best.Groups[1][0] != 5 || best.Groups[1][1] != 1 {
		t.Fatalf("组下标应回归七张坐标系且强张在前: %+v", best.Groups)
	}
}

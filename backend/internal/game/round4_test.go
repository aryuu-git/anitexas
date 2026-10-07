package game

import (
	"testing"

	"anitexas/backend/internal/engine"
)

// 本文件是收尾轮 A2.4 主题牌池 + R2 破产重买的游戏层守约回归：
//   - FilterTheme：company/year/tag 三类匹配语义（frontend-contract §3，D11 主题=过滤后再分层）；
//   - Rebuy：破产重买只补筹码、积分不变（R2/D19「仅筹码账，积分不受影响」）。

// TestFilterTheme 校验三类主题过滤：company 值匹配 / year 年份匹配 / tag 子串包含 +
// 不匹配排除 + 空值（不设主题）返回全库。
func TestFilterTheme(t *testing.T) {
	lib := []engine.Card{
		testCard(1, "京阿尼A", 8.0, 2007,
			engine.Element{Class: engine.ClassStudio, Value: "京都动画"},
			engine.Element{Class: engine.ClassYear, Value: "2007"},
			engine.Element{Class: engine.ClassTag, Value: "热血"}),
		testCard(2, "京阿尼B", 7.5, 2010,
			engine.Element{Class: engine.ClassStudio, Value: "京都动画"},
			engine.Element{Class: engine.ClassYear, Value: "2010"},
			engine.Element{Class: engine.ClassTag, Value: "日常系"}),
		testCard(3, "别家", 7.0, 2007,
			engine.Element{Class: engine.ClassStudio, Value: "骨头社"},
			engine.Element{Class: engine.ClassYear, Value: "2007"},
			engine.Element{Class: engine.ClassTag, Value: "燃"}),
		testCard(4, "年份字段", 6.5, 2007, // 无年份要素，但 Year 字段=2007（year 应命中）
			engine.Element{Class: engine.ClassTag, Value: "日常系"}),
	}

	// company：值 == 「京都动画」→ 2 张（京阿尼A/B）。
	got := FilterTheme(lib, "company", "京都动画")
	if len(got) != 2 || got[0].ID != 1 || got[1].ID != 2 {
		t.Fatalf("company=京都动画 应命中 2 张(1,2)，实得 %d 张 %+v", len(got), got)
	}

	// year：Year 字段或年份要素 == 「2007」→ 3 张（1/3/4）。
	got = FilterTheme(lib, "year", "2007")
	if len(got) != 3 {
		ids := []int64{}
		for _, c := range got {
			ids = append(ids, c.ID)
		}
		t.Fatalf("year=2007 应命中 3 张(1,3,4)，实得 %d 张 %v", len(got), ids)
	}

	// tag：标签值包含「日常」→ 2 张（2/4，子串包含）。
	got = FilterTheme(lib, "tag", "日常")
	if len(got) != 2 || got[0].ID != 2 || got[1].ID != 4 {
		t.Fatalf("tag=日常 应命中 2 张(2,4)，实得 %d 张 %+v", len(got), got)
	}

	// 不匹配 → 0 张。
	if got = FilterTheme(lib, "company", "不存在社"); len(got) != 0 {
		t.Fatalf("company=不存在社 应 0 张，实得 %d 张", len(got))
	}

	// 空 value（未设主题）→ 不过滤，返回全库。
	if got = FilterTheme(lib, "tag", ""); len(got) != len(lib) {
		t.Fatalf("空主题应返回全库 %d 张，实得 %d 张", len(lib), len(got))
	}
}

// TestFilterMinVotes 校验作品标注数（评分人数）下限过滤：仅保留 Votes>=min、保持库内顺序，
// min<=0 原样返回（不复制底层数组）。
func TestFilterMinVotes(t *testing.T) {
	lib := []engine.Card{
		{ID: 1, Title: "热", Votes: 5000},
		{ID: 2, Title: "中", Votes: 2000},
		{ID: 3, Title: "冷", Votes: 1999},
		{ID: 4, Title: "零", Votes: 0},
	}
	// min=2000：含等于（>=）→ 命中 1、2。
	got := FilterMinVotes(lib, 2000)
	if len(got) != 2 || got[0].ID != 1 || got[1].ID != 2 {
		t.Fatalf("min=2000 应命中 2 张(1,2)，实得 %d 张 %+v", len(got), got)
	}
	// min=1999：多收一张边界。
	if got = FilterMinVotes(lib, 1999); len(got) != 3 {
		t.Fatalf("min=1999 应命中 3 张，实得 %d 张", len(got))
	}
	// min<=0：不过滤，原样返回同一底层数组（不复制）。
	if got = FilterMinVotes(lib, 0); len(got) != len(lib) || &got[0] != &lib[0] {
		t.Fatalf("min=0 应原样返回全库（同一底层数组）")
	}
	if got = FilterMinVotes(lib, -1); &got[0] != &lib[0] {
		t.Fatalf("min<0 应原样返回全库")
	}
}

// TestRebuyRestoresChipsKeepsPoints 校验破产重买语义（R2/D19）：
// 破产（chips=0）座位被 active 排除；Rebuy 后筹码回到初始额、积分原封不动。
func TestRebuyRestoresChipsKeepsPoints(t *testing.T) {
	holes := map[int][]engine.Card{
		0: {testCard(1, "甲", 8.0, 2001), testCard(2, "乙", 7.5, 2002)},
		1: {testCard(3, "丙", 7.0, 2003), testCard(4, "丁", 6.5, 2004)},
	}
	board := []engine.Card{testCard(5, "公", 6.0, 2005), dudCard(6), dudCard(7), dudCard(8), dudCard(9)}
	g := newTestGame(t, Config{StartChips: 1000}, 2, riggedDeck(2, 0, holes, board))

	// 白盒把座位 0 掰成「破产但有积分」：chips=0、points=42（经表 goroutine 串行，无竞态）。
	if err := g.call(func() error {
		g.seats[0].chips = 0
		g.seats[0].points = 42
		return nil
	}); err != nil {
		t.Fatalf("白盒改状态: %v", err)
	}

	// 破产（chips=0）→ 被 active 排除。
	act := g.eligibleSeats()
	for _, s := range act {
		if s == 0 {
			t.Fatalf("chips=0 的座位 0 不应进入 active %v", act)
		}
	}

	// 重买：筹码回初始额、积分不变。
	if err := g.Rebuy(0); err != nil {
		t.Fatalf("重买应成功: %v", err)
	}
	if err := g.call(func() error {
		if g.seats[0].chips != g.cfg.StartChips {
			t.Errorf("重买额应=初始筹码 %d，实得 %d", g.cfg.StartChips, g.seats[0].chips)
		}
		if g.seats[0].points != 42 {
			t.Errorf("重买应只动筹码、积分不受影响，期望 42 实得 %d", g.seats[0].points)
		}
		return nil
	}); err != nil {
		t.Fatalf("校验: %v", err)
	}

	// 重买后回到 active（有筹码）。
	act = g.eligibleSeats()
	found := false
	for _, s := range act {
		if s == 0 {
			found = true
		}
	}
	if !found {
		t.Fatalf("重买后座位 0 应回到 active %v", act)
	}
}

// TestRebuyCapRejectsExhausted 重买上限（MAX_REBUYS）：逐次计入座位 rebuys，
// 达上限拒绝 rebuy_exhausted 且计数/筹码均不动；各座位独立计数，非法座位 bad_seat。
func TestRebuyCapRejectsExhausted(t *testing.T) {
	g := newTestGame(t, Config{StartChips: 1000, MaxRebuys: 2}, 2, nil)
	bust := func(seat int) {
		t.Helper()
		if err := g.call(func() error {
			g.seats[seat].chips = 0
			return nil
		}); err != nil {
			t.Fatalf("白盒破产: %v", err)
		}
	}

	// 上限 2：前两次成功，筹码回初始额、rebuys 逐次累计。
	for i := 1; i <= 2; i++ {
		bust(0)
		if err := g.Rebuy(0); err != nil {
			t.Fatalf("第 %d 次重买应成功（MaxRebuys=2）: %v", i, err)
		}
		if got := g.Rebuys(0); got != i {
			t.Fatalf("第 %d 次重买后 rebuys = %d，期望 %d", i, got, i)
		}
		if got := g.SnapshotFor(0).Seats[0].Chips; got != 1000 {
			t.Fatalf("重买后筹码应回初始额 1000，实得 %d", got)
		}
	}

	// 第 3 次：rebuy_exhausted，计数与筹码均不动。
	bust(0)
	if err := g.Rebuy(0); errorCodeOf(err) != CodeRebuyExhausted {
		t.Fatalf("超限重买应 rebuy_exhausted，实际 %v", err)
	}
	if got := g.Rebuys(0); got != 2 {
		t.Fatalf("拒绝后 rebuys 不应增长，实际 %d", got)
	}
	if got := g.SnapshotFor(0).Seats[0].Chips; got != 0 {
		t.Fatalf("拒绝后筹码不应变动，实际 %d", got)
	}

	// 各座位独立计数：座位 1 首次重买照常；非法座位回 bad_seat。
	if err := g.Rebuy(1); err != nil {
		t.Fatalf("座位 1 首次重买应成功: %v", err)
	}
	if got := g.Rebuys(1); got != 1 {
		t.Fatalf("座位 1 rebuys = %d，期望 1", got)
	}
	if err := g.Rebuy(99); errorCodeOf(err) != CodeBadSeat {
		t.Fatalf("非法座位应 bad_seat，实际 %v", err)
	}
}

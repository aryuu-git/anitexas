package room

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"anitexas/backend/internal/engine"
	"anitexas/backend/internal/model"
	"anitexas/backend/internal/store"
)

// 本文件是收尾轮的服务端配套守约回归（对齐 docs/frontend-contract.md）：
//   §1 聊天 say/said：校验（长度/节流）+ 全桌广播 + chatEnabled 关闭拒发；
//   §2 可验证发牌：seedCommit 先于 dealt、seedReveal 于 settled 后、SHA-256 一致；
//   §3 主题牌池：themeFilter 过滤正确 + 过窄回退全库；
//   R2 破产处置：bot 离席补位 + 真人重买，4 玩家 20 手 active 不跌破 2、不死桌。

// newChatRoom 建一张只用于聊天/主题的空桌（不开手）：座位 0 = alice 并挂观测链路。
func newChatRoom(t *testing.T, cfg model.RoomConfig) (*Room, *obsLink) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	r := NewRoom("room-round4", "RND004", "host", cfg, 0, DefaultBotParams(), synthLibrary(200), st, nil, Timing{})
	t.Cleanup(r.Close)
	seat, err := r.Join("alice")
	if err != nil {
		t.Fatalf("alice 入座: %v", err)
	}
	obs := newObsLink()
	r.seats[seat].link = obs // 白盒挂观测链路（与 botselfplay 同法）
	return r, obs
}

// baseCfg 是收尾轮共用的合法建房配置。
// 测试桌默认按练习房构造：单真人 + 机器人即可开局，且 ready 后仍需房主显式 start。
func baseCfg() model.RoomConfig {
	return model.RoomConfig{
		AutoReveal: false, Seats: 4, SmallBlind: 1, BigBlind: 2,
		Chips: 1000, RevealRate: 0, DeckStrategy: "stratified",
		DeckSize: 10, ChatEnabled: true,
		RoomKind: model.RoomKindPractice, BotPolicy: model.BotPolicyFill,
		TargetHumanCount: 2, NextHandPolicy: model.NextHandManual,
	}
}

// readyAndStart 模拟真实主流程：玩家准备 + 房主主动开始（ready 本身不再开局）。
func readyAndStart(t *testing.T, r *Room, seat int) {
	t.Helper()
	if err := r.Ready(seat); err != nil {
		t.Fatalf("准备: %v", err)
	}
	if err := r.StartGame(seat, model.StartPayload{}); err != nil {
		t.Fatalf("房主开始: %v", err)
	}
}

// pollSaid 排队取下一条 said 帧；超时/取到非 said 返回 nil。
func pollSaid(t *testing.T, obs *obsLink) *model.SaidPayload {
	t.Helper()
	select {
	case raw := <-obs.ch:
		env, err := model.DecodeEnvelope(raw)
		if err != nil {
			t.Fatalf("解信封: %v", err)
		}
		if env.T != model.TypeSaid {
			return nil
		}
		var sp model.SaidPayload
		if err := env.Decode(&sp); err != nil {
			t.Fatalf("解 said: %v", err)
		}
		return &sp
	case <-time.After(2 * time.Second):
		return nil
	}
}

// TestSayBroadcasts 校验 say 上行 -> said 全桌广播（含发言者），text 去空白。
func TestSayBroadcasts(t *testing.T) {
	r, obs := newChatRoom(t, baseCfg())
	if err := r.Say(0, "  你好，来一局？  "); err != nil {
		t.Fatalf("Say: %v", err)
	}
	sp := pollSaid(t, obs)
	if sp == nil {
		t.Fatal("未收到 said 广播")
	}
	if sp.Seat != 0 || sp.Text != "你好，来一局？" {
		t.Fatalf("said 应 {seat:0, text:去空白}，实得 %+v", sp)
	}
}

// TestSayValidation 校验长度/空/节流三类拒发（frontend-contract §1）。
func TestSayValidation(t *testing.T) {
	r, _ := newChatRoom(t, baseCfg())

	// 超长（>120 字）→ chat_too_long。
	if err := r.Say(0, strings.Repeat("长", 121)); err != ErrChatTooLong {
		t.Fatalf("121 字应 ErrChatTooLong，实得 %v", err)
	}
	// 全空白（去空白后为空）→ 拒发。
	if err := r.Say(0, "   \t  "); err == nil {
		t.Fatal("空白发言应拒发")
	}
	// 正常一条，成功。
	if err := r.Say(0, "第一条"); err != nil {
		t.Fatalf("首条 Say: %v", err)
	}
	// 节流：窗口内第二条 → chat_throttle。
	if err := r.Say(0, "第二条"); err != ErrChatThrottle {
		t.Fatalf("节流窗口内应 ErrChatThrottle，实得 %v", err)
	}
	// 恰 120 字仍放行（换一个未触发节流的座位）。
	bob, err := r.Join("bob")
	if err != nil {
		t.Fatalf("bob 入座: %v", err)
	}
	if err := r.Say(bob, strings.Repeat("字", 120)); err != nil {
		t.Fatalf("120 字应放行，实得 %v", err)
	}
}

// TestSayDisabled 校验 chatEnabled=false 时拒发（房主关聊天）。
func TestSayDisabled(t *testing.T) {
	cfg := baseCfg()
	cfg.ChatEnabled = false
	r, obs := newChatRoom(t, cfg)
	if err := r.Say(0, "还能说吗"); err != ErrChatDisabled {
		t.Fatalf("关聊天应 ErrChatDisabled，实得 %v", err)
	}
	if sp := pollSaid(t, obs); sp != nil {
		t.Fatalf("关聊天不应广播 said，实得 %+v", sp)
	}
	// 错误码常量与契约逐字一致（api 层据此映射下行 error.code）。
	if model.CodeChatDisabled != "chat_disabled" || model.CodeChatTooLong != "chat_too_long" {
		t.Fatalf("聊天错误码与契约不符: %q / %q", model.CodeChatDisabled, model.CodeChatTooLong)
	}
}

// themeLib 造 n 张卡，其中偶数下标挂 company、奇数挂「别家」（可控过滤基数）。
func themeLib(n int, company string) []engine.Card {
	lib := make([]engine.Card, 0, n)
	for i := 0; i < n; i++ {
		comp := "别家"
		if i%2 == 0 {
			comp = company
		}
		lib = append(lib, engine.Card{
			ID: int64(i), Title: "主题" + comp, Score: 5.0, Bucket: 5.0, Year: 2000,
			Elements: []engine.Element{{Class: engine.ClassStudio, Value: comp}},
		})
	}
	return lib
}

// TestThemeFilterFallback 校验主题牌池：过滤够牌池 → 用过滤集；过窄（< DeckSize）→ 回退全库。
func TestThemeFilterFallback(t *testing.T) {
	const total = 40
	lib := themeLib(total, "京阿尼") // 20 张挂「京阿尼」

	// 够牌池：DeckSize=10，过滤出 20 张 >= 10 → deckLib = 过滤集（非全库）。
	cfg := baseCfg()
	cfg.DeckStrategy = "theme"
	cfg.DeckSize = 10
	cfg.ThemeFilter = &model.ThemeFilter{Kind: "company", Value: "京阿尼"}
	st, err := store.Open(filepath.Join(t.TempDir(), "theme.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	rWide := NewRoom("room-wide", "WIDE01", "host", cfg, 0, DefaultBotParams(), lib, st, nil, Timing{})
	t.Cleanup(rWide.Close)
	if len(rWide.deckLib) != 20 {
		t.Fatalf("过滤够牌池应用过滤集 20 张，实得 %d", len(rWide.deckLib))
	}
	for _, c := range rWide.deckLib {
		if c.Elements[0].Value != "京阿尼" {
			t.Fatalf("过滤集应只含「京阿尼」，实得 %+v", c.Elements)
		}
	}

	// 过窄：过滤出 0 张 < DeckSize=10 → 回退全库。
	cfg2 := baseCfg()
	cfg2.DeckStrategy = "theme"
	cfg2.DeckSize = 10
	cfg2.ThemeFilter = &model.ThemeFilter{Kind: "company", Value: "无此社"}
	rNarrow := NewRoom("room-narrow", "NARW01", "host", cfg2, 0, DefaultBotParams(), lib, st, nil, Timing{})
	t.Cleanup(rNarrow.Close)
	if len(rNarrow.deckLib) != total {
		t.Fatalf("过窄应回退全库 %d 张，实得 %d", total, len(rNarrow.deckLib))
	}

	// stratified（非 theme）不走过滤，deckLib = 全库。
	cfg3 := baseCfg()
	cfg3.DeckSize = 10
	rStrat := NewRoom("room-strat", "STRT01", "host", cfg3, 0, DefaultBotParams(), lib, st, nil, Timing{})
	t.Cleanup(rStrat.Close)
	if len(rStrat.deckLib) != total {
		t.Fatalf("stratified 应全库 %d 张，实得 %d", total, len(rStrat.deckLib))
	}
}

// TestMinVotesFilter 校验作品标注数下限（RoomConfig.MinVotes）运行时收池（对 stratified 亦生效）：
// 过滤够牌池 → 用过滤集（只保留 votes>=min）；过窄（< DeckSize）→ 回退全库；MinVotes=0 → 不过滤。
func TestMinVotesFilter(t *testing.T) {
	const total = 40
	lib := make([]engine.Card, 0, total)
	for i := 0; i < total; i++ {
		votes := 100 // 冷门
		if i%2 == 0 {
			votes = 5000 // 热门（20 张）
		}
		lib = append(lib, engine.Card{
			ID: int64(i), Title: fmt.Sprintf("v%d", votes), Score: 5.0, Bucket: 5.0, Year: 2000, Votes: votes,
			Elements: []engine.Element{{Class: engine.ClassYear, Value: "2000"}},
		})
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "votes.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	// 够牌池：MinVotes=2000，热门 20 张 >= DeckSize=10 → deckLib = 过滤集（非全库）。
	cfg := baseCfg()
	cfg.DeckSize = 10
	cfg.MinVotes = 2000
	rWide := NewRoom("room-votes-wide", "VOTE01", "host", cfg, 0, DefaultBotParams(), lib, st, nil, Timing{})
	t.Cleanup(rWide.Close)
	if len(rWide.deckLib) != 20 {
		t.Fatalf("过滤够牌池应用过滤集 20 张，实得 %d", len(rWide.deckLib))
	}
	for _, c := range rWide.deckLib {
		if c.Votes < 2000 {
			t.Fatalf("过滤集应只含 votes>=2000，实得 %d", c.Votes)
		}
	}

	// 过窄：MinVotes 极高 → 命中 0 张 < DeckSize=10 → 回退全库。
	cfg2 := baseCfg()
	cfg2.DeckSize = 10
	cfg2.MinVotes = 1 << 30
	rNarrow := NewRoom("room-votes-narrow", "VOTE02", "host", cfg2, 0, DefaultBotParams(), lib, st, nil, Timing{})
	t.Cleanup(rNarrow.Close)
	if len(rNarrow.deckLib) != total {
		t.Fatalf("过窄应回退全库 %d 张，实得 %d", total, len(rNarrow.deckLib))
	}

	// MinVotes=0：不过滤，全库。
	cfg3 := baseCfg()
	cfg3.DeckSize = 10
	rOff := NewRoom("room-votes-off", "VOTE03", "host", cfg3, 0, DefaultBotParams(), lib, st, nil, Timing{})
	t.Cleanup(rOff.Close)
	if len(rOff.deckLib) != total {
		t.Fatalf("MinVotes=0 应全库 %d 张，实得 %d", total, len(rOff.deckLib))
	}
}

// newSelfplayRoom 建 1 harness（座位 0，出牌由 bot 代打）+ 3 bot（座位 1-3，座位 1 挂 obs）
// 的自对局桌，用于跑真实对局链路（对齐 botselfplay 建桌法）。
func newSelfplayRoom(t *testing.T, cfg model.RoomConfig, lib []engine.Card) (*Room, *obsLink) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "hand.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	bp := DefaultBotParams()
	bp.DelayMs = 0 // 不吃思考延迟，尽快推进
	r := NewRoom("room-round4-hand", "RND4HD", "harness", cfg, 0, bp, lib, st, nil, Timing{})
	t.Cleanup(r.Close)
	obs := newObsLink()
	for i := 1; i < 4; i++ {
		occ := &occupant{nick: BotNick(i), isBot: true, ready: true}
		if i == 1 {
			occ.link = obs
		}
		r.seats[i] = occ
	}
	if _, err := r.Join("harness"); err != nil {
		t.Fatalf("harness 入座: %v", err)
	}
	return r, obs
}

// driveHand 发 ready 后收集下行帧直到 terminal（含）；遇 error 下行立即返回（sawError），
// 免得「开局失败/不足 2 人」把手卡到 60s 超时。
func driveHand(t *testing.T, r *Room, obs *obsLink, readySeat int, terminal string) (frames []model.Envelope, sawError bool) {
	t.Helper()
	if err := r.Ready(readySeat); err != nil {
		t.Fatalf("ready: %v", err)
	}
	// ready 只表达意愿；真实开局必须由房主显式 start（失败时由 error 下行体现）。
	_ = r.StartGame(readySeat, model.StartPayload{})
	for {
		select {
		case raw := <-obs.ch:
			env, err := model.DecodeEnvelope(raw)
			if err != nil {
				t.Fatalf("解信封: %v", err)
			}
			frames = append(frames, env)
			if env.T == model.TypeError {
				return frames, true
			}
			if env.T == terminal {
				return frames, false
			}
		case <-time.After(60 * time.Second):
			t.Fatalf("60s 未等到 %s（卡死或开局失败）", terminal)
		}
	}
}

// TestSeedCommitReveal 校验可验证发牌（frontend-contract §2）：seedCommit 先于 dealt、
// seedReveal 在 settled 后、SHA-256(seed) 与固证一致（hex 小写）、快照带本手固证。
func TestSeedCommitReveal(t *testing.T) {
	cfg := baseCfg()
	cfg.Chips = 100000
	cfg.DeckSize = 78
	r, obs := newSelfplayRoom(t, cfg, synthLibrary(2000))

	// 一手跑到 seedReveal（摊牌后揭示，是本手最后一帧）。
	frames, sawErr := driveHand(t, r, obs, 0, model.TypeSeedReveal)
	if sawErr {
		t.Fatalf("seed 手出现 error 下行: %s", string(frames[len(frames)-1].P))
	}
	idx := func(ty string) int {
		for i, e := range frames {
			if e.T == ty {
				return i
			}
		}
		return -1
	}
	ci, di, si, ri := idx(model.TypeSeedCommit), idx(model.TypeDealt), idx(model.TypeSettled), idx(model.TypeSeedReveal)
	if ci < 0 {
		t.Fatal("缺 seedCommit 帧")
	}
	if di >= 0 && ci >= di {
		t.Fatalf("seedCommit(idx %d) 应先于 dealt(idx %d)——发牌前已固证", ci, di)
	}
	if ri < 0 {
		t.Fatal("缺 seedReveal 帧")
	}
	if si >= 0 && ri <= si {
		t.Fatalf("seedReveal(idx %d) 应在 settled(idx %d) 之后揭示", ri, si)
	}

	// 取固证与揭示 seed。
	var commit model.SeedCommitPayload
	if err := frames[ci].Decode(&commit); err != nil {
		t.Fatalf("解 seedCommit: %v", err)
	}
	var reveal model.SeedRevealPayload
	if err := frames[ri].Decode(&reveal); err != nil {
		t.Fatalf("解 seedReveal: %v", err)
	}

	// 独立算 SHA-256(seed) 与固证比对（契约：hex 小写、64 位）。
	sum := sha256.Sum256([]byte(reveal.Seed))
	want := hex.EncodeToString(sum[:])
	if commit.Sha256 != want {
		t.Fatalf("固证哈希不一致: commit=%s want(SHA-256(seed))=%s", commit.Sha256, want)
	}
	if len(commit.Sha256) != 64 || strings.ToLower(commit.Sha256) != commit.Sha256 {
		t.Fatalf("固证应 64 位小写 hex，实得 %q", commit.Sha256)
	}
	if model.SeedCommitHex(reveal.Seed) != want {
		t.Fatalf("model.SeedCommitHex 与独立计算不符：%s vs %s", model.SeedCommitHex(reveal.Seed), want)
	}

	// 快照带本手固证（断线快照恢复后仍可验证）。
	r.mu.Lock()
	sc := r.snapshotLocked(0).SeedCommit
	r.mu.Unlock()
	if sc == nil || *sc != commit.Sha256 {
		t.Fatalf("快照 seedCommit 应=本手固证 %s，实得 %v", commit.Sha256, sc)
	}
}

// TestBankruptcySoakNeverDies 校验 R2 破产处置：4 玩家浅筹码连续 20 手，破产 bot 离席补位、
// 真人重买，active 不跌破 2、桌不死（零 error 下行、每手 settled 覆盖 >=2 座）。
func TestBankruptcySoakNeverDies(t *testing.T) {
	const hands = 20
	cfg := baseCfg()
	cfg.Chips = 50 // 浅筹码逼出破产/离席/补位/重买
	cfg.SmallBlind = 5
	cfg.BigBlind = 10
	cfg.DeckSize = 78
	r, obs := newSelfplayRoom(t, cfg, synthLibrary(2000))

	botLeaves, humanRebuys := 0, 0 // 破产处置实测计数（R2 离席/重买路径必须真被走到）
	for h := 1; h <= hands; h++ {
		frames, sawErr := driveHand(t, r, obs, 0, model.TypeSettled)
		if sawErr {
			t.Fatalf("第 %d 手出现 error 下行（应 0：桌不得死、active 不得跌破 2）: %s",
				h, string(frames[len(frames)-1].P))
		}
		var sp model.SettledPayload
		found := false
		for _, e := range frames {
			if e.T == model.TypeSettled {
				if err := e.Decode(&sp); err != nil {
					t.Fatalf("第 %d 手解 settled: %v", h, err)
				}
				found = true
			}
		}
		if !found {
			t.Fatalf("第 %d 手缺 settled", h)
		}
		if len(sp.Rows) < 2 {
			t.Fatalf("第 %d 手 settled rows=%d < 2（active 跌破 2）", h, len(sp.Rows))
		}

		// settled 广播与破产处置同临界区：此刻抢到 r.mu 即处置已收尾。
		// 1) 破产取证 + 处置后置不变量（R2/D19）：scores 在处置前落账，chips=0 行是本手破产现场；
		//    对照处置后形态——bot 离席成空位（下一手 beginHand 补位）、真人就地重买留座（chips>0）。
		r.mu.Lock()
		snap := r.snapshotLocked(0)
		bad := ""
		for i, o := range r.seats {
			if o == nil || i >= len(snap.Seats) {
				continue
			}
			if snap.Seats[i].Chips <= 0 {
				bad = fmt.Sprintf("座位 %d 仍持 %d 筹码", i, snap.Seats[i].Chips)
			}
		}
		if rows, err := r.st.ListScores(r.id); err == nil {
			for _, sc := range rows {
				if sc.Chips > 0 || sc.Seat < 0 || sc.Seat >= len(r.seats) {
					continue
				}
				if r.seats[sc.Seat] == nil {
					botLeaves++
				} else if !r.seats[sc.Seat].isBot {
					humanRebuys++
				}
			}
		}
		// 2) 白盒挂回观测链路（与 newSelfplayRoom 同法）：bot 离席会把座位 1 的 obs 一并释放，
		//    beginHand 补位的新 bot 不带链路——不挂回测试从下一手起失明（测试观测缺陷，非产品行为）。
		if r.seats[1] == nil {
			r.seats[1] = &occupant{nick: BotNick(1), isBot: true, ready: true}
		}
		r.seats[1].link = obs
		r.mu.Unlock()
		if bad != "" {
			t.Fatalf("第 %d 手处置后 %s（R2 未生效：bot 应离席、真人应重买）", h, bad)
		}
	}
	// 20 手全 settle + 零 error = 不死桌、active 恒 >= 2；且破产处置必须真被走到过。
	if botLeaves == 0 && humanRebuys == 0 {
		t.Fatalf("20 手浅筹码未逼出任何破产处置（bot 离席=%d 真人重买=%d），R2 路径未覆盖", botLeaves, humanRebuys)
	}
	t.Logf("R2 破产处置实测：bot 离席 %d 次、真人重买 %d 次（20 手不死桌）", botLeaves, humanRebuys)
}

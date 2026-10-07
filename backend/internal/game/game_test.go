package game

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"anitexas/backend/internal/engine"
)

// testCard 构造测试牌:档位分 = 原始分,要素任意拼。
func testCard(id int64, title string, bucket float64, year int, els ...engine.Element) engine.Card {
	return engine.Card{
		ID: id, Title: title, Score: bucket, Bucket: bucket,
		Year: year, Elements: els,
	}
}

// dudCard 构造互不相干的杂鱼牌:唯一要素取值 + 彼此不接壤的远古年份
// (与主池年份不接壤、互相也不成顺,凑不出任何成组)。
func dudCard(id int64) engine.Card {
	years := []int{1901, 1903, 1907, 1909, 1913, 1917}
	return testCard(id, fmt.Sprintf("杂鱼%03d", id), 1.0, years[int(id)%len(years)],
		engine.Element{Class: engine.ClassTag, Value: fmt.Sprintf("杂%03d", id)})
}

// riggedDeck 按 doStart 的发牌顺序拼一副牌:两轮轮转(庄家下家起)+ 5 公共牌。
// holes 每座恰好 2 张,键必须是 0..nSeats-1;返回的牌组可直接喂 New/SetDeck。
func riggedDeck(nSeats, button int, holes map[int][]engine.Card, board []engine.Card) []engine.Card {
	deck := []engine.Card{}
	start := (button + 1) % nSeats
	for r := 0; r < 2; r++ {
		for i := 0; i < nSeats; i++ {
			s := (start + i) % nSeats
			deck = append(deck, holes[s][r])
		}
	}
	return append(deck, board...)
}

// newTestGame 建一桌测试局并全员入座(每人 StartChips);t.Cleanup 自动关表。
func newTestGame(t *testing.T, cfg Config, nSeats int, deck []engine.Card) *Game {
	t.Helper()
	if cfg.Seats == 0 {
		cfg.Seats = nSeats
	}
	if cfg.SmallBlind == 0 {
		cfg.SmallBlind = 5
	}
	if cfg.BigBlind == 0 {
		cfg.BigBlind = 10
	}
	if cfg.StartChips == 0 {
		cfg.StartChips = 1000
	}
	g := New(cfg, deck)
	t.Cleanup(g.Close)
	for i := 0; i < nSeats; i++ {
		if err := g.Join(i, fmt.Sprintf("p%d", i), false); err != nil {
			t.Fatalf("Join(%d): %v", i, err)
		}
	}
	return g
}

// mustSubmit 提交动作,失败即断言。
func mustSubmit(t *testing.T, g *Game, a Action) {
	t.Helper()
	if err := g.Submit(a); err != nil {
		t.Fatalf("Submit(%d %s %d): %v", a.Seat, a.Type, a.Amount, err)
	}
}

// drain 取走当前已入队的事件(命令返回时其事件已入队,故确定性)。
func drain(g *Game) []Event {
	evs := []Event{}
	for {
		select {
		case ev := <-g.events:
			evs = append(evs, ev)
		default:
			return evs
		}
	}
}

// waitEvents 等待事件流累计至少 n 条或超时(超时自动动作用)。
func waitEvents(t *testing.T, g *Game, n int, timeout time.Duration) []Event {
	t.Helper()
	evs := drain(g)
	deadline := time.After(timeout)
	for len(evs) < n {
		select {
		case ev := <-g.events:
			evs = append(evs, ev)
		case <-deadline:
			t.Fatalf("等待 %d 条事件超时,实收 %d 条: %+v", n, len(evs), evs)
		}
	}
	return evs
}

// findEvent 返回首个指定类型的事件载荷,找不到断言。
func findEvent(t *testing.T, evs []Event, typ string) any {
	t.Helper()
	for _, ev := range evs {
		if ev.Type == typ {
			return ev.Payload
		}
	}
	t.Fatalf("事件流中未找到 %s 事件: %+v", typ, evs)
	return nil
}

// countEvents 统计指定类型事件条数。
func countEvents(evs []Event, typ string) int {
	n := 0
	for _, ev := range evs {
		if ev.Type == typ {
			n++
		}
	}
	return n
}

// marshalJSON 快照序列化,失败即断言。
func marshalJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return string(b)
}

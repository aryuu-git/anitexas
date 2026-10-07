package room

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"testing"
	"time"

	"anitexas/backend/internal/model"
	"anitexas/backend/internal/store"
)

// TestA63ConcurrencySoak A6.3：10 桌 bot 并发跑 N 秒，断言无 panic、goroutine 数平稳。
// 每桌 harness(座位0,掉线人类由 botAct 代打) + 3 bot，bot 自动打；不逐手校验细节
// （那是 A3.4 的活），只观测稳定性。手数自对局已覆盖，这里看并发无泄漏/无崩溃。
func TestA63ConcurrencySoak(t *testing.T) {
	if testing.Short() {
		t.Skip("并发 soak 是 A6.3 验收用例，-short 跳过")
	}
	seconds := 10
	if v := os.Getenv("SOAK_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			seconds = n
		}
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "soak.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	defer st.Close()

	const tables = 10
	rooms := make([]*Room, 0, tables)
	for i := 0; i < tables; i++ {
		cfg := model.RoomConfig{
			AutoReveal: false, Seats: 4, SmallBlind: 1, BigBlind: 2,
			Chips: 1000000, RevealRate: 0, DeckStrategy: "stratified", DeckSize: 78,
		}
		bp := DefaultBotParams()
		bp.DelayMs = 0
		r := NewRoom(fmt.Sprintf("soak-%d", i), fmt.Sprintf("SK%04d", i), "harness",
			cfg, 0 /* 关超时自动动作 */, bp, synthLibrary(2000), st, nil, Timing{})
		for s := 1; s < 4; s++ {
			r.seats[s] = &occupant{nick: BotNick(s), isBot: true, ready: true}
		}
		if _, err := r.Join("harness"); err != nil {
			t.Fatalf("桌%d harness 入座: %v", i, err)
		}
		if err := r.Ready(0); err != nil {
			t.Fatalf("桌%d 首手 ready: %v", i, err)
		}
		rooms = append(rooms, r)
	}
	defer func() {
		for _, r := range rooms {
			r.Close()
		}
	}()

	// goroutine 观测：每秒采样，跑 seconds 秒。
	start := runtime.NumGoroutine()
	samples := []int{start}
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		tick := time.NewTicker(1 * time.Second)
		defer tick.Stop()
		endAt := time.After(time.Duration(seconds) * time.Second)
		for {
			select {
			case <-tick.C:
				samples = append(samples, runtime.NumGoroutine())
			case <-endAt:
				close(done)
				return
			}
		}
	}()
	<-done
	wg.Wait()
	runtime.GC()
	end := runtime.NumGoroutine()

	min, max := samples[0], samples[0]
	for _, s := range samples {
		if s < min {
			min = s
		}
		if s > max {
			max = s
		}
	}
	t.Logf("A6.3 10桌×%ds 并发 soak：goroutine start=%d end=%d min=%d max=%d samples=%v",
		seconds, start, end, min, max, samples)

	// 无 panic = 走到这里（bot 自对局异常会 panic）。goroutine 平稳：
	// 结束值相对起始不应暴涨（泄漏会单调增长到很高）。
	if end > start*2+20 {
		t.Errorf("goroutine 疑似泄漏：start=%d end=%d", start, end)
	}
	if max > start*3+40 {
		t.Errorf("goroutine 峰值过高（疑似泄漏/堆积）：start=%d max=%d", start, max)
	}
}

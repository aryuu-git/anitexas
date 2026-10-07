package room

import (
	"path/filepath"
	"testing"
	"time"

	"anitexas/backend/internal/model"
	"anitexas/backend/internal/store"
)

// 本文件是「min-raise 拉锯不收敛」病理的回归网：
// 两强 bot 面对下注无条件再加注时，每次 +BB 线性推进，深筹码下一手牌可打上千动作
//（实测 60s+ 不收敛）。修复 = BotParams.MaxRaises：每街每 bot 面对下注的再加注封顶，
// 超出降级为跟注/全下/弃牌决策（room.botAct 计数，换街/换手重置）。

// botFacingBetSnapshot 造「面对下注、强牌、深筹码」的 bot 视角快照：
// 座位 1 行动，本轮已投 2，最高注 4（欠 2），大盲 2——正是拉锯最坏情形的起点。
func botFacingBetSnapshot() model.SnapshotPayload {
	strong := model.CardData{
		ID: 1, Title: "强牌甲", Score: 9, Bucket: 10, Year: 2020,
		Elements: []model.Element{{Class: 3, Value: "羁绊"}},
	}
	strong2 := model.CardData{
		ID: 2, Title: "强牌乙", Score: 9, Bucket: 10, Year: 2021,
		Elements: []model.Element{{Class: 3, Value: "羁绊"}},
	}
	return model.SnapshotPayload{
		Phase:      model.PhasePreflop,
		TurnSeat:   1,
		CurrentBet: 4,
		BigBlind:   2,
		MySeat:     1,
		MyCards:    []model.CardData{strong, strong2},
		Seats: []model.SeatState{
			{Seat: 0, Nick: "甲", Chips: 100000, Bet: 4},
			{Seat: 1, Nick: "乙", Chips: 100000, Bet: 2},
			{Seat: 2, Nick: "丙", Chips: 100000, Bet: 4},
		},
	}
}

// TestBotRaiseCapPerStreet 决策级：强牌面对下注，首个再加注放行、达上限降级跟注、
// MaxRaises=0 不限次（测试可放开）。
func TestBotRaiseCapPerStreet(t *testing.T) {
	s := botFacingBetSnapshot()
	p := DefaultBotParams()
	p.CallThreshold = 0 // 封顶后降级路径不弃牌，便于断言精确到跟注

	if act, ok := botAction(s, 1, p, 0); !ok || act.Type != model.ActRaise {
		t.Fatalf("首个再加注应放行: %+v ok=%v", act, ok)
	}
	if act, ok := botAction(s, 1, p, 1); !ok || act.Type != model.ActCall {
		t.Fatalf("达 MaxRaises 后应降级跟注: %+v ok=%v", act, ok)
	}
	if act, ok := botAction(s, 1, p, 99); !ok || act.Type != model.ActCall {
		t.Fatalf("超上限任意次数均应跟注: %+v ok=%v", act, ok)
	}

	p.MaxRaises = 0 // 0 = 不限
	if act, ok := botAction(s, 1, p, 99); !ok || act.Type != model.ActRaise {
		t.Fatalf("MaxRaises=0 应不限再加注: %+v ok=%v", act, ok)
	}
}

// TestBotRaiseWarConverges 收敛级：RaiseThreshold=0（只要合法就再加注）是最坏拉锯；
// 封顶后一手牌必须有界收敛——raise 次数 ≤ 每街每座位上限 × 街数，且在时限内 settled。
func TestBotRaiseWarConverges(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "war.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	// 清理顺序（LIFO）：先关房间再关库，避免收尾日志噪音。
	t.Cleanup(func() { _ = st.Close() })

	cfg := model.RoomConfig{
		AutoReveal:   false,
		Seats:        3,
		SmallBlind:   1,
		BigBlind:     2,
		Chips:        100000, // 深筹码：无封顶时线性 +2 拉锯可达数万动作
		RevealRate:   0,
		DeckStrategy: "stratified",
		DeckSize:     78,
	}
	bp := DefaultBotParams()
	bp.DelayMs = 0
	bp.RaiseThreshold = 0 // 恒命中：合法就再加注（最坏情形）
	bp.CallThreshold = 0
	bp.MaxCallRatio = 1
	// MaxRaises 保持默认 1：每街每 bot 最多一次面对下注的再加注。

	r := NewRoom("room-war", "WAR01", "harness", cfg, 0 /* 关超时自动动作 */, bp,
		synthLibrary(2000), st, nil, Timing{})
	t.Cleanup(r.Close) // LIFO：先于 st.Close 执行

	obs := newObsLink()
	for i := 1; i < 3; i++ {
		occ := &occupant{nick: BotNick(i), isBot: true, ready: true}
		// 只在座位 1 挂观测链路：全桌广播每帧只录一份（挂多座重复计数）。
		if i == 1 {
			occ.link = obs
		}
		r.seats[i] = occ
	}
	if _, err := r.Join("harness"); err != nil {
		t.Fatalf("harness 入座: %v", err)
	}

	const hands = 2
	if err := r.Ready(0); err != nil {
		t.Fatalf("首手 ready: %v", err)
	}
	for h := 1; h <= hands; h++ {
		settled := false
		raises, bets, acted := 0, 0, 0
		for !settled {
			select {
			case raw := <-obs.ch:
				env, err := model.DecodeEnvelope(raw)
				if err != nil {
					t.Fatalf("第 %d 手解信封: %v", h, err)
				}
				switch env.T {
				case model.TypeActed:
					acted++
					var ap model.ActedPayload
					if err := env.Decode(&ap); err != nil {
						t.Fatalf("第 %d 手解 acted: %v", h, err)
					}
					switch ap.Type {
					case model.ActRaise:
						raises++
					case model.ActBet:
						bets++
					}
				case model.TypeError:
					t.Fatalf("第 %d 手出现 error 下行: %s", h, string(env.P))
				case model.TypeSettled:
					settled = true
				}
				// 快速失败护栏：无封顶拉锯会瞬间爆表（预修复此处即红）。
				if acted > 500 {
					t.Fatalf("第 %d 手动作数爆表（%d）：下注轮拉锯不收敛", h, acted)
				}
			case <-time.After(30 * time.Second):
				t.Fatalf("第 %d 手 30s 未 settled（拉锯挂桌）", h)
			}
		}
		// 有界断言：每街每 bot 最多 MaxRaises(=1) 次再加注，4 条街；开注每街至多 1 次。
		if maxRaises := 1 * cfg.Seats * 4; raises > maxRaises {
			t.Errorf("第 %d 手 raise=%d 超出封顶上限 %d（%d 座 × 1 次/街 × 4 街）", h, raises, maxRaises, cfg.Seats)
		}
		if bets > 4 {
			t.Errorf("第 %d 手 bet=%d 超出每街一次开注的上限 4", h, bets)
		}
		if h < hands {
			if err := r.Ready(0); err != nil {
				t.Fatalf("第 %d 手后 ready: %v", h, err)
			}
		}
	}
}

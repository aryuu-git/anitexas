package room

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"

	"github.com/google/uuid"

	"anitexas/backend/internal/engine"
	"anitexas/backend/internal/model"
	"anitexas/backend/internal/store"
)

// ManagerOptions 是大厅/建桌的全局参数（来自 config）。
type ManagerOptions struct {
	// RoomDefaults 是建房默认配置（ROOM_DEFAULT_*）。
	RoomDefaults model.RoomConfig
	// TurnTimeoutSeconds 是下注倒计时（TURN_TIMEOUT_SECONDS，映射 game.Config.TurnTimeoutMs）。
	TurnTimeoutSeconds int
	// Bot 是 bot 启发式参数（可配）。
	Bot BotParams
	// Timing 是房间节奏参数（NEXT_HAND_DELAY_SECONDS / DISCONNECT_GRACE_SECONDS /
	// IDLE_ROOM_TTL_MINUTES / MAX_REBUYS 等，见 Timing）。
	Timing Timing
}

// Manager 是大厅（§4.3 lobby）：创建 / 列表 / 加入。v1 不做匹配，靠房间码（D9）。
type Manager struct {
	mu    sync.Mutex
	rooms map[string]*Room

	st      *store.Store
	opts    ManagerOptions
	library []engine.Card
}

// NewManager 建大厅：从 cards 表载入卡池 library（启动时已由 store.LoadCardsFromJSON 灌入）。
func NewManager(st *store.Store, opts ManagerOptions) (*Manager, error) {
	records, err := st.AllCards()
	if err != nil {
		return nil, fmt.Errorf("载入卡池: %w", err)
	}
	if len(records) == 0 {
		return nil, fmt.Errorf("卡池为空，请检查 CARDS_PATH 产物与 cards 表")
	}
	library := make([]engine.Card, 0, len(records))
	for _, c := range records {
		library = append(library, toEngineCard(c))
	}
	return &Manager{
		rooms:   make(map[string]*Room),
		st:      st,
		opts:    opts,
		library: library,
	}, nil
}

// CreateRoom 建房：生成 6 位房间码（避开易混字符，撞库重试）并落 rooms 行。
func (m *Manager) CreateRoom(cfg model.RoomConfig, host string) (*Room, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	code, err := m.newCodeLocked()
	if err != nil {
		return nil, err
	}
	id := uuid.NewString()
	r := NewRoom(id, code, host, cfg, m.opts.TurnTimeoutSeconds, m.opts.Bot,
		m.library, m.st, m.remove, m.opts.Timing)
	if err := m.st.CreateRoom(model.RoomRecord{
		ID: id, Code: code, Config: mustJSON(cfg),
		Status: model.StatusWaiting, CreatedAt: model.Now(),
	}); err != nil {
		return nil, fmt.Errorf("落房间行: %w", err)
	}
	m.rooms[code] = r
	return r, nil
}

// Get 按房间码取房。
func (m *Manager) Get(code string) (*Room, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rooms[code]
	return r, ok
}

// List 返回全部在桌房间（REST 房间列表）。
func (m *Manager) List() []Summary {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Summary, 0, len(m.rooms))
	for _, r := range m.rooms {
		out = append(out, r.Summary())
	}
	return out
}

// Close 优雅退出：停全部对局循环（库由 cmd/server 收尾关闭）。
func (m *Manager) Close() {
	m.mu.Lock()
	rooms := make([]*Room, 0, len(m.rooms))
	for _, r := range m.rooms {
		rooms = append(rooms, r)
	}
	m.rooms = make(map[string]*Room)
	m.mu.Unlock()
	for _, r := range rooms {
		r.Close()
	}
}

// remove 是房间解散回调（摘除大厅索引）。
func (m *Manager) remove(r *Room) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if cur, ok := m.rooms[r.Code()]; ok && cur == r {
		delete(m.rooms, r.Code())
	}
	slog.Info("房间已解散", "code", r.Code())
}

// newCodeLocked 生成不撞库的房间码（内存索引 + rooms 表唯一约束双查）。
func (m *Manager) newCodeLocked() (string, error) {
	for attempt := 0; attempt < 32; attempt++ {
		code := NewCode()
		if _, ok := m.rooms[code]; ok {
			continue
		}
		if _, err := m.st.GetRoomByCode(code); err == nil {
			continue // 历史房间用过同码（rooms.code UNIQUE），再抽
		}
		return code, nil
	}
	return "", fmt.Errorf("房间码生成失败（32 次撞码）")
}

// toEngineCard 把 cards 行映射为规则引擎牌（要素结构逐字段同构）。
func toEngineCard(c model.CardRecord) engine.Card {
	els := make([]engine.Element, 0, len(c.Elements))
	for _, e := range c.Elements {
		els = append(els, engine.Element{Class: e.Class, Value: e.Value})
	}
	return engine.Card{
		ID: c.ID, Title: c.Title, Score: c.Score,
		Bucket: c.Bucket, Year: c.Year, Votes: c.Votes, Elements: els,
	}
}

// mustJSON 序列化配置（结构体无不可序列化字段，失败属编程错误）。
func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic("room: 配置序列化失败: " + err.Error())
	}
	return string(b)
}

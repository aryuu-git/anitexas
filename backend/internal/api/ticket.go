package api

import (
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
)

// ErrBadTicket 是无效/过期的 WS 入场券。
var ErrBadTicket = errors.New("入场券无效或已过期")

// ErrTicketInUse 是入场券被活跃连接占用（防顶号）：同 ticket 在原连接存活期间
// 不可再次核销；原连接断开后 Release 清占用，TTL 内仍可重连核销（A4.3）。
var ErrTicketInUse = errors.New("入场券已被活跃连接占用")

// ticket 是一次性 WS 入场券的绑定内容（D9 鉴权从简：房间码 + 昵称 + ticket）。
type ticket struct {
	RoomCode string
	Seat     int
	Nick     string
	Expires  time.Time
	// active 表示已核销且被活跃 WS 连接占用（防顶号）；连接断开由 Release 清除。
	active bool
}

// TicketStore 管理 WS 入场券：REST join 签发、WS join 核销。
//
// 注（取舍）：蓝图 §4.4 写「一次性」，实现为 TTL 内同绑定可重复核销——
// 断线重连时客户端原样重发 join（同 ticket）做快照恢复（A4.3），
// 严格一次性会把重连挡在门外；TTL + roomCode/nick/seat 三元绑定仍防长期盗用。
// 防顶号（ticket_in_use）：核销绑定连接，活跃连接占用期间同 ticket 再核销拒绝；
// 原连接断开（Release）后 TTL 内仍可核销，兼顾重连与顶号防护。
type TicketStore struct {
	mu     sync.Mutex
	ttl    time.Duration
	tickets map[string]ticket
}

// NewTicketStore 建券仓；ttl 为入场券有效期（建议 2 分钟）。
func NewTicketStore(ttl time.Duration) *TicketStore {
	return &TicketStore{ttl: ttl, tickets: make(map[string]ticket)}
}

// Issue 签发一张入场券，返回券码。
func (s *TicketStore) Issue(roomCode string, seat int, nick string) string {
	code := uuid.NewString()
	s.mu.Lock()
	defer s.mu.Unlock()
	// 顺手清理过期券，防表膨胀。
	now := time.Now()
	for k, t := range s.tickets {
		if now.After(t.Expires) {
			delete(s.tickets, k)
		}
	}
	s.tickets[code] = ticket{RoomCode: roomCode, Seat: seat, Nick: nick, Expires: now.Add(s.ttl)}
	return code
}

// Consume 核销入场券：未过期且绑定一致即通过，并标记为「被活跃连接占用」（防顶号）。
// 占用期间同 ticket 再核销返回 ErrTicketInUse；连接断开后经 Release 释放，
// TTL 内可重复核销（断线重连，见类型注释）。
func (s *TicketStore) Consume(code, roomCode, nick string) (seat int, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tickets[code]
	if !ok {
		return -1, ErrBadTicket
	}
	if time.Now().After(t.Expires) {
		delete(s.tickets, code)
		return -1, ErrBadTicket
	}
	if t.RoomCode != roomCode || t.Nick != nick {
		return -1, ErrBadTicket
	}
	if t.active {
		return -1, ErrTicketInUse // 原连接仍活跃：同 ticket 不可顶号再入
	}
	t.active = true
	s.tickets[code] = t
	return t.Seat, nil
}

// Release 释放入场券的连接占用（WS 连接断开时调用）：清除 active 标记，
// 券在 TTL 内仍可重连核销（保持断线重连能力，A4.3）。
func (s *TicketStore) Release(code string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t, ok := s.tickets[code]; ok {
		t.active = false
		s.tickets[code] = t
	}
}

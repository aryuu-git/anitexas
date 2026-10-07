package api

import (
	"errors"
	"testing"
	"time"

	"anitexas/backend/internal/model"
)

// TestTicketAntiHijack 防顶号（ticket_in_use）：核销绑定连接，活跃连接占用期间同 ticket
// 再核销拒绝；原连接断开（Release）后 TTL 内仍可核销（保持断线重连能力，A4.3）。
func TestTicketAntiHijack(t *testing.T) {
	s := NewTicketStore(2 * time.Minute)
	code := s.Issue("ROOM01", 3, "alice")

	// 首次核销成功并占用连接。
	seat, err := s.Consume(code, "ROOM01", "alice")
	if err != nil || seat != 3 {
		t.Fatalf("首次核销 = %d, %v; want 3, nil", seat, err)
	}

	// 顶号：原连接仍活跃时同 ticket 再核销 -> ticket_in_use。
	if _, err := s.Consume(code, "ROOM01", "alice"); !errors.Is(err, ErrTicketInUse) {
		t.Fatalf("活跃占用期间再核销应 ErrTicketInUse, got %v", err)
	}
	// 错误码常量与契约逐字一致（api 层据此映射下行 error.code）。
	if model.CodeTicketInUse != "ticket_in_use" {
		t.Fatalf("ticket_in_use 错误码与契约不符: %q", model.CodeTicketInUse)
	}

	// 原连接断开（Release）后 TTL 内可重连核销。
	s.Release(code)
	if seat, err := s.Consume(code, "ROOM01", "alice"); err != nil || seat != 3 {
		t.Fatalf("断开后重连核销 = %d, %v; want 3, nil", seat, err)
	}

	// 重连占用后再次顶号仍拒绝（占用语义随连接走，不因重连而失效）。
	if _, err := s.Consume(code, "ROOM01", "alice"); !errors.Is(err, ErrTicketInUse) {
		t.Fatalf("重连占用期间再核销应 ErrTicketInUse, got %v", err)
	}
}

// TestTicketBinding 绑定三元组校验：roomCode/nick 不符与未知券一律 bad_ticket。
func TestTicketBinding(t *testing.T) {
	s := NewTicketStore(2 * time.Minute)
	code := s.Issue("ROOM01", 0, "alice")

	if _, err := s.Consume(code, "ROOM02", "alice"); !errors.Is(err, ErrBadTicket) {
		t.Fatalf("roomCode 不符应 ErrBadTicket, got %v", err)
	}
	if _, err := s.Consume(code, "ROOM01", "bob"); !errors.Is(err, ErrBadTicket) {
		t.Fatalf("nick 不符应 ErrBadTicket, got %v", err)
	}
	if _, err := s.Consume("no-such-ticket", "ROOM01", "alice"); !errors.Is(err, ErrBadTicket) {
		t.Fatalf("未知券应 ErrBadTicket, got %v", err)
	}
}

// TestTicketExpiry 过期券不可核销（TTL 边界）。
func TestTicketExpiry(t *testing.T) {
	s := NewTicketStore(10 * time.Millisecond)
	code := s.Issue("ROOM01", 0, "alice")
	time.Sleep(30 * time.Millisecond)
	if _, err := s.Consume(code, "ROOM01", "alice"); !errors.Is(err, ErrBadTicket) {
		t.Fatalf("过期券应 ErrBadTicket, got %v", err)
	}
}

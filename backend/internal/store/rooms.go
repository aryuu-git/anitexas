package store

import (
	"database/sql"
	"fmt"

	"anitexas/backend/internal/model"
)

// CreateRoom 落一行房间（建房即落库，便于审计与重启后对账）。
func (s *Store) CreateRoom(r model.RoomRecord) error {
	_, err := s.db.Exec(
		`INSERT INTO rooms (id, code, config, status, created_at) VALUES (?, ?, ?, ?, ?)`,
		r.ID, r.Code, r.Config, r.Status, r.CreatedAt)
	if err != nil {
		return fmt.Errorf("insert room %s: %w", r.Code, err)
	}
	return nil
}

// GetRoomByCode 按房间码取房间。
func (s *Store) GetRoomByCode(code string) (model.RoomRecord, error) {
	row := s.db.QueryRow(
		`SELECT id, code, config, status, created_at FROM rooms WHERE code = ?`, code)
	return scanRoom(row)
}

// ListRooms 返回全部房间（按创建时间倒序）。
func (s *Store) ListRooms() ([]model.RoomRecord, error) {
	rows, err := s.db.Query(
		`SELECT id, code, config, status, created_at FROM rooms ORDER BY created_at DESC, code`)
	if err != nil {
		return nil, fmt.Errorf("list rooms: %w", err)
	}
	defer rows.Close()
	var out []model.RoomRecord
	for rows.Next() {
		r, err := scanRoom(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// UpdateRoomStatus 更新房间状态（waiting / playing / closed，解散即 closed）。
func (s *Store) UpdateRoomStatus(id, status string) error {
	res, err := s.db.Exec(`UPDATE rooms SET status = ? WHERE id = ?`, status, id)
	if err != nil {
		return fmt.Errorf("update room status: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("room %s not found", id)
	}
	return nil
}

// scanRoom 扫一行 rooms。
func scanRoom(row interface{ Scan(...any) error }) (model.RoomRecord, error) {
	var r model.RoomRecord
	err := row.Scan(&r.ID, &r.Code, &r.Config, &r.Status, &r.CreatedAt)
	if err == sql.ErrNoRows {
		return r, fmt.Errorf("room not found")
	}
	if err != nil {
		return r, fmt.Errorf("scan room: %w", err)
	}
	return r, nil
}

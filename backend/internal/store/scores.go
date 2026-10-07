package store

import (
	"fmt"

	"anitexas/backend/internal/model"
)

// UpsertScore 记一席的双账本（筹码 + 积分，§1.4）：无则插、有则覆盖。
func (s *Store) UpsertScore(sc model.ScoreRecord) error {
	if sc.UpdatedAt == "" {
		sc.UpdatedAt = model.Now()
	}
	_, err := s.db.Exec(
		`INSERT INTO scores (room_id, seat, chips, points, updated_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (room_id, seat) DO UPDATE SET
		   chips = excluded.chips, points = excluded.points, updated_at = excluded.updated_at`,
		sc.RoomID, sc.Seat, sc.Chips, sc.Points, sc.UpdatedAt)
	if err != nil {
		return fmt.Errorf("upsert score: %w", err)
	}
	return nil
}

// GetScore 取一席的账本。
func (s *Store) GetScore(roomID string, seat int) (model.ScoreRecord, error) {
	row := s.db.QueryRow(
		`SELECT room_id, seat, chips, points, updated_at FROM scores WHERE room_id = ? AND seat = ?`,
		roomID, seat)
	var sc model.ScoreRecord
	if err := row.Scan(&sc.RoomID, &sc.Seat, &sc.Chips, &sc.Points, &sc.UpdatedAt); err != nil {
		return sc, fmt.Errorf("get score: %w", err)
	}
	return sc, nil
}

// ListScores 按房间列出全部座位账本（seat 升序）。
func (s *Store) ListScores(roomID string) ([]model.ScoreRecord, error) {
	rows, err := s.db.Query(
		`SELECT room_id, seat, chips, points, updated_at FROM scores WHERE room_id = ? ORDER BY seat`,
		roomID)
	if err != nil {
		return nil, fmt.Errorf("list scores: %w", err)
	}
	defer rows.Close()
	var out []model.ScoreRecord
	for rows.Next() {
		var sc model.ScoreRecord
		if err := rows.Scan(&sc.RoomID, &sc.Seat, &sc.Chips, &sc.Points, &sc.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan score: %w", err)
		}
		out = append(out, sc)
	}
	return out, rows.Err()
}

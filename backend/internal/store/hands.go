package store

import (
	"database/sql"
	"fmt"

	"anitexas/backend/internal/model"
)

// CreateHand 开一手牌：落牌池（deck JSON）与房间内序号，返回自增 id。
func (s *Store) CreateHand(h model.HandRecord) (int64, error) {
	res, err := s.db.Exec(
		`INSERT INTO hands (room_id, seq, deck, community, result, started_at, ended_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		h.RoomID, h.Seq, h.Deck, h.Community, h.Result, h.StartedAt, h.EndedAt)
	if err != nil {
		return 0, fmt.Errorf("insert hand: %w", err)
	}
	return res.LastInsertId()
}

// UpdateHandCommunity 更新公共牌（每街推进时落一次，断电也不丢进度）。
func (s *Store) UpdateHandCommunity(handID int64, community string) error {
	_, err := s.db.Exec(`UPDATE hands SET community = ? WHERE id = ?`, community, handID)
	if err != nil {
		return fmt.Errorf("update hand community: %w", err)
	}
	return nil
}

// FinishHand 收一手：落结算结果与结束时间。
func (s *Store) FinishHand(handID int64, result string) error {
	_, err := s.db.Exec(
		`UPDATE hands SET result = ?, ended_at = ? WHERE id = ?`,
		result, model.Now(), handID)
	if err != nil {
		return fmt.Errorf("finish hand: %w", err)
	}
	return nil
}

// DeleteHand 删一行未开局成功的半成品手牌行（beginHand 开局失败回滚用，room 死桌防护）。
// 只删无 result 的未收手行：已收手的审计行永不回滚。
func (s *Store) DeleteHand(handID int64) error {
	res, err := s.db.Exec(
		`DELETE FROM hands WHERE id = ? AND result = ''`, handID)
	if err != nil {
		return fmt.Errorf("delete hand: %w", err)
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return fmt.Errorf("delete hand: hand %d 不存在或已收手", handID)
	}
	return nil
}

// GetHand 按 id 取一手牌。
func (s *Store) GetHand(handID int64) (model.HandRecord, error) {
	row := s.db.QueryRow(
		`SELECT id, room_id, seq, deck, community, result, started_at, ended_at
		 FROM hands WHERE id = ?`, handID)
	return scanHand(row)
}

// ListHands 按房间列出全部手牌（seq 升序）。
func (s *Store) ListHands(roomID string) ([]model.HandRecord, error) {
	rows, err := s.db.Query(
		`SELECT id, room_id, seq, deck, community, result, started_at, ended_at
		 FROM hands WHERE room_id = ? ORDER BY seq`, roomID)
	if err != nil {
		return nil, fmt.Errorf("list hands: %w", err)
	}
	defer rows.Close()
	var out []model.HandRecord
	for rows.Next() {
		h, err := scanHand(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// AppendHandLog 一手一事务批量提交动作日志与揭示账（追加式，不更新不删除——
// 可回放一手牌，§4.5）。性能取舍：事件逐条落库改为按手攒批、单事务提交
// （WAL + synchronous=NORMAL 下省掉逐条提交开销）；审计语义不变，仍是完整追加账。
func (s *Store) AppendHandLog(handID int64, actions []model.ActionRecord, reveals []model.RevealLogRecord) error {
	if len(actions) == 0 && len(reveals) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin hand log: %w", err)
	}
	defer tx.Rollback()
	if len(actions) > 0 {
		stmt, err := tx.Prepare(
			`INSERT INTO actions (hand_id, seq, seat, type, amount, at) VALUES (?, ?, ?, ?, ?, ?)`)
		if err != nil {
			return fmt.Errorf("prepare action: %w", err)
		}
		for _, a := range actions {
			if _, err := stmt.Exec(handID, a.Seq, a.Seat, a.Type, a.Amount, a.At); err != nil {
				stmt.Close()
				return fmt.Errorf("append action: %w", err)
			}
		}
		stmt.Close()
	}
	if len(reveals) > 0 {
		stmt, err := tx.Prepare(
			`INSERT INTO reveal_log (hand_id, card_id, seat, scope, cost, at) VALUES (?, ?, ?, ?, ?, ?)`)
		if err != nil {
			return fmt.Errorf("prepare reveal: %w", err)
		}
		for _, r := range reveals {
			if _, err := stmt.Exec(handID, r.CardID, r.Seat, r.Scope, r.Cost, r.At); err != nil {
				stmt.Close()
				return fmt.Errorf("append reveal: %w", err)
			}
		}
		stmt.Close()
	}
	return tx.Commit()
}

// ListActions 按手牌列出动作日志（seq 升序 = 回放顺序）。
func (s *Store) ListActions(handID int64) ([]model.ActionRecord, error) {
	rows, err := s.db.Query(
		`SELECT id, hand_id, seq, seat, type, amount, at
		 FROM actions WHERE hand_id = ? ORDER BY seq`, handID)
	if err != nil {
		return nil, fmt.Errorf("list actions: %w", err)
	}
	defer rows.Close()
	var out []model.ActionRecord
	for rows.Next() {
		var a model.ActionRecord
		if err := rows.Scan(&a.ID, &a.HandID, &a.Seq, &a.Seat, &a.Type, &a.Amount, &a.At); err != nil {
			return nil, fmt.Errorf("scan action: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ListReveals 按手牌列出揭示账（落账顺序）。
func (s *Store) ListReveals(handID int64) ([]model.RevealLogRecord, error) {
	rows, err := s.db.Query(
		`SELECT id, hand_id, card_id, seat, scope, cost, at
		 FROM reveal_log WHERE hand_id = ? ORDER BY id`, handID)
	if err != nil {
		return nil, fmt.Errorf("list reveals: %w", err)
	}
	defer rows.Close()
	var out []model.RevealLogRecord
	for rows.Next() {
		var r model.RevealLogRecord
		if err := rows.Scan(&r.ID, &r.HandID, &r.CardID, &r.Seat, &r.Scope, &r.Cost, &r.At); err != nil {
			return nil, fmt.Errorf("scan reveal: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ReplayHand 取一手牌的完整回放包（deck + 公共牌 + 动作序列 + 揭示账）：
// 动作日志追加式设计的验收出口。
func (s *Store) ReplayHand(handID int64) (model.HandLog, error) {
	h, err := s.GetHand(handID)
	if err != nil {
		return model.HandLog{}, err
	}
	actions, err := s.ListActions(handID)
	if err != nil {
		return model.HandLog{}, err
	}
	reveals, err := s.ListReveals(handID)
	if err != nil {
		return model.HandLog{}, err
	}
	return model.HandLog{Hand: h, Actions: actions, Reveals: reveals}, nil
}

// scanHand 扫一行 hands。
func scanHand(row interface{ Scan(...any) error }) (model.HandRecord, error) {
	var h model.HandRecord
	err := row.Scan(&h.ID, &h.RoomID, &h.Seq, &h.Deck, &h.Community, &h.Result, &h.StartedAt, &h.EndedAt)
	if err == sql.ErrNoRows {
		return h, fmt.Errorf("hand not found")
	}
	if err != nil {
		return h, fmt.Errorf("scan hand: %w", err)
	}
	return h, nil
}

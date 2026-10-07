package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"

	"anitexas/backend/internal/model"
)

// LoadCardsFromJSON 启动时从 CARDS_PATH 载入卡池：整体替换 cards 表（卡池随发布包
// 版本化，替换式加载幂等可重复跑）。返回载入张数。
func (s *Store) LoadCardsFromJSON(path string) (int, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("read cards: %w", err)
	}
	var cards []model.CardRecord
	if err := json.Unmarshal(raw, &cards); err != nil {
		return 0, fmt.Errorf("parse cards json: %w", err)
	}
	if err := s.ReplaceCards(cards); err != nil {
		return 0, err
	}
	return len(cards), nil
}

// ReplaceCards 事务内整体替换卡池。
func (s *Store) ReplaceCards(cards []model.CardRecord) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin replace cards: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM cards`); err != nil {
		return fmt.Errorf("clear cards: %w", err)
	}
	stmt, err := tx.Prepare(
		`INSERT INTO cards (id, title, score, bucket, year, type, monogram, votes, elements, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare insert card: %w", err)
	}
	defer stmt.Close()
	now := model.Now()
	for _, c := range cards {
		els, err := json.Marshal(c.Elements)
		if err != nil {
			return fmt.Errorf("marshal elements of card %d: %w", c.ID, err)
		}
		if _, err := stmt.Exec(c.ID, c.Title, c.Score, c.Bucket, c.Year, c.Type, c.Monogram, c.Votes, string(els), now); err != nil {
			return fmt.Errorf("insert card %d: %w", c.ID, err)
		}
	}
	return tx.Commit()
}

// GetCard 按 id 取一张牌（完整记录；L1 展示层裁剪由 api 负责）。
func (s *Store) GetCard(id int64) (model.CardRecord, error) {
	row := s.db.QueryRow(
		`SELECT id, title, score, bucket, year, type, monogram, votes, elements, updated_at
		 FROM cards WHERE id = ?`, id)
	return scanCard(row)
}

// AllCards 返回全部卡牌（room 建牌池的 library 输入）。
func (s *Store) AllCards() ([]model.CardRecord, error) {
	rows, err := s.db.Query(
		`SELECT id, title, score, bucket, year, type, monogram, votes, elements, updated_at
		 FROM cards ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("list cards: %w", err)
	}
	defer rows.Close()
	var out []model.CardRecord
	for rows.Next() {
		c, err := scanCard(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// CountCards 返回卡池张数（启动自检用）。
func (s *Store) CountCards() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM cards`).Scan(&n)
	return n, err
}

// scanCard 扫一行 cards。
func scanCard(row interface{ Scan(...any) error }) (model.CardRecord, error) {
	var c model.CardRecord
	var els string
	err := row.Scan(&c.ID, &c.Title, &c.Score, &c.Bucket, &c.Year, &c.Type, &c.Monogram, &c.Votes, &els, &c.UpdatedAt)
	if err == sql.ErrNoRows {
		return c, fmt.Errorf("card not found")
	}
	if err != nil {
		return c, fmt.Errorf("scan card: %w", err)
	}
	if els != "" {
		if err := json.Unmarshal([]byte(els), &c.Elements); err != nil {
			return c, fmt.Errorf("parse elements of card %d: %w", c.ID, err)
		}
	}
	return c, nil
}

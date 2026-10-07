// Package store 是 SQLite（WAL）访问层：cards/rooms/hands/actions/reveal_log/scores
// 六表（architecture.md §4.5）。牌局过程只落「动作日志 + 结果」，
// 一手牌可由 actions 回放重建（ReplayHand）。
package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // 纯 Go SQLite 驱动（D8：单机部署不用外部数据库）
)

// Store 是六表的统一入口。单连接池：SQLite pragma 是连接级的，
// 单进程单写者场景保持一条连接可让 WAL/busy_timeout 稳定生效（与 karuta 同惯例）。
type Store struct {
	db *sql.DB
}

// Open 打开（或创建）SQLite 库：WAL 模式、外键约束、忙等待，并建齐六表。
func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create db dir: %w", err)
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	// 单连接池：pragma 为连接级设置，单写者进程用单连接保证一致生效。
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		// WAL 下的标准配置：提交不逐条 fsync，由 checkpoint 收敛刷盘。
		"PRAGMA synchronous=NORMAL",
		"PRAGMA foreign_keys=ON",
		"PRAGMA busy_timeout=5000",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("%s: %w", pragma, err)
		}
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

// migrate 建表（幂等）。表名与列名逐字对齐 architecture.md §4.5。
func (s *Store) migrate() error {
	schema := []string{
		`CREATE TABLE IF NOT EXISTS cards (
			id INTEGER PRIMARY KEY,
			title TEXT NOT NULL,
			score REAL NOT NULL,
			bucket REAL NOT NULL,
			year INTEGER NOT NULL,
			type TEXT NOT NULL DEFAULT '',
			monogram TEXT NOT NULL DEFAULT '',
			votes INTEGER NOT NULL DEFAULT 0,
			elements TEXT NOT NULL DEFAULT '[]',
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS rooms (
			id TEXT PRIMARY KEY,
			code TEXT NOT NULL UNIQUE,
			config TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS hands (
			id INTEGER PRIMARY KEY,
			room_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			deck TEXT NOT NULL,
			community TEXT NOT NULL DEFAULT '[]',
			result TEXT NOT NULL DEFAULT '',
			started_at TEXT NOT NULL,
			ended_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS actions (
			id INTEGER PRIMARY KEY,
			hand_id INTEGER NOT NULL,
			seq INTEGER NOT NULL,
			seat INTEGER NOT NULL,
			type TEXT NOT NULL,
			amount INTEGER NOT NULL DEFAULT 0,
			at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS reveal_log (
			id INTEGER PRIMARY KEY,
			hand_id INTEGER NOT NULL,
			card_id INTEGER NOT NULL,
			seat INTEGER NOT NULL,
			scope TEXT NOT NULL,
			cost INTEGER NOT NULL DEFAULT 0,
			at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS scores (
			room_id TEXT NOT NULL,
			seat INTEGER NOT NULL,
			chips INTEGER NOT NULL DEFAULT 0,
			points INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (room_id, seat)
		)`,
		// 回放与账本查询的覆盖索引（按手牌取动作/揭示序列）。
		`CREATE INDEX IF NOT EXISTS idx_actions_hand ON actions (hand_id, seq)`,
		`CREATE INDEX IF NOT EXISTS idx_reveal_hand ON reveal_log (hand_id, id)`,
		`CREATE INDEX IF NOT EXISTS idx_hands_room ON hands (room_id, seq)`,
	}
	for _, ddl := range schema {
		if _, err := s.db.Exec(ddl); err != nil {
			return fmt.Errorf("exec schema: %w", err)
		}
	}
	// 旧库兼容：CREATE TABLE IF NOT EXISTS 不会改动已存在的表，历史库缺 cards.votes 需显式补列
	// （否则后续 ReplaceCards 的含 votes 的 INSERT 会报「no column named votes」）。
	if err := s.ensureColumn("cards", "votes", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	return nil
}

// ensureColumn 幂等补列：用 PRAGMA table_info 探测列是否存在，缺则 ALTER TABLE 添加
// （SQLite 无 ADD COLUMN IF NOT EXISTS）。table/column/decl 均为代码内常量，无注入面。
func (s *Store) ensureColumn(table, column, decl string) error {
	rows, err := s.db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return fmt.Errorf("pragma table_info %s: %w", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			cid       int
			name      string
			ctype     string
			notnull   int
			dfltValue sql.NullString
			pk        int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk); err != nil {
			return fmt.Errorf("scan table_info %s: %w", table, err)
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if _, err := s.db.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` ` + decl); err != nil {
		return fmt.Errorf("alter %s add column %s: %w", table, column, err)
	}
	return nil
}

// Close 关闭数据库（优雅退出收尾）。
func (s *Store) Close() error {
	return s.db.Close()
}

// DB 暴露底层连接（仅测试与诊断用）。
func (s *Store) DB() *sql.DB {
	return s.db
}

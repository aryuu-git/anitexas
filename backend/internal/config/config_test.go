package config

import (
	"path/filepath"
	"strings"
	"testing"
)

// anitexas.env.example 的全部环境变量名（部署契约逐字对齐，改名即破坏部署）。
var envKeys = []string{
	"APP_ENV", "BIND_ADDR", "PORT", "LOG_LEVEL", "CORS_ALLOWED_ORIGINS",
	"DATA_DIR", "DB_PATH", "CARDS_PATH",
	"ROOM_DEFAULT_AUTO_REVEAL", "ROOM_DEFAULT_SEATS", "ROOM_DEFAULT_SMALL_BLIND",
	"ROOM_DEFAULT_BIG_BLIND", "ROOM_DEFAULT_CHIPS", "ROOM_DEFAULT_DECK_STRATEGY",
	"ROOM_DEFAULT_DECK_SIZE", "ROOM_DEFAULT_MIN_VOTES", "ROOM_DEFAULT_REVEAL_FEE", "TURN_TIMEOUT_SECONDS",
	"NEXT_HAND_DELAY_SECONDS", "DISCONNECT_GRACE_SECONDS", "IDLE_ROOM_TTL_MINUTES", "MAX_REBUYS",
}

// clearEnv 把契约里的环境变量全部置空（t.Setenv 恢复原值），隔离宿主环境。
func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range envKeys {
		t.Setenv(k, "")
	}
}

// TestLoadDefaults 默认值：D13 同机共存——PORT 8081、BIND_ADDR 127.0.0.1；
// ROOM_DEFAULT_REVEAL_FEE v1 默认 0（D4）。
func TestLoadDefaults(t *testing.T) {
	clearEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Port != 8081 {
		t.Errorf("PORT 默认 = %d, want 8081（D13）", cfg.Port)
	}
	if cfg.BindAddr != "127.0.0.1" {
		t.Errorf("BIND_ADDR 默认 = %q, want 127.0.0.1（D13）", cfg.BindAddr)
	}
	if cfg.Environment != EnvDev || cfg.LogLevel != LevelInfo {
		t.Errorf("APP_ENV/LOG_LEVEL 默认 = %q/%q, want dev/info", cfg.Environment, cfg.LogLevel)
	}
	if len(cfg.CORSOrigins) != 0 {
		t.Errorf("CORS_ALLOWED_ORIGINS 默认应为空, got %v", cfg.CORSOrigins)
	}
	if cfg.DataDir != "data" || cfg.DBPath != filepath.Join("data", "anitexas.db") ||
		cfg.CardsPath != filepath.Join("data", "cards.json") {
		t.Errorf("路径默认 = %q/%q/%q", cfg.DataDir, cfg.DBPath, cfg.CardsPath)
	}
	d := cfg.RoomDefaults
	if d.AutoReveal || d.Seats != 4 || d.SmallBlind != 1 || d.BigBlind != 2 ||
		d.Chips != 200 || d.DeckStrategy != DeckStratified || d.DeckSize != 78 || d.RevealRate != 0 ||
		d.MinVotes != 2000 {
		t.Errorf("ROOM_DEFAULT_* 默认 = %+v", d)
	}
	if cfg.TurnTimeoutSeconds != 30 {
		t.Errorf("TURN_TIMEOUT_SECONDS 默认 = %d, want 30", cfg.TurnTimeoutSeconds)
	}
	if cfg.NextHandDelaySeconds != 8 || cfg.DisconnectGraceSeconds != 300 ||
		cfg.IdleRoomTTLMinutes != 10 || cfg.MaxRebuys != 3 {
		t.Errorf("节奏参数默认 = %d/%d/%d/%d, want 8/300/10/3",
			cfg.NextHandDelaySeconds, cfg.DisconnectGraceSeconds, cfg.IdleRoomTTLMinutes, cfg.MaxRebuys)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("默认配置应通过 Validate(), got %v", err)
	}
}

// TestLoadFromEnvExample 逐字按 anitexas.env.example 的值解析（部署模板即契约）。
func TestLoadFromEnvExample(t *testing.T) {
	clearEnv(t)
	example := map[string]string{
		"APP_ENV": "production", "BIND_ADDR": "127.0.0.1", "PORT": "8081", "LOG_LEVEL": "info",
		"CORS_ALLOWED_ORIGINS": "",
		"DATA_DIR":             "/data/anitexas", "DB_PATH": "/data/anitexas/anitexas.db",
		"CARDS_PATH": "/opt/anitexas/current/cards.json",
		"ROOM_DEFAULT_AUTO_REVEAL": "false", "ROOM_DEFAULT_SEATS": "4",
		"ROOM_DEFAULT_SMALL_BLIND": "1", "ROOM_DEFAULT_BIG_BLIND": "2", "ROOM_DEFAULT_CHIPS": "200",
		"ROOM_DEFAULT_DECK_STRATEGY": "stratified", "ROOM_DEFAULT_DECK_SIZE": "78",
		"ROOM_DEFAULT_MIN_VOTES": "2000",
		"ROOM_DEFAULT_REVEAL_FEE": "0", "TURN_TIMEOUT_SECONDS": "30",
		"NEXT_HAND_DELAY_SECONDS": "8", "DISCONNECT_GRACE_SECONDS": "300",
		"IDLE_ROOM_TTL_MINUTES": "10", "MAX_REBUYS": "3",
	}
	for k, v := range example {
		t.Setenv(k, v)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Environment != EnvProduction || cfg.DataDir != "/data/anitexas" ||
		cfg.DBPath != "/data/anitexas/anitexas.db" || cfg.CardsPath != "/opt/anitexas/current/cards.json" {
		t.Errorf("解析结果 = %+v", cfg)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("部署模板配置应通过 Validate(), got %v", err)
	}
}

// TestLoadOverrides 全部环境变量均生效：含逗号分隔 CORS、大小写归一。
func TestLoadOverrides(t *testing.T) {
	clearEnv(t)
	t.Setenv("APP_ENV", "Staging")
	t.Setenv("BIND_ADDR", "0.0.0.0")
	t.Setenv("PORT", "9000")
	t.Setenv("LOG_LEVEL", "WARN")
	t.Setenv("CORS_ALLOWED_ORIGINS", "https://a.example, https://b.example ,")
	t.Setenv("DATA_DIR", "/srv/d")
	t.Setenv("DB_PATH", "/srv/d/g.db")
	t.Setenv("CARDS_PATH", "/srv/c/cards.json")
	t.Setenv("ROOM_DEFAULT_AUTO_REVEAL", "true")
	t.Setenv("ROOM_DEFAULT_SEATS", "6")
	t.Setenv("ROOM_DEFAULT_SMALL_BLIND", "5")
	t.Setenv("ROOM_DEFAULT_BIG_BLIND", "10")
	t.Setenv("ROOM_DEFAULT_CHIPS", "1000")
	t.Setenv("ROOM_DEFAULT_DECK_STRATEGY", "THEME")
	t.Setenv("ROOM_DEFAULT_DECK_SIZE", "104")
	t.Setenv("ROOM_DEFAULT_MIN_VOTES", "500")
	t.Setenv("ROOM_DEFAULT_REVEAL_FEE", "2")
	t.Setenv("TURN_TIMEOUT_SECONDS", "45")
	t.Setenv("NEXT_HAND_DELAY_SECONDS", "15")
	t.Setenv("DISCONNECT_GRACE_SECONDS", "60")
	t.Setenv("IDLE_ROOM_TTL_MINUTES", "30")
	t.Setenv("MAX_REBUYS", "5")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Environment != EnvStaging || cfg.LogLevel != LevelWarn {
		t.Errorf("大小写归一失败: %q/%q", cfg.Environment, cfg.LogLevel)
	}
	if cfg.Port != 9000 || cfg.BindAddr != "0.0.0.0" {
		t.Errorf("端口/地址 = %d/%q", cfg.Port, cfg.BindAddr)
	}
	if len(cfg.CORSOrigins) != 2 || cfg.CORSOrigins[0] != "https://a.example" || cfg.CORSOrigins[1] != "https://b.example" {
		t.Errorf("CORS 列表 = %v", cfg.CORSOrigins)
	}
	d := cfg.RoomDefaults
	if !d.AutoReveal || d.DeckStrategy != DeckTheme || d.Seats != 6 ||
		d.SmallBlind != 5 || d.BigBlind != 10 || d.Chips != 1000 || d.DeckSize != 104 ||
		d.RevealRate != 2 || d.MinVotes != 500 {
		t.Errorf("ROOM_DEFAULT_* = %+v", d)
	}
	if cfg.TurnTimeoutSeconds != 45 {
		t.Errorf("TURN_TIMEOUT_SECONDS = %d", cfg.TurnTimeoutSeconds)
	}
	if cfg.NextHandDelaySeconds != 15 || cfg.DisconnectGraceSeconds != 60 ||
		cfg.IdleRoomTTLMinutes != 30 || cfg.MaxRebuys != 5 {
		t.Errorf("节奏参数 = %d/%d/%d/%d, want 15/60/30/5",
			cfg.NextHandDelaySeconds, cfg.DisconnectGraceSeconds, cfg.IdleRoomTTLMinutes, cfg.MaxRebuys)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() = %v", err)
	}
}

// TestLoadRejectsNonInteger 数值型环境变量解析失败必须报错（拒绝静默回退）。
func TestLoadRejectsNonInteger(t *testing.T) {
	for _, key := range []string{"PORT", "ROOM_DEFAULT_SEATS", "ROOM_DEFAULT_SMALL_BLIND",
		"ROOM_DEFAULT_BIG_BLIND", "ROOM_DEFAULT_CHIPS", "ROOM_DEFAULT_DECK_SIZE",
		"ROOM_DEFAULT_MIN_VOTES",
		"ROOM_DEFAULT_REVEAL_FEE", "TURN_TIMEOUT_SECONDS",
		"NEXT_HAND_DELAY_SECONDS", "DISCONNECT_GRACE_SECONDS", "IDLE_ROOM_TTL_MINUTES", "MAX_REBUYS"} {
		t.Run(key, func(t *testing.T) {
			clearEnv(t)
			t.Setenv(key, "abc")
			if _, err := Load(); err == nil {
				t.Fatalf("Load() 应拒绝 %s=abc", key)
			} else if !strings.Contains(err.Error(), key) {
				t.Errorf("错误信息应含变量名 %s, got %v", key, err)
			}
		})
	}
}

// TestLoadRejectsNonBool 布尔型环境变量拒绝非布尔值（D14：ROOM_DEFAULT_AUTO_REVEAL）。
func TestLoadRejectsNonBool(t *testing.T) {
	for _, v := range []string{"yes", "no", "on", "2"} {
		t.Run(v, func(t *testing.T) {
			clearEnv(t)
			t.Setenv("ROOM_DEFAULT_AUTO_REVEAL", v)
			if _, err := Load(); err == nil {
				t.Fatalf("Load() 应拒绝 ROOM_DEFAULT_AUTO_REVEAL=%q", v)
			} else if !strings.Contains(err.Error(), "ROOM_DEFAULT_AUTO_REVEAL") {
				t.Errorf("错误信息应含变量名, got %v", err)
			}
		})
	}
	// ParseBool 合法形应放行。
	clearEnv(t)
	t.Setenv("ROOM_DEFAULT_AUTO_REVEAL", "1")
	cfg, err := Load()
	if err != nil || !cfg.RoomDefaults.AutoReveal {
		t.Fatalf("ROOM_DEFAULT_AUTO_REVEAL=1 应解析为 true: %v %+v", err, cfg)
	}
}

// TestValidateRejections 校验拒绝例：端口范围、路径非空、ROOM_DEFAULT 枚举及其余边界。
func TestValidateRejections(t *testing.T) {
	ok := func() *Config {
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		return cfg
	}
	cases := []struct {
		name  string
		mut   func(*Config)
		wantE string
	}{
		{"端口为 0", func(c *Config) { c.Port = 0 }, "PORT"},
		{"端口超上限", func(c *Config) { c.Port = 70000 }, "PORT"},
		{"DATA_DIR 为空", func(c *Config) { c.DataDir = " " }, "DATA_DIR"},
		{"DB_PATH 为空", func(c *Config) { c.DBPath = "" }, "DB_PATH"},
		{"CARDS_PATH 为空", func(c *Config) { c.CardsPath = "" }, "CARDS_PATH"},
		{"牌池策略枚举非法", func(c *Config) { c.RoomDefaults.DeckStrategy = "random" }, "deckStrategy"},
		{"座位数太少", func(c *Config) { c.RoomDefaults.Seats = 1 }, "seats"},
		{"座位数太多", func(c *Config) { c.RoomDefaults.Seats = 11 }, "seats"},
		{"小盲非正", func(c *Config) { c.RoomDefaults.SmallBlind = 0 }, "smallBlind"},
		{"大盲小于小盲", func(c *Config) { c.RoomDefaults.BigBlind = 1; c.RoomDefaults.SmallBlind = 2 }, "bigBlind"},
		{"初始筹码非正", func(c *Config) { c.RoomDefaults.Chips = 0 }, "chips"},
		{"牌池太小", func(c *Config) { c.RoomDefaults.DeckSize = 51 }, "deckSize"},
		{"牌池太大", func(c *Config) { c.RoomDefaults.DeckSize = 105 }, "deckSize"},
		{"揭示费率为负", func(c *Config) { c.RoomDefaults.RevealRate = -1 }, "revealRate"},
		{"标注数下限为负", func(c *Config) { c.RoomDefaults.MinVotes = -1 }, "minVotes"},
		{"倒计时非正", func(c *Config) { c.TurnTimeoutSeconds = 0 }, "TURN_TIMEOUT_SECONDS"},
		{"下一手延迟为负", func(c *Config) { c.NextHandDelaySeconds = -1 }, "NEXT_HAND_DELAY_SECONDS"},
		{"断线宽限为负", func(c *Config) { c.DisconnectGraceSeconds = -1 }, "DISCONNECT_GRACE_SECONDS"},
		{"空闲房 TTL 为负", func(c *Config) { c.IdleRoomTTLMinutes = -1 }, "IDLE_ROOM_TTL_MINUTES"},
		{"重买上限为负", func(c *Config) { c.MaxRebuys = -1 }, "MAX_REBUYS"},
		{"APP_ENV 枚举非法", func(c *Config) { c.Environment = "prod" }, "APP_ENV"},
		{"LOG_LEVEL 枚举非法", func(c *Config) { c.LogLevel = "verbose" }, "LOG_LEVEL"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearEnv(t)
			cfg := ok()
			tc.mut(cfg)
			err := cfg.Validate()
			if err == nil {
				t.Fatalf("Validate() 应拒绝 %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.wantE) {
				t.Errorf("错误信息应含 %q, got %v", tc.wantE, err)
			}
		})
	}
}

// TestTimingZeroAccepted 节奏参数零值合法（0 = 该机制关闭/不限次，语义见各字段注释）。
func TestTimingZeroAccepted(t *testing.T) {
	clearEnv(t)
	t.Setenv("NEXT_HAND_DELAY_SECONDS", "0")
	t.Setenv("DISCONNECT_GRACE_SECONDS", "0")
	t.Setenv("IDLE_ROOM_TTL_MINUTES", "0")
	t.Setenv("MAX_REBUYS", "0")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.NextHandDelaySeconds != 0 || cfg.DisconnectGraceSeconds != 0 ||
		cfg.IdleRoomTTLMinutes != 0 || cfg.MaxRebuys != 0 {
		t.Errorf("零值解析 = %d/%d/%d/%d", cfg.NextHandDelaySeconds,
			cfg.DisconnectGraceSeconds, cfg.IdleRoomTTLMinutes, cfg.MaxRebuys)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("零值节奏参数应通过 Validate(), got %v", err)
	}
}

// TestListenAddr 监听地址拼装（nginx 反代目标）。
func TestListenAddr(t *testing.T) {
	clearEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got := cfg.ListenAddr(); got != "127.0.0.1:8081" {
		t.Errorf("ListenAddr() = %q, want 127.0.0.1:8081", got)
	}
}

// TestRoomDefaultsShape ROOM_DEFAULT_* 字段与 game.Config 的映射源逐字对应
// （映射实现见 room 包；这里钉死字段名/语义，防映射时错位）。
func TestRoomDefaultsShape(t *testing.T) {
	clearEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	d := cfg.RoomDefaults
	if d.Chips != 200 || d.RevealRate != 0 {
		t.Errorf("Chips/RevealRate 映射源 = %d/%d, want 200/0（StartChips/RevealFee）", d.Chips, d.RevealRate)
	}
	// game.Config 需要的 TurnTimeoutMs 由秒数换算（room 侧完成）。
	if cfg.TurnTimeoutSeconds*1000 != 30000 {
		t.Errorf("TurnTimeoutMs 换算源 = %d", cfg.TurnTimeoutSeconds)
	}
}

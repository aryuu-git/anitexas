// Package config 读取并校验服务配置。环境变量名与取值域与
// deploy/anitexas.env.example 逐字对齐（部署契约，禁改名）。
// 默认值面向本机开发；线上以 systemd EnvironmentFile 全量覆盖。
package config

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"anitexas/backend/internal/model"
)

// 枚举取值域（与 anitexas.env.example 注释一致，Validate 逐一校验）。
const (
	EnvProduction = "production"
	EnvStaging    = "staging"
	EnvDev        = "dev"

	DeckStratified = "stratified"
	DeckTheme      = "theme"

	LevelDebug = "debug"
	LevelInfo  = "info"
	LevelWarn  = "warn"
	LevelError = "error"
)

// 数值边界（规则书参数表 + 蓝图 deck.go；越界即拒绝启动）。
const (
	minPort     = 1
	maxPort     = 65535
	minSeats    = 2
	maxSeats    = 10
	minDeckSize = 52
	maxDeckSize = 104
)

// Config 是服务全量配置。
type Config struct {
	Environment string   // APP_ENV：production / staging / dev
	BindAddr    string   // BIND_ADDR：监听地址（D13 默认 127.0.0.1，nginx 反代）
	Port        int      // PORT：监听端口（D13 默认 8081，karuta 占 8080）
	LogLevel    string   // LOG_LEVEL：debug / info / warn / error
	CORSOrigins []string // CORS_ALLOWED_ORIGINS：逗号分隔；空 = 同源部署不发 CORS 头

	DataDir   string // DATA_DIR：可写数据根（SQLite 与备份父目录）
	DBPath    string // DB_PATH：SQLite 库文件（WAL）
	CardsPath string // CARDS_PATH：卡池产物 cards.json

	// RoomDefaults 是建房默认配置（ROOM_DEFAULT_*；建房时可按房覆盖）。
	// AutoReveal 对应 ROOM_DEFAULT_AUTO_REVEAL（D14 两模式合并：
	// true = 开局全揭示，false（默认）= 隐藏可揭示）。
	RoomDefaults model.RoomConfig

	// TurnTimeoutSeconds 是下注回合倒计时秒数（TURN_TIMEOUT_SECONDS）。
	// 映射 game.Config.TurnTimeoutMs 时乘 1000（映射实现见 room 包，
	// 保持 config 包零 game 依赖、独立可测）。
	TurnTimeoutSeconds int

	// NextHandDelaySeconds 是下一手自动开局延迟秒数（NEXT_HAND_DELAY_SECONDS；
	// 0 = 关闭下一手排程）。映射 room.Timing.NextHandDelay。
	NextHandDelaySeconds int
	// DisconnectGraceSeconds 是断线回收宽限秒数（DISCONNECT_GRACE_SECONDS；
	// 0 = 不回收断线座位）。映射 room.Timing.DisconnectGrace。
	DisconnectGraceSeconds int
	// IdleRoomTTLMinutes 是空闲房回收分钟数（IDLE_ROOM_TTL_MINUTES；
	// 0 = 不回收空闲房）。映射 room.Timing.IdleTTL。
	IdleRoomTTLMinutes int
	// MaxRebuys 是每座位重买上限（MAX_REBUYS；0 = 不限次，注入 game.Config.MaxRebuys）。
	MaxRebuys int
}

// Load 从环境变量读取配置。数值解析失败立即报错（不静默回退默认），
// 取值域校验统一走 Validate。
func Load() (*Config, error) {
	env := getEnv("APP_ENV", EnvDev)
	port, err := getEnvInt("PORT", 8081)
	if err != nil {
		return nil, err
	}
	seats, err := getEnvInt("ROOM_DEFAULT_SEATS", 4)
	if err != nil {
		return nil, err
	}
	smallBlind, err := getEnvInt("ROOM_DEFAULT_SMALL_BLIND", 1)
	if err != nil {
		return nil, err
	}
	bigBlind, err := getEnvInt("ROOM_DEFAULT_BIG_BLIND", 2)
	if err != nil {
		return nil, err
	}
	chips, err := getEnvInt("ROOM_DEFAULT_CHIPS", 200)
	if err != nil {
		return nil, err
	}
	deckSize, err := getEnvInt("ROOM_DEFAULT_DECK_SIZE", 78)
	if err != nil {
		return nil, err
	}
	// 作品标注数下限默认 2000：只收「有人认识」的作品（评分人数 ≥ 2000）；0 = 不过滤。
	minVotes, err := getEnvInt("ROOM_DEFAULT_MIN_VOTES", 2000)
	if err != nil {
		return nil, err
	}
	revealFee, err := getEnvInt("ROOM_DEFAULT_REVEAL_FEE", 0) // v1 恒 0：只记账不扣分（D4）
	if err != nil {
		return nil, err
	}
	turnTimeout, err := getEnvInt("TURN_TIMEOUT_SECONDS", 30)
	if err != nil {
		return nil, err
	}
	nextHandDelay, err := getEnvInt("NEXT_HAND_DELAY_SECONDS", 8)
	if err != nil {
		return nil, err
	}
	disconnectGrace, err := getEnvInt("DISCONNECT_GRACE_SECONDS", 300)
	if err != nil {
		return nil, err
	}
	idleRoomTTL, err := getEnvInt("IDLE_ROOM_TTL_MINUTES", 10)
	if err != nil {
		return nil, err
	}
	maxRebuys, err := getEnvInt("MAX_REBUYS", 3)
	if err != nil {
		return nil, err
	}

	dataDir := getEnv("DATA_DIR", "data")

	// D14：ROOM_DEFAULT_MODE（hidden/explicit）废弃，改为布尔开关 ROOM_DEFAULT_AUTO_REVEAL。
	autoReveal, err := getEnvBool("ROOM_DEFAULT_AUTO_REVEAL", false)
	if err != nil {
		return nil, err
	}
	// 房主聊天开关（frontend-contract §1），默认开放。
	chatEnabled, err := getEnvBool("ROOM_DEFAULT_CHAT_ENABLED", true)
	if err != nil {
		return nil, err
	}

	return &Config{
		Environment: strings.ToLower(env),
		BindAddr:    getEnv("BIND_ADDR", "127.0.0.1"), // D13：同机共存默认只听本地
		Port:        port,
		LogLevel:    strings.ToLower(getEnv("LOG_LEVEL", LevelInfo)),
		CORSOrigins: splitList(getEnv("CORS_ALLOWED_ORIGINS", "")),

		DataDir:   dataDir,
		DBPath:    getEnv("DB_PATH", filepath.Join(dataDir, "anitexas.db")),
		CardsPath: getEnv("CARDS_PATH", filepath.Join(dataDir, "cards.json")),

		RoomDefaults: model.RoomConfig{
			AutoReveal:   autoReveal,
			Seats:        seats,
			SmallBlind:   smallBlind,
			BigBlind:     bigBlind,
			Chips:        chips,
			RevealRate:   revealFee,
			DeckStrategy: strings.ToLower(getEnv("ROOM_DEFAULT_DECK_STRATEGY", DeckStratified)),
			DeckSize:     deckSize,
			MinVotes:     minVotes,
			ChatEnabled:  chatEnabled,
		},

		TurnTimeoutSeconds: turnTimeout,

		NextHandDelaySeconds:   nextHandDelay,
		DisconnectGraceSeconds: disconnectGrace,
		IdleRoomTTLMinutes:     idleRoomTTL,
		MaxRebuys:              maxRebuys,
	}, nil
}

// Validate 启动校验：端口范围、路径非空、ROOM_DEFAULT 枚举合法（及其余数值边界）。
// 任一不合法直接拒绝启动，避免带着坏配置上线。
func (c *Config) Validate() error {
	switch c.Environment {
	case EnvProduction, EnvStaging, EnvDev:
	default:
		return fmt.Errorf("APP_ENV=%q 非法，应为 production / staging / dev", c.Environment)
	}
	if c.Port < minPort || c.Port > maxPort {
		return fmt.Errorf("PORT=%d 超出范围 [%d,%d]", c.Port, minPort, maxPort)
	}
	switch c.LogLevel {
	case LevelDebug, LevelInfo, LevelWarn, LevelError:
	default:
		return fmt.Errorf("LOG_LEVEL=%q 非法，应为 debug / info / warn / error", c.LogLevel)
	}
	if strings.TrimSpace(c.DataDir) == "" {
		return fmt.Errorf("DATA_DIR 不可为空")
	}
	if strings.TrimSpace(c.DBPath) == "" {
		return fmt.Errorf("DB_PATH 不可为空")
	}
	if strings.TrimSpace(c.CardsPath) == "" {
		return fmt.Errorf("CARDS_PATH 不可为空")
	}

	d := c.RoomDefaults
	if err := ValidateRoomDefaults(d); err != nil {
		return err
	}
	if c.TurnTimeoutSeconds <= 0 {
		return fmt.Errorf("TURN_TIMEOUT_SECONDS=%d 必须为正", c.TurnTimeoutSeconds)
	}
	if c.NextHandDelaySeconds < 0 {
		return fmt.Errorf("NEXT_HAND_DELAY_SECONDS=%d 不得为负（0 = 关闭下一手自动开局）", c.NextHandDelaySeconds)
	}
	if c.DisconnectGraceSeconds < 0 {
		return fmt.Errorf("DISCONNECT_GRACE_SECONDS=%d 不得为负（0 = 不回收断线座位）", c.DisconnectGraceSeconds)
	}
	if c.IdleRoomTTLMinutes < 0 {
		return fmt.Errorf("IDLE_ROOM_TTL_MINUTES=%d 不得为负（0 = 不回收空闲房）", c.IdleRoomTTLMinutes)
	}
	if c.MaxRebuys < 0 {
		return fmt.Errorf("MAX_REBUYS=%d 不得为负（0 = 不限次）", c.MaxRebuys)
	}
	return nil
}

// ValidateRoomDefaults 校验建房配置的取值域（ROOM_DEFAULT_* 与 REST 建房覆盖共用同一套规则）。
// AutoReveal 是布尔开关（D14），无取值域可校验——非法字符串在解析阶段已被拒绝。
func ValidateRoomDefaults(d model.RoomConfig) error {
	switch d.DeckStrategy {
	case DeckStratified, DeckTheme:
	default:
		return fmt.Errorf("deckStrategy=%q 非法，应为 stratified / theme", d.DeckStrategy)
	}
	if d.Seats < minSeats || d.Seats > maxSeats {
		return fmt.Errorf("seats=%d 超出范围 [%d,%d]", d.Seats, minSeats, maxSeats)
	}
	if d.SmallBlind <= 0 || d.BigBlind <= 0 {
		return fmt.Errorf("smallBlind/bigBlind 必须为正（got %d/%d）", d.SmallBlind, d.BigBlind)
	}
	if d.BigBlind < d.SmallBlind {
		return fmt.Errorf("bigBlind=%d 不得小于 smallBlind=%d", d.BigBlind, d.SmallBlind)
	}
	if d.Chips <= 0 {
		return fmt.Errorf("chips=%d 必须为正", d.Chips)
	}
	if d.DeckSize < minDeckSize || d.DeckSize > maxDeckSize {
		return fmt.Errorf("deckSize=%d 超出范围 [%d,%d]（规则书参数表）", d.DeckSize, minDeckSize, maxDeckSize)
	}
	if d.RevealRate < 0 {
		return fmt.Errorf("revealRate=%d 不得为负（v1 恒 0，D4）", d.RevealRate)
	}
	if d.MinVotes < 0 {
		return fmt.Errorf("minVotes=%d 不得为负（0 = 不过滤）", d.MinVotes)
	}
	// 主题过滤项校验（frontend-contract §3）：携带时校验 kind 枚举 + value 长度；
	// theme 策略未带过滤项则不过滤（等价全库），不强卡（ROOM_DEFAULT 可裸配 theme）。
	if d.ThemeFilter != nil {
		switch d.ThemeFilter.Kind {
		case model.ThemeCompany, model.ThemeYear, model.ThemeTag:
		default:
			return fmt.Errorf("themeFilter.kind=%q 非法，应为 company / year / tag", d.ThemeFilter.Kind)
		}
		if n := len([]rune(strings.TrimSpace(d.ThemeFilter.Value))); n == 0 || n > model.ThemeValueMaxLen {
			return fmt.Errorf("themeFilter.value 长度非法（应 1–%d 字）", model.ThemeValueMaxLen)
		}
	}
	return nil
}

// ListenAddr 返回监听地址（host:port）。
func (c *Config) ListenAddr() string {
	return net.JoinHostPort(c.BindAddr, strconv.Itoa(c.Port))
}

// getEnv 读取字符串环境变量：未设置或空白时回退默认。
func getEnv(key, defaultVal string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return defaultVal
}

// getEnvInt 读取整型环境变量；设置但非整数时报错（拒绝静默吞掉配置笔误）。
func getEnvInt(key string, defaultVal int) (int, error) {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return defaultVal, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("环境变量 %s=%q 不是整数", key, v)
	}
	return n, nil
}

// getEnvBool 读取布尔环境变量；设置但非布尔值时报错（true/false 及 1/0 等
// strconv.ParseBool 合法形，"yes" 等拒绝）。
func getEnvBool(key string, defaultVal bool) (bool, error) {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return defaultVal, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("环境变量 %s=%q 不是布尔值", key, v)
	}
	return b, nil
}

// splitList 拆分逗号分隔列表，去空白、去空项。
func splitList(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

package model

import "time"

// 以下为 SQLite 六表（architecture.md §4.5）的行类型：
// cards / rooms / hands / actions / reveal_log /scores。
// 时间列统一存 RFC3339 UTC 字符串（SQLite 无原生时间类型，字符串可读可比）。

// CardRecord 是 cards 表一行，同时也是卡池产物 cards.json 的结构
// （字段与管线产物逐字一致：id/title/score/bucket/year/type/monogram/elements）。
// UpdatedAt 为落库时间，不来自产物。
type CardRecord struct {
	ID       int64   `json:"id"`
	Title    string  `json:"title"`
	Score    float64 `json:"score"`
	Bucket   float64 `json:"bucket"`
	Year     int     `json:"year"`
	Type     string  `json:"type"`
	Monogram string  `json:"monogram"`
	// Votes 是作品标注数（评分人数 = dump score_details 求和），供运行时按热度收池（RoomConfig.MinVotes）。
	Votes    int       `json:"votes"`
	Elements []Element `json:"elements"`
	// UpdatedAt RFC3339 落库时间；cards.json 产物不含此字段。
	UpdatedAt string `json:"-"`
}

// RoomRecord 是 rooms 表一行：id 为内部 id（uuid），code 为 6 位房间码，config 为建房配置 JSON。
type RoomRecord struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	Config    string `json:"config"` // RoomConfig 的 JSON 序列化
	Status    string `json:"status"` // waiting | playing | closed
	CreatedAt string `json:"createdAt"`
}

// 房间类型与开局策略（体验重构第二轮，docs/experience-handoff/05 §3）。
const (
	RoomKindFriend   = "friend"
	RoomKindPractice = "practice"

	BotPolicyOff  = "off"  // 朋友房默认：空座等待朋友，绝不自动补机器人
	BotPolicyFill = "fill" // 练习房：创建时按座位补齐机器人

	NextHandManual    = "manual"    // 朋友房默认：房主手动开下一手
	NextHandAutomatic = "automatic" // 练习房可选：服务端排程自动续局
)

// RoomConfig 是建房配置的持久化形态（rooms.config JSON；与 REST 建房参数同形）。
type RoomConfig struct {
	// AutoReveal（D14 两模式合并）：true = 开局全揭示（原 explicit），
	// false（默认）= 隐藏可揭示（原 hidden）。
	AutoReveal   bool   `json:"autoReveal"`
	Seats        int    `json:"seats"`        // 座位数
	SmallBlind   int    `json:"smallBlind"`   // 小盲
	BigBlind     int    `json:"bigBlind"`     // 大盲
	Chips        int    `json:"chips"`        // 初始筹码
	RevealRate   int    `json:"revealRate"`   // 揭示费率（v1 = 0，D4）
	DeckStrategy string `json:"deckStrategy"` // stratified | theme
	DeckSize     int    `json:"deckSize"`     // 单桌牌池规模（52–104）
	// MinVotes 是运行时作品标注数（评分人数）下限：仅 votes >= MinVotes 的卡入本桌牌池；
	// 0 = 不过滤（ROOM_DEFAULT_MIN_VOTES 默认 2000）。
	MinVotes int `json:"minVotes"`
	// ChatEnabled 是房主聊天开关（frontend-contract §1，默认 true）；false 时拒发 say。
	ChatEnabled bool `json:"chatEnabled"`
	// ThemeFilter 是主题牌池过滤项（deckStrategy=theme 时携带，frontend-contract §3）。
	ThemeFilter *ThemeFilter `json:"themeFilter,omitempty"`

	// ===== 第二轮房间策略（缺失字段按朋友房安全默认解释，绝不推导为自动开局）=====
	RoomKind         string `json:"roomKind"`         // friend | practice
	BotPolicy        string `json:"botPolicy"`        // off | fill
	TargetHumanCount int    `json:"targetHumanCount"` // 期望参局人数（含明确添加的机器人）
	NextHandPolicy   string `json:"nextHandPolicy"`   // manual | automatic
}

// NormalizeRoomConfig 把旧房间/缺省字段收敛到安全默认：朋友房、机器人关闭、
// 目标 2 人、手动续局。任何缺失字段都不得被解释成自动补机器人或自动开局。
func NormalizeRoomConfig(cfg RoomConfig) RoomConfig {
	if cfg.RoomKind != RoomKindPractice {
		cfg.RoomKind = RoomKindFriend
	}
	if cfg.RoomKind == RoomKindFriend {
		cfg.BotPolicy = BotPolicyOff
		cfg.NextHandPolicy = NextHandManual
	} else {
		if cfg.BotPolicy != BotPolicyOff {
			cfg.BotPolicy = BotPolicyFill
		}
		if cfg.NextHandPolicy != NextHandAutomatic {
			cfg.NextHandPolicy = NextHandManual
		}
	}
	if cfg.TargetHumanCount < 2 {
		cfg.TargetHumanCount = 2
	}
	if cfg.Seats > 0 && cfg.TargetHumanCount > cfg.Seats {
		cfg.TargetHumanCount = cfg.Seats
	}
	return cfg
}

// HandRecord 是 hands 表一行：一手牌的牌池、公共牌与结果（动作日志见 ActionRecord）。
type HandRecord struct {
	ID        int64  `json:"id"`
	RoomID    string `json:"roomId"`
	Seq       int    `json:"seq"`       // 房间内第几手
	Deck      string `json:"deck"`      // 本手牌池 JSON（[]engine.Card 形状，可回放）
	Community string `json:"community"` // 公共牌 JSON
	Result    string `json:"result"`    // 结算结果 JSON
	StartedAt string `json:"startedAt"`
	EndedAt   string `json:"endedAt"` // 未结束为空串
}

// ActionRecord 是 actions 表一行：动作日志追加式，一手牌可由动作序列回放重建（§4.5 注）。
type ActionRecord struct {
	ID     int64  `json:"id"`
	HandID int64  `json:"handId"`
	Seq    int    `json:"seq"` // 手内动作序号（1 起）
	Seat   int    `json:"seat"`
	Type   string `json:"type"`   // check|bet|call|raise|fold|allin
	Amount int    `json:"amount"` // 下行语义：本次实际投入增量（fold/check = 0）
	At     string `json:"at"`
}

// RevealLogRecord 是 reveal_log 表一行：揭示账本（扣分能力的落点，D4）。
type RevealLogRecord struct {
	ID     int64  `json:"id"`
	HandID int64  `json:"handId"`
	CardID int64  `json:"cardId"`
	Seat   int    `json:"seat"`
	Scope  string `json:"scope"` // private | public
	Cost   int    `json:"cost"`  // v1 恒 0，只记账（D4）
	At     string `json:"at"`
}

// ScoreRecord 是 scores 表一行：双账本（§1.4）——chips 筹码、points 积分。
type ScoreRecord struct {
	RoomID    string `json:"roomId"`
	Seat      int    `json:"seat"`
	Chips     int    `json:"chips"`
	Points    int    `json:"points"`
	UpdatedAt string `json:"updatedAt"`
}

// HandLog 是一手牌的完整回放包（deck + 公共牌 + 动作序列 + 揭示账），
// 动作日志追加式设计的验收出口：给定 HandLog 可重建整手牌过程。
type HandLog struct {
	Hand    HandRecord        `json:"hand"`
	Actions []ActionRecord    `json:"actions"`
	Reveals []RevealLogRecord `json:"reveals"`
}

// Now 返回当前时刻的 RFC3339 UTC 字符串（落库时间统一格式）。
func Now() string {
	return time.Now().UTC().Format(time.RFC3339)
}

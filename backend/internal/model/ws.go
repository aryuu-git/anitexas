// Package model 是传输与持久化共用类型：WS 信封与 §5 全部消息的 JSON 结构、
// SQLite 六表（§4.5）的行类型。JSON 字段名与 frontend/src/api/types.ts 逐字对齐
// （camelCase），前后端以本包为唯一 wire 契约。
package model

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"
)

// WS 消息类型名（§5 上行/下行清单，逐字对齐；resync 为前端扩展，语义见各处注释）。
const (
	// 上行（client -> server）
	TypeJoin   = "join"
	TypeReady  = "ready"
	TypeAction = "action"
	TypeReveal = "reveal"
	TypeLeave  = "leave"
	TypePing   = "ping"
	TypeResync = "resync" // 断线重连后请求快照修复（前端 types.ts 扩展）
	TypeEmote  = "emote"  // 表情（D15 互动扩展）：key 8 选 1，10 秒/座位冷却
	TypeSay    = "say"    // 聊天上行（与 emote 同构）：text ≤ ChatMaxLen，节流 ChatThrottleMs

	// 下行（server -> client）
	TypeSnapshot = "snapshot"
	TypeDealt    = "dealt"
	TypeFlop     = "flop"
	TypeTurn     = "turn"
	TypeRiver    = "river"
	TypeActed    = "acted"
	TypeRevealed = "revealed"
	TypeShowdown = "showdown"
	TypeSettled  = "settled"
	TypeEmoted   = "emoted" // 表情广播（D15）
	TypeSaid     = "said"   // 聊天广播（与 emoted 同构，seat + text）
	TypeSeedCommit = "seedCommit" // 可验证发牌固证：开局发牌前广播 SHA-256(seed)
	TypeSeedReveal = "seedReveal" // 摊牌揭示 seed（本地算哈希与固证比对即验证未篡改）
	TypeNextHand = "nextHand"     // 下一手自动开局时刻（settled 后房间排程；全员 ready 可提前）
	TypeReadied  = "readied"      // 玩家准备广播（每手重置；waiting 态座位标记展示）
	TypeError    = "error"
)

// 聊天上行约束（frontend-contract §1，与前端 ChatPanel 同限）。
const (
	ChatMaxLen    = 120             // text 去空白后 ≤ 120 字
	ChatThrottle  = 1500 * time.Millisecond // 节流窗口（客户端 1500ms/条，服务端同限校验）
)

// 聊天错误码（ErrorPayload.Code，frontend-contract §1）。
const (
	CodeChatDisabled = "chat_disabled" // 房主关聊天
	CodeChatTooLong  = "chat_too_long"  // 超长
)

// 对局/会话错误码（ErrorPayload.Code，与 frontend types.ts 注释逐字对齐）。
const (
	CodeRebuyExhausted = "rebuy_exhausted" // 重买次数用尽（MAX_REBUYS，达上限自动离席）
	CodeTicketInUse    = "ticket_in_use"   // ticket 被活跃连接占用（防顶号；断开后 TTL 内可重连）
)

// 主题牌池过滤维（frontend-contract §3，D11 主题池 = 过滤后再分层）。
const (
	ThemeCompany = "company" // 公司要素（engine.ClassStudio=2）值匹配
	ThemeYear    = "year"    // 年份（engine.ClassYear=4）匹配
	ThemeTag     = "tag"     // 标签（engine.ClassTag=3）包含
)

// ThemeFilter 是主题牌池过滤项（deckStrategy=theme 时携带）。value ≤ ThemeValueMaxLen 字。
type ThemeFilter struct {
	Kind  string `json:"kind"`  // company | year | tag
	Value string `json:"value"` // ≤20 字
}

// ThemeValueMaxLen 是 themeFilter.value 的长度上限（frontend-contract §3）。
const ThemeValueMaxLen = 20

// 上行 action.type 的取值（§5）。
const (
	ActCheck = "check"
	ActBet   = "bet"
	ActCall  = "call"
	ActRaise = "raise"
	ActFold  = "fold"
	ActAllin = "allin"
)

// 揭示范围（§1.3）：private 仅自己 / public 全桌广播。
const (
	ScopePrivate = "private"
	ScopePublic  = "public"
)

// 对局阶段（snapshot.phase）。
const (
	PhaseWaiting  = "waiting"
	PhasePreflop  = "preflop"
	PhaseFlop     = "flop"
	PhaseTurn     = "turn"
	PhaseRiver    = "river"
	PhaseShowdown = "showdown"
	PhaseSettled  = "settled"
)

// 桌模式（§1.2 的 hidden/explicit）已按 D14 合并为 AutoReveal 布尔：
// true = 开局全揭示，false（默认）= 隐藏可揭示。

// 房间状态（rooms.status）。
const (
	StatusWaiting = "waiting"
	StatusPlaying = "playing"
	StatusClosed  = "closed"
)

// Envelope 是统一消息信封（§5）：{ "t": 类型, "seq": 递增序号, "p": 载荷 }。
// seq 供客户端丢弃乱序旧事件；P 为原始 JSON，按 T 解到具体载荷类型。
type Envelope struct {
	T   string          `json:"t"`
	Seq int64           `json:"seq"`
	P   json.RawMessage `json:"p"`
}

// NewEnvelope 把任意载荷编成信封；payload 为 nil 时载荷为 {}（如 ready/ping）。
// payload 为 json.RawMessage / []byte 时按原始 JSON 字节透传（勿按 base64 编：
// json.Marshal 对裸 []byte 会编成 base64 字符串，房间广播的事件载荷是已序列化
// JSON 字节，须原样进 p）。
func NewEnvelope(t string, seq int64, payload any) (Envelope, error) {
	if payload == nil {
		payload = struct{}{}
	}
	var raw json.RawMessage
	switch v := payload.(type) {
	case json.RawMessage:
		raw = v
	case []byte:
		raw = json.RawMessage(v)
	default:
		b, err := json.Marshal(payload)
		if err != nil {
			return Envelope{}, err
		}
		raw = b
	}
	return Envelope{T: t, Seq: seq, P: raw}, nil
}

// Decode 把信封载荷解到具体类型。
func (e Envelope) Decode(payload any) error {
	if len(e.P) == 0 {
		e.P = json.RawMessage("{}")
	}
	return json.Unmarshal(e.P, payload)
}

// DecodeEnvelope 解一条原始 WS 消息为信封。
func DecodeEnvelope(data []byte) (Envelope, error) {
	var e Envelope
	err := json.Unmarshal(data, &e)
	return e, err
}

// ===== 上行载荷（§5 client -> server）=====

// JoinPayload 是 join 入座握手：ticket 由 REST POST /api/rooms/{code}/join 签发（一次性）。
type JoinPayload struct {
	RoomCode string `json:"roomCode"`
	Nick     string `json:"nick"`
	Ticket   string `json:"ticket"`
}

// ReadyPayload 是 ready 准备开局（空载荷）。
type ReadyPayload struct{}

// ActionPayload 是下注动作；金额单位为筹码，fold/check 不带金额。
type ActionPayload struct {
	Type   string `json:"type"`
	Amount int    `json:"amount,omitempty"`
}

// RevealPayload 是揭示动作：展开自己底牌（private）或当众翻公共牌（public，§1.3）。
type RevealPayload struct {
	CardID int64  `json:"cardId"`
	Scope  string `json:"scope"`
}

// LeavePayload 是离座（空载荷）。
type LeavePayload struct{}

// PingPayload 是心跳（空载荷）。
type PingPayload struct{}

// ResyncPayload 是断线重连后的快照修复请求（空载荷）。
type ResyncPayload struct{}

// EmoteKeys 是表情 key 白名单（D15：8 选 1，服务端校验）。
var EmoteKeys = []string{"clap", "smile", "wow", "think", "cry", "angry", "sweat", "love"}

// ValidEmote 判断表情 key 是否在白名单内。
func ValidEmote(key string) bool {
	for _, k := range EmoteKeys {
		if k == key {
			return true
		}
	}
	return false
}

// EmotePayload 是表情上行（D15）。
type EmotePayload struct {
	Key string `json:"key"`
}

// EmotedPayload 是表情广播下行（D15）。
type EmotedPayload struct {
	Seat int    `json:"seat"`
	Key  string `json:"key"`
}

// SayPayload 是聊天上行（frontend-contract §1，与 emote 同构）。
type SayPayload struct {
	Text string `json:"text"`
}

// SaidPayload 是聊天广播下行（全桌含发言者；与 emoted 同构，seat + text）。
type SaidPayload struct {
	Seat int    `json:"seat"`
	Text string `json:"text"`
}

// SeedCommitPayload 是可验证发牌固证下行：开局发牌前广播 SHA-256(seed) hex 小写。
type SeedCommitPayload struct {
	Sha256 string `json:"sha256"`
}

// SeedRevealPayload 是摊牌揭示 seed 下行：客户端本地算 SHA-256(seed) 与固证比对即验证未篡改。
type SeedRevealPayload struct {
	Seed string `json:"seed"`
}

// SeedCommitHex 计算固证哈希 = hex(SHA-256(seed 的 UTF-8 字节))，hex 小写
// （frontend-contract 编码约定：与前端 seed.ts 的 sha256Hex 逐字一致）。
func SeedCommitHex(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:])
}

// ===== 下行载荷（§5 server -> client）=====

// Element 是要素：Class 1监督 2公司 3标签 4年份 5原作类型（规则书 §2）。
type Element struct {
	Class int    `json:"class"`
	Value string `json:"value"`
}

// CardData 是牌面对象：L1 恒公开（id/名/评分/档位/年份/首字）；
// elements 仅在揭示后出现——hidden 模式下未揭示牌对象根本没有此字段（D7）。
type CardData struct {
	ID       int64     `json:"id"`
	Title    string    `json:"title"`
	Score    float64   `json:"score"`
	Bucket   float64   `json:"bucket"`
	Year     int       `json:"year"`
	Monogram string    `json:"monogram"`
	Elements []Element `json:"elements,omitempty"`
}

// SeatState 是座位公开状态。
type SeatState struct {
	Seat  int    `json:"seat"`
	Nick  string `json:"nick"`
	Chips int    `json:"chips"`
	// Points 是积分账（表现分，§1.4 双账本），由 scores 表维护。
	Points int  `json:"points"`
	Bet    int  `json:"bet"`     // 本轮已下注
	Folded bool `json:"folded"`  // 已弃牌
	Acted  bool `json:"acted"`   // 本轮是否已动作
	IsDealer bool `json:"isDealer"`
	// HoleCount 是底牌张数占位（他人只见「已发 N 张」，§5 dealt）。
	HoleCount int `json:"holeCount"`
	// Ready 是已准备（waiting 态各座位显示标记；每手重置，room 真源）。
	Ready bool `json:"ready"`
	// Rebuys 是重买次数（破产就地重买累计，达 MAX_REBUYS 自动离席）。
	Rebuys int `json:"rebuys"`
}

// BoxCard 是盒名单条目（D17：本手发牌盒公开名单；仅 L1 字段，不带 elements，D7）。
type BoxCard struct {
	ID     int64   `json:"id"`
	Title  string  `json:"title"`
	Score  float64 `json:"score"`
	Bucket float64 `json:"bucket"`
	Year   int     `json:"year"`
}

// PoolInfo 是牌池摘要（D11/D17）：策略 + 可选主题过滤 + 池大小 + 是否回退全库。
type PoolInfo struct {
	Strategy string       `json:"strategy"` // stratified | theme
	Theme    *ThemeFilter `json:"theme"`    // deckStrategy=theme 时的过滤项
	PoolSize int          `json:"poolSize"`
	// Fallback 是主题过滤过窄已回退全库（前端须房内显著提示）。
	Fallback bool `json:"fallback"`
}

// SnapshotPayload 是房间全量状态（加入、断线重连、快照修复时下发）。
type SnapshotPayload struct {
	RoomCode string `json:"roomCode"`
	// AutoReveal 是 D14 合并后的揭示开关：true = 开局全揭示（原 explicit），
	// false（默认）= 隐藏可揭示（原 hidden）。
	AutoReveal bool        `json:"autoReveal"`
	Phase      string      `json:"phase"` // waiting | preflop | flop | turn | river | showdown | settled
	HandSeq  int         `json:"handSeq"`
	Seats    []SeatState `json:"seats"`
	MySeat   int         `json:"mySeat"`
	MyCards  []CardData  `json:"myCards"`
	Community []CardData `json:"community"`
	Pot      int         `json:"pot"`
	CurrentBet int       `json:"currentBet"`
	TurnSeat int         `json:"turnSeat"` // 当前行动座位（-1 表示等待中）
	Deadline *int64      `json:"deadline"` // 行动倒计时截止时刻（epoch ms；null=无倒计时）
	SmallBlind int       `json:"smallBlind"`
	BigBlind   int       `json:"bigBlind"`
	// RevealRate 是揭示费率（v1 = 0，D4，只记账不扣分）。
	RevealRate int             `json:"revealRate"`
	Reveals    []RevealRecord  `json:"reveals"`
	// ChatEnabled 是房主聊天开关（roomConfig.chatEnabled，frontend-contract §1）；
	// false 时前端输入框置灰且不上行。
	ChatEnabled bool `json:"chatEnabled"`
	// SeedCommit 是本手发牌固证（frontend-contract §2，断线快照恢复后仍可验证）。
	// 新一手重置为新的固证；尚未开局为空串（序列化为 null）。
	SeedCommit *string `json:"seedCommit"`
	// Seq 是快照生成时最后事件序号基线：客户端丢弃 seq ≤ 该值的在途旧事件（消时序伪影）。
	Seq int64 `json:"seq"`
	// MinRaise 是当前最小加注增量：raise 的 target 须 ≥ currentBet + MinRaise（全下豁免）。
	MinRaise int `json:"minRaise"`
	// TurnMs 是本桌行动时限（毫秒）：倒计时总长，替代前端硬编码 30s。
	TurnMs int `json:"turnMs"`
	// Seed 是当前手 seed（摊牌后可见，之前 null）；与 SeedCommit 并存，断线后仍可验证。
	Seed *string `json:"seed"`
	// Box 是 D17 本手盒名单（公开名单，要素仍隐藏，不带 elements）。
	Box []BoxCard `json:"box"`
	// Pool 是本桌牌池摘要。
	Pool PoolInfo `json:"pool"`
}

// DealtPayload 是发牌：底牌只发给本人，他人只收到占位（cards 为空，张数见 SeatState.HoleCount）。
type DealtPayload struct {
	Seat  int        `json:"seat"`
	Cards []CardData `json:"cards"`
}

// CommunityPayload 是 flop/turn/river 公共牌亮出；turnSeat/deadline/minRaise 为可选的服务端权威扩展。
type CommunityPayload struct {
	Cards    []CardData `json:"cards"`
	TurnSeat *int       `json:"turnSeat,omitempty"`
	Deadline *int64     `json:"deadline,omitempty"`
	// MinRaise 是换街后的最小加注增量（服务端权威，缺省沿用上一值）。
	MinRaise *int `json:"minRaise,omitempty"`
}

// ActedPayload 是玩家动作回放；turnSeat/deadline/minRaise 为可选的服务端权威扩展。
type ActedPayload struct {
	Seat     int    `json:"seat"`
	Type     string `json:"type"`
	Amount   int    `json:"amount"`
	TurnSeat *int   `json:"turnSeat,omitempty"`
	Deadline *int64 `json:"deadline,omitempty"`
	// MinRaise 是动作生效（含其触发的推进）后的最小加注增量（缺省沿用上一值）。
	MinRaise *int `json:"minRaise,omitempty"`
}

// RevealRecord 是一条揭示记录（账本行的传输形态，落库见 RevealLogRecord）。
type RevealRecord struct {
	Seat   int    `json:"seat"`
	CardID int64  `json:"cardId"`
	Scope  string `json:"scope"`
	Cost   int    `json:"cost"`
}

// RevealedPayload 是揭示广播：此时要素才可见（含成本，供扣分记账展示，§1.3）。
type RevealedPayload struct {
	Seat     int       `json:"seat"`
	CardID   int64     `json:"cardId"`
	Scope    string    `json:"scope"`
	Cost     int       `json:"cost"`
	Elements []Element `json:"elements"`
}

// ShowdownHand 是一手摊牌：此时一切解密（D2）。
type ShowdownHand struct {
	Seat  int        `json:"seat"`
	Cards []CardData `json:"cards"`
	// Groups 是成组划分：每组是 cards 下标集合；散牌不在任何组。
	Groups   [][]int   `json:"groups"`
	Tier     int       `json:"tier"`
	Tiebreak []float64 `json:"tiebreak"`
}

// ShowdownPayload 是摊牌广播。
type ShowdownPayload struct {
	Hands []ShowdownHand `json:"hands"`
}

// PointsDetail 是积分明细（A5.4：含「揭示成本」行）。
type PointsDetail struct {
	HandScore  int `json:"handScore"`  // 牌型积分
	BondBonus  int `json:"bondBonus"`  // 羁绊加成
	RevealCost int `json:"revealCost"` // Σ揭示成本
}

// SettleRow 是结算一行：筹码盈亏 + 积分明细。
type SettleRow struct {
	Seat       int          `json:"seat"`
	ChipsDelta int          `json:"chipsDelta"`
	Points     PointsDetail `json:"points"`
}

// SettledPayload 是结算广播：rows 全员明细，potWins 为主/边池赢家赢得筹码。
type SettledPayload struct {
	Rows    []SettleRow   `json:"rows"`
	PotWins map[int]int   `json:"potWins"`
}

// NextHandPayload 是下一手自动开局时刻（settled 后房间排程；全员 ready 可提前）。
type NextHandPayload struct {
	// StartAt 是自动开局时刻（epoch ms，与 SnapshotPayload.Deadline 同口径）。
	StartAt int64 `json:"startAt"`
}

// ReadiedPayload 是玩家准备广播（每手重置；waiting 态座位标记展示）。
type ReadiedPayload struct {
	Seat int `json:"seat"`
}

// ErrorPayload 是非法动作回执：不得回显隐藏数据（D7）。
type ErrorPayload struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
}

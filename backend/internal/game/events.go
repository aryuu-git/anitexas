package game

import "anitexas/backend/internal/engine"

// 事件类型常量(dealt|flop|turn|river|acted|revealed|showdown|settled|error)。
const (
	EventDealt    = "dealt"
	EventFlop     = "flop"
	EventTurn     = "turn"
	EventRiver    = "river"
	EventActed    = "acted"
	EventRevealed = "revealed"
	EventShowdown = "showdown"
	EventSettled  = "settled"
	EventError    = "error"
)

// Event 是事件流的统一信封;Payload 为对应 *Payload 结构(直发 WS 用)。
type Event struct {
	Type    string
	Payload any
}

// WireElement 是要素的线上 JSON 形状(types.ts Element{class,value})。
// engine.Element 无 json tag(序列化为 {Class,Value}),下行一律经此转换(D7)。
type WireElement struct {
	Class int    `json:"class"`
	Value string `json:"value"`
}

// wireElements 把引擎要素转为线上形状(揭示/摊牌时才出现)。
func wireElements(els []engine.Element) []WireElement {
	if els == nil {
		return nil
	}
	out := make([]WireElement, len(els))
	for i, e := range els {
		out[i] = WireElement{Class: e.Class, Value: e.Value}
	}
	return out
}

// DealtPayload 是发牌事件:底牌只发给本人,他人只收「已发 N 张」占位(由 room 层脱敏路由)。
type DealtPayload struct {
	Seat  int        `json:"seat"`
	Cards []CardView `json:"cards"`
}

// CommunityPayload 是公共牌亮出事件(flop 3 张新牌/turn 1 张/river 1 张,追加语义;
// 全量快照以 Snapshot.community 为准)。turnSeat/deadline/minRaise 为服务端权威扩展(恒填):
// minRaise = 换街后的最小加注增量,前端据此算最小加注目标。
type CommunityPayload struct {
	Cards    []CardView `json:"cards"`
	TurnSeat *int       `json:"turnSeat,omitempty"`
	Deadline *int64     `json:"deadline,omitempty"`
	MinRaise *int       `json:"minRaise,omitempty"`
}

// ActedPayload 是玩家动作回放:Amount 为本次实际投入增量(check/fold/call 全下前为 0,
// call 为补齐差额、bet/raise 为目标本轮总投入的增量)。
// turnSeat/deadline/minRaise 为服务端权威扩展(恒填):minRaise = 动作生效(含其触发的
// 推进)后的最小加注增量,前端据此算最小加注目标。
type ActedPayload struct {
	Seat     int    `json:"seat"`
	Type     string `json:"type"`
	Amount   int    `json:"amount"`
	TurnSeat *int   `json:"turnSeat,omitempty"`
	Deadline *int64 `json:"deadline,omitempty"`
	MinRaise *int   `json:"minRaise,omitempty"`
}

// RevealRecord 是一条揭示记录(scope=private 仅本人可见,room 层按此路由)。
type RevealRecord struct {
	Seat   int    `json:"seat"`
	CardID int64  `json:"cardId"`
	Scope  string `json:"scope"`
	Cost   int    `json:"cost"`
}

// RevealedPayload 是揭示广播:elements 此时才下发(未揭示不进任何下行消息,D7)。
type RevealedPayload struct {
	Seat     int          `json:"seat"`
	CardID   int64        `json:"cardId"`
	Scope    string       `json:"scope"`
	Cost     int          `json:"cost"`
	Elements []WireElement `json:"elements"`
}

// ShowdownHand 是一家的摊牌:cards 为该玩家全部 7 张(2 底牌 + 5 公共,此时一切解密);
// groups 为成组划分(坐标系 = cards 下标,散牌不在任何组)。
type ShowdownHand struct {
	Seat     int         `json:"seat"`
	Cards    []CardView  `json:"cards"`
	Groups   [][]int     `json:"groups"`
	Tier     int         `json:"tier"`
	Tiebreak []float64   `json:"tiebreak"`
}

// ShowdownPayload 是摊牌事件(弃牌家的底牌永不出局)。
type ShowdownPayload struct {
	Hands []ShowdownHand `json:"hands"`
}

// SettlePoints 是结算积分明细(积分账,v1:handScore=赢家级数×可配基准,bondBonus=0,
// revealCost=Σ揭示成本;points 变动 = handScore + bondBonus - revealCost)。
type SettlePoints struct {
	HandScore  int `json:"handScore"`
	BondBonus  int `json:"bondBonus"`
	RevealCost int `json:"revealCost"`
}

// SettleRow 是单座位结算行(筹码与积分两本账互不干扰,§1.4)。
type SettleRow struct {
	Seat       int          `json:"seat"`
	ChipsDelta int          `json:"chipsDelta"`
	Points     SettlePoints `json:"points"`
}

// SettledPayload 是结算事件:rows 全员、potWins 为主/边池赢家赢得筹码(seat 字符串键)。
type SettledPayload struct {
	Rows    []SettleRow `json:"rows"`
	PotWins map[int]int `json:"potWins"`
}

// ErrorPayload 是非法动作/非法操作回执(不得回显隐藏数据,D7)。
type ErrorPayload struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
}

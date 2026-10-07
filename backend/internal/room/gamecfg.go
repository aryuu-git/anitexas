package room

import (
	"anitexas/backend/internal/game"
	"anitexas/backend/internal/model"
)

// GameConfig 把建房配置映射为 game.Config——ROOM_DEFAULT_* → game.Config 的唯一映射点
// （env 名与字段对应见 deploy/anitexas.env.example 与 config 包）：
//
//	ROOM_DEFAULT_SEATS            -> Seats
//	ROOM_DEFAULT_SMALL_BLIND      -> SmallBlind
//	ROOM_DEFAULT_BIG_BLIND        -> BigBlind
//	ROOM_DEFAULT_CHIPS            -> StartChips
//	ROOM_DEFAULT_DECK_SIZE        -> DeckSize
//	ROOM_DEFAULT_REVEAL_FEE       -> RevealFee     （v1 恒 0：只记账不扣分，D4）
//	ROOM_DEFAULT_AUTO_REVEAL      -> AutoReveal    （D14 两模式合并：true = 开局全揭示）
//	ROOM_DEFAULT_DECK_STRATEGY    -> DeckStrategy
//	TURN_TIMEOUT_SECONDS          -> TurnTimeoutMs （秒 -> 毫秒）
//	MAX_REBUYS                    -> MaxRebuys     （<=0 不限次，见 game.Config）
//
// 注：映射放 room 而非 config，保持 config 包零 game 依赖、独立可测（收尾验收只跑
// config/store 两包）。
func GameConfig(rc model.RoomConfig, turnTimeoutSeconds, maxRebuys int) game.Config {
	return game.Config{
		Seats:         rc.Seats,
		SmallBlind:    rc.SmallBlind,
		BigBlind:      rc.BigBlind,
		StartChips:    rc.Chips,
		DeckSize:      rc.DeckSize,
		RevealFee:     rc.RevealRate,
		TurnTimeoutMs: turnTimeoutSeconds * 1000,
		MaxRebuys:     maxRebuys,
		AutoReveal:    rc.AutoReveal,
		DeckStrategy:  rc.DeckStrategy,
	}
}

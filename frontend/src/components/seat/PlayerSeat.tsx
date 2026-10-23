import type { SeatState } from '../../api/types'
import { DEFAULT_TURN_MS, EMOTE_GLYPHS } from '../../api/types'
import type { EmoteTick } from '../../api/roomState'
import { SeatAvatar } from './SeatAvatar'
import { StatusRing, type SeatRingState } from './StatusRing'
import { SeatTimer } from './SeatTimer'
import { DealerButton } from './DealerButton'
import { HoleCardBacks } from './HoleCardBacks'
import { ActionBadge } from './ActionBadge'
import { SeatPlate } from './SeatPlate'

/**
 * 玩家座位（v2）：头像徽章 + 状态环 + 计时环 + 庄家位 + 面前牌背 + 动作徽章 + 名牌。
 * 朝向：facing=1（近侧/下方）牌背在上（朝桌心向上）；facing=-1（远侧）牌背在下——
 * 只调整顺序、不旋转文字。注堆由 PokerTable 按下注线单独摆放。
 */
export interface PlayerSeatProps {
  seat: SeatState
  isTurn: boolean
  isMe?: boolean
  /** 服务端确认的房主座位 */
  isHost?: boolean
  /** 1 = 近侧（正立）；-1 = 远侧（牌背朝下） */
  facing?: 1 | -1
  /** 摊牌后的牌型名 */
  tierName?: string
  /** 最近一次表情气泡 */
  emote?: EmoteTick
  /** 当前行动倒计时截止（仅行动者传） */
  deadline?: number | null
  /** 本桌行动时限（毫秒，snapshot.turnMs）：计时环总长 */
  turnMs?: number
  /** 摊牌赢家 */
  winner?: boolean
  /** 全下 */
  allin?: boolean
  /** 最近动作（跟注/加注/过牌/弃牌/全下） */
  lastAction?: string
}

export function PlayerSeat({
  seat,
  isTurn,
  isMe = false,
  isHost = false,
  facing = 1,
  tierName,
  emote,
  deadline = null,
  turnMs = DEFAULT_TURN_MS,
  winner = false,
  allin = false,
  lastAction,
}: PlayerSeatProps) {
  const ringState: SeatRingState = winner
    ? 'winner'
    : seat.folded
      ? 'folded'
      : isTurn
        ? 'acting'
        : allin
          ? 'allin'
          : 'idle'

  const avatarSize = isMe ? 80 : 64
  const holeState = seat.folded ? 'muck' : 'back'

  // 自己的底牌在桌面下方用大牌展示（HoleCards），座位前只给他人展示牌背
  const cards = isMe ? null : <HoleCardBacks count={seat.holeCount} state={holeState} size="small" />
  const avatar = (
    <span className="relative inline-flex">
      <StatusRing state={ringState}>
        <SeatAvatar nick={seat.nick} seat={seat.seat} size={avatarSize} />
      </StatusRing>
      {isTurn && <SeatTimer deadline={deadline} total={Math.max(1, Math.round(turnMs / 1000))} size={avatarSize + 10} />}
      {seat.isDealer && <DealerButton className="absolute -bottom-1 -right-1" />}
    </span>
  )
  const plate = (
    <span className="flex flex-col items-center gap-0.5">
      <SeatPlate seat={seat} isMe={isMe} isHost={isHost} />
      {tierName && (
        <span className="rounded-chip border border-gold-foil/40 bg-gold-foil/10 px-1.5 py-0.5 text-micro text-gold-foil">
          {tierName}
        </span>
      )}
    </span>
  )

  return (
    <div data-testid="player-seat" data-seat={seat.seat} data-facing={facing} className="relative flex w-[132px] flex-col items-center">
      {/* 表情气泡 */}
      {emote && (
        <span
          key={emote.at}
          aria-hidden="true"
          className="animate-emote-pop absolute -top-7 z-seat flex h-8 w-8 items-center justify-center rounded-chip border border-gold/30 bg-ink-deep/90 text-base shadow-glow"
        >
          {EMOTE_GLYPHS[emote.key]}
        </span>
      )}

      {facing === 1 ? (
        <>
          {cards}
          {avatar}
          {plate}
        </>
      ) : (
        <>
          {plate}
          {avatar}
          {cards}
        </>
      )}

      {lastAction && (
        <span className="absolute -bottom-5 left-1/2 -translate-x-1/2">
          <ActionBadge label={lastAction} token={`${lastAction}-${seat.bet}-${seat.acted}`} />
        </span>
      )}
    </div>
  )
}

import { Fragment, memo, type CSSProperties } from 'react'
import type { CardData, RevealScope, SeatState, ShowdownHand } from '../../api/types'
import { DEFAULT_TURN_MS } from '../../api/types'
import type { EmoteTick } from '../../api/roomState'
import { SeedBadge } from '../SeedBadge'
import { TableRail } from '../table/TableRail'
import { TableFelt } from '../table/TableFelt'
import { TableBettingLine } from '../table/TableBettingLine'
import { TableLights } from '../table/TableLights'
import { PotStack } from '../center/PotStack'
import { CommunityRow } from '../center/CommunityRow'
import { Muck } from '../center/Muck'
import { PlayerSeat } from '../seat/PlayerSeat'
import { BetStack } from '../seat/BetStack'
import { TABLE_H, TABLE_W, betOffset, seatFacing, seatPosition } from '../tableLayout'
import { useChipFlight } from '../../hooks/useChipFlight'
import { useTableSweep } from '../../hooks/useTableSweep'

/**
 * 德州牌桌 v2：赛道桌（桌沿/毡面/下注线/灯光）+ 桌心（筹码堆底池 + 3-1-1 公告牌 + 弃牌堆）
 * + 四周头像座位（朝向随位置翻转）+ 下注线上的注堆 + 赢家扫光。
 * 纯展示：揭示/下注等交互由 RoomPage 经 props 注入。
 */
export interface PokerTableProps {
  seats: SeatState[]
  mySeat: number
  turnSeat: number
  emotes: Record<number, EmoteTick>
  /** 座位 → 亮出的牌型名（摊牌后） */
  tierNameOf: (seat: number) => string | undefined
  /** 座位 → 最近动作文案（跟注/加注/过牌/弃牌/全下） */
  lastActionOf?: (seat: number) => string | undefined
  pot: number
  sidePot?: number
  currentBet: number
  seedCommit: string | null
  seedReveal: string | null
  revealCount?: number
  community: CardData[]
  communitySlots?: number
  autoReveal: boolean
  canReveal: boolean
  revealRate: number
  onReveal: (card: CardData, scope: RevealScope) => void
  myShowdownHand?: ShowdownHand | null
  showCover?: boolean
  /** 摊牌赢家座位（触发扫光 + 赢家光环） */
  winnerSeat?: number | null
  /** 当前行动者的倒计时截止（epoch ms） */
  deadline?: number | null
  /** 本桌行动时限（毫秒，snapshot.turnMs）：座位计时环总长 */
  turnMs?: number
}

export const PokerTable = memo(function PokerTable({
  seats,
  mySeat,
  turnSeat,
  emotes,
  tierNameOf,
  lastActionOf,
  pot,
  sidePot = 0,
  currentBet,
  seedCommit,
  seedReveal,
  revealCount = 0,
  community,
  communitySlots = 5,
  autoReveal,
  canReveal,
  revealRate,
  onReveal,
  myShowdownHand,
  showCover = true,
  winnerSeat = null,
  deadline = null,
  turnMs = DEFAULT_TURN_MS,
}: PokerTableProps) {
  const total = seats.length
  const foldedCount = seats.filter((s) => s.folded).length
  const sweepToken = useTableSweep(winnerSeat)
  const flights = useChipFlight(pot, seats, mySeat)
  const cardSize: 'sm' | 'md' = total > 6 ? 'sm' : 'md'

  return (
    <div className="relative" style={{ width: TABLE_W, height: TABLE_H }} data-testid="poker-table">
      {/* 桌面四层 */}
      <TableRail />
      <TableFelt />
      <TableBettingLine />
      <TableLights />

      {/* 赢家扫光：沿桌面转一圈的金色扇形 + 桌沿金环呼吸 */}
      {sweepToken > 0 && winnerSeat != null && (
        <>
          <div
            key={sweepToken}
            className="animate-sweep pointer-events-none absolute inset-x-[3.5%] inset-y-[8%] rounded-[50%] bg-sweep mix-blend-screen"
            aria-hidden="true"
          />
          <div
            key={`ring-${sweepToken}`}
            className="animate-sweep pointer-events-none absolute inset-x-[1.5%] inset-y-[4%] rounded-[50%] border-2 border-gold-foil/50 shadow-foil-strong"
            aria-hidden="true"
          />
        </>
      )}

      {/* 桌心：底池筹码堆 + 公告牌（3-1-1） */}
      <div className="absolute left-1/2 top-1/2 z-seat flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2.5">
        <PotStack pot={pot} sidePot={sidePot} />
        <div className="flex items-baseline gap-x-4 text-micro text-muted">
          <span>
            当前注 <span className="font-serif text-body text-gold-light">{currentBet}</span>
          </span>
          {revealCount > 0 && <span>已揭示 {revealCount}</span>}
        </div>
        <CommunityRow
          community={community}
          communitySlots={communitySlots}
          autoReveal={autoReveal}
          canReveal={canReveal}
          revealRate={revealRate}
          onReveal={onReveal}
          myShowdownHand={myShowdownHand}
          showCover={showCover}
          cardSize={cardSize}
        />
      </div>

      {/* 座位环 + 注堆（注堆落在下注线上） */}
      {seats.map((s) => {
        const { x, y } = seatPosition(s.seat, mySeat, total)
        const { dx, dy } = betOffset(s.seat, mySeat, total)
        const facing = seatFacing(s.seat, mySeat, total)
        return (
          <Fragment key={s.seat}>
            <div
              className="absolute z-seat"
              style={{ left: `${x}%`, top: `${y}%`, transform: 'translate(-50%, -50%)' }}
            >
              <PlayerSeat
                seat={s}
                isTurn={s.seat === turnSeat}
                isMe={s.seat === mySeat}
                facing={facing}
                tierName={tierNameOf(s.seat)}
                emote={emotes[s.seat]}
                deadline={s.seat === turnSeat ? deadline : null}
                turnMs={turnMs}
                winner={winnerSeat === s.seat}
                allin={s.chips <= 0 && !s.folded}
                lastAction={lastActionOf?.(s.seat)}
              />
            </div>
            {s.bet > 0 && (
              <div
                className="absolute z-seat"
                style={{ left: `${x + dx}%`, top: `${y + dy}%`, transform: 'translate(-50%, -50%)' }}
              >
                <BetStack amount={s.bet} allin={s.chips <= 0 && !s.folded} />
              </div>
            )}
          </Fragment>
        )
      })}

      {/* 筹码飞行：注堆 → 桌心底池（底池增加时一次性） */}
      {flights.map((f) => (
        <span
          key={f.id}
          data-testid="chip-flight"
          className="animate-chip-fly pointer-events-none absolute z-seat"
          style={
            {
              left: `${f.x}%`,
              top: `${f.y}%`,
              transform: 'translate(-50%, -50%)',
              '--fly-x': `${f.fx}px`,
              '--fly-y': `${f.fy}px`,
            } as CSSProperties
          }
          aria-hidden="true"
        >
          <span className="block h-3.5 w-3.5 rounded-chip border border-gold-foil/70 bg-gold-foil shadow-card-lift" />
        </span>
      ))}

      {/* 弃牌堆（左下） */}
      <div className="absolute bottom-[5%] left-[6%] z-seat">
        <Muck count={foldedCount} />
      </div>

      {/* 发牌固证（右上角） */}
      <div className="absolute right-[2.5%] top-[4%] z-seat">
        <SeedBadge seedCommit={seedCommit} seedReveal={seedReveal} />
      </div>
    </div>
  )
})

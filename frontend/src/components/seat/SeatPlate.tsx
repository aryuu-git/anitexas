import type { SeatState } from '../../api/types'

/**
 * 名牌：昵称 + 筹码 / 积分（小字弱化）。自己加「（你）」；行动/弃牌由状态环表达。
 */
export function SeatPlate({ seat, isMe = false }: { seat: SeatState; isMe?: boolean }) {
  return (
    <span className="flex flex-col items-center leading-tight whitespace-nowrap" data-testid="seat-plate">
      <span className="flex items-center gap-1 font-serif text-caption text-gold-light">
        <span className="max-w-[96px] truncate">{seat.nick}</span>
        {isMe && <span className="text-micro text-muted">你</span>}
      </span>
      <span className="flex items-baseline gap-1.5 text-micro text-muted">
        <span className="font-serif text-body text-gold">{seat.chips}</span>
        <span>{seat.points} 积分</span>
      </span>
      {/* 准备标记（waiting 态）/ 重买计数（破产就地重买累计） */}
      {(seat.ready || seat.rebuys > 0) && (
        <span className="flex items-center gap-1">
          {seat.ready && (
            <span
              data-testid="ready-badge"
              className="rounded-chip border border-success/40 bg-success/10 px-1.5 py-0.5 text-micro text-success"
            >
              准备
            </span>
          )}
          {seat.rebuys > 0 && (
            <span
              data-testid="rebuy-badge"
              className="rounded-chip border border-gold/30 bg-gold/10 px-1.5 py-0.5 text-micro text-gold-light"
            >
              重买×{seat.rebuys}
            </span>
          )}
        </span>
      )}
    </span>
  )
}

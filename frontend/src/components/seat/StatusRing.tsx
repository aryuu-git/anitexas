import type { ReactNode } from 'react'

/**
 * 状态环：包住头像的一圈环，用颜色 + 动效表达座位状态。
 * - acting：金光脉冲（当前行动）
 * - allin：红金
 * - folded：灰、降饱和
 * - winner：金（摊牌赢家）
 * - idle：无
 */
export type SeatRingState = 'idle' | 'acting' | 'allin' | 'folded' | 'winner'

const RING_CLASS: Record<SeatRingState, string> = {
  idle: 'ring-0',
  acting: 'ring-2 ring-gold-foil/80 animate-seat-pulse',
  allin: 'ring-2 ring-danger/80',
  folded: 'ring-1 ring-gold/15 opacity-60 saturate-50',
  winner: 'ring-2 ring-gold-foil/90 shadow-foil-strong',
}

export function StatusRing({
  state,
  children,
  className = '',
}: {
  state: SeatRingState
  children: ReactNode
  className?: string
}) {
  return (
    <span
      data-testid="status-ring"
      data-state={state}
      className={`inline-flex rounded-chip ${RING_CLASS[state]} ${className}`}
    >
      {children}
    </span>
  )
}

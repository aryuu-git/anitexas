import { useCountdown } from '../../hooks/useCountdown'

/**
 * 行动计时环：环绕头像的 SVG 进度环，走针收敛在组件内（250ms tick）。
 * deadline 为 null 时不渲染（无倒计时）。
 */
export interface SeatTimerProps {
  /** 截止时刻（epoch ms） */
  deadline: number | null
  /** 单手总时长（秒） */
  total: number
  /** 环直径（px） */
  size?: number
}

export function SeatTimer({ deadline, total, size = 78 }: SeatTimerProps) {
  const remaining = useCountdown(deadline)
  if (deadline == null) return null

  const r = size / 2 - 3
  const circumference = 2 * Math.PI * r
  const pct = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0
  const urgent = remaining <= 10

  return (
    <svg
      data-testid="seat-timer"
      className="pointer-events-none absolute -rotate-90"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-label={`剩余 ${remaining} 秒`}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={3} className="stroke-gold-foil/15" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - pct)}
        className={`transition-[stroke-dashoffset] duration-base ease-standard ${urgent ? 'stroke-danger' : 'stroke-gold-foil'}`}
      />
    </svg>
  )
}

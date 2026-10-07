/**
 * 面前的牌背：座位前 0–2 张小牌背。
 * - back：未知（未发牌/他人底牌）
 * - shown：已亮出要素（半开：金边）
 * - muck：弃牌滑向桌心（淡出下沉）
 * interactive 时（自己的牌）可点击展开。
 */
export type HoleCardState = 'back' | 'shown' | 'muck'

export interface HoleCardBacksProps {
  count: number
  state?: HoleCardState
  /** 尺寸：own = 自己的牌（大一点） */
  size?: 'small' | 'own'
  interactive?: boolean
  onClick?: () => void
  className?: string
}

export function HoleCardBacks({
  count,
  state = 'back',
  size = 'small',
  interactive = false,
  onClick,
  className = '',
}: HoleCardBacksProps) {
  if (count <= 0) return null
  const dims = size === 'own' ? 'h-[46px] w-[32px]' : 'h-[34px] w-[24px]'
  const tone =
    state === 'shown'
      ? 'border-gold-foil/70 bg-card-back brightness-110'
      : state === 'muck'
        ? 'border-gold/10 bg-card-back opacity-40 translate-y-2'
        : 'border-gold-foil/35 bg-card-back'

  return (
    <span
      data-testid="hole-card-backs"
      data-state={state}
      className={`animate-deal-v2 inline-flex gap-1 ${className}`}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? '点击展开底牌' : undefined}
      onClick={interactive ? onClick : undefined}
    >
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={`rounded-micro border shadow-card-lift ${dims} ${tone} ${
            interactive ? 'cursor-pointer transition-[transform,border-color] duration-fast hover:-translate-y-0.5 hover:border-gold-foil/70' : ''
          }`}
        />
      ))}
    </span>
  )
}

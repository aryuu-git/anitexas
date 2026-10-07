import { chipLayers } from '../tableLayout'

/** 面额 → 筹码配色（只用 token）。 */
const DENOM_CLASS: Record<number, string> = {
  500: 'bg-gold-foil border-gold-foil/70',
  100: 'bg-gold border-gold/70',
  25: 'bg-gold-light border-gold-light/70',
  5: 'bg-surface-elevated border-gold/40',
  1: 'bg-surface border-gold/30',
}

/**
 * 筹码堆：把金额换算成面额分层（1/5/25/100/500），逐层错位叠起来，旁边标金额。
 * 纯展示，按金额确定性渲染（便于测试与截图稳定）。
 */
export interface ChipStackProps {
  amount: number
  /** 单枚筹码直径（px） */
  size?: number
  /** 最多展示层数 */
  maxLayers?: number
  /** 是否在下方显示金额 */
  showAmount?: boolean
  className?: string
}

export function ChipStack({ amount, size = 20, maxLayers = 4, showAmount = true, className = '' }: ChipStackProps) {
  if (!amount || amount <= 0) return null
  const layers = chipLayers(amount, maxLayers)
  const height = size + Math.max(0, layers.length - 1) * 4

  return (
    <div className={`flex flex-col items-center gap-0.5 ${className}`} data-testid="chip-stack" data-amount={amount}>
      <div className="relative" style={{ width: size, height }}>
        {layers.map((l, i) => (
          <span
            key={l.denom}
            data-denom={l.denom}
            title={`${l.denom} × ${l.count}`}
            className={`absolute left-0 rounded-chip border shadow-avatar ${DENOM_CLASS[l.denom] ?? 'bg-surface border-gold/30'}`}
            style={{ width: size, height: size, bottom: i * 4 }}
          />
        ))}
      </div>
      {showAmount && (
        <span className="rounded-chip bg-ink-deep/70 px-1.5 font-serif text-micro text-gold-light">
          {amount}
        </span>
      )}
    </div>
  )
}

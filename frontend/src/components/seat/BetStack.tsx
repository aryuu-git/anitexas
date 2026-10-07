import { ChipStack } from './ChipStack'

/**
 * 注堆：本轮注额做成「推向桌心」的筹码堆，落在下注线上。
 * allin 时套用推筹码动画（animate-shove）。
 */
export interface BetStackProps {
  amount: number
  /** 是否是全下（触发推筹码动画） */
  allin?: boolean
  size?: number
  className?: string
}

export function BetStack({ amount, allin = false, size = 16, className = '' }: BetStackProps) {
  if (!amount || amount <= 0) return null
  return (
    <div
      data-testid="bet-stack"
      data-amount={amount}
      className={`flex flex-col items-center ${allin ? 'animate-shove' : ''} ${className}`}
    >
      <ChipStack amount={amount} size={size} maxLayers={3} />
      {allin && <span className="text-micro text-danger">ALL IN</span>}
    </div>
  )
}

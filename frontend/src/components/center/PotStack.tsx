import { ChipStack } from '../seat/ChipStack'

/**
 * 底池筹码堆：主池做成筹码堆，数字大号 serif 叠在旁边；可选的边池小堆。
 */
export interface PotStackProps {
  pot: number
  /** 边池（<=0 不显示） */
  sidePot?: number
}

export function PotStack({ pot, sidePot = 0 }: PotStackProps) {
  return (
    <div className="flex items-end gap-3" data-testid="pot-stack">
      <ChipStack amount={pot} size={18} maxLayers={5} showAmount={false} />
      <div className="flex flex-col items-start leading-none">
        <span className="text-kicker text-gold-foil">POT</span>
        <span
          key={pot}
          className="animate-chip-pop font-serif text-score text-gold"
          data-testid="pot-amount"
        >
          {pot}
        </span>
      </div>
      {sidePot > 0 && (
        <div className="flex flex-col items-center leading-none" data-testid="side-pot">
          <ChipStack amount={sidePot} size={14} maxLayers={3} showAmount={false} />
          <span className="text-micro text-muted">边池 {sidePot}</span>
        </div>
      )}
    </div>
  )
}

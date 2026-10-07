/**
 * 快捷注：1/2 池 / 池 / 最小 三个候选目标 + 「全下」动作。
 * 金额语义与 ActionBar 一致：候选值是「加到」的本轮总投入目标，经调用方夹紧；
 * 全下是动作而非金额（服务端按余量结算，短码时唯一可用路径），走 onAllin。
 */
export interface QuickBetProps {
  pot: number
  currentBet: number
  /** 最小目标（= currentBet + minRaise）：候选值下限 */
  min: number
  myChips: number
  disabled?: boolean
  /** 选定目标金额（已按 [min, myChips] 夹紧） */
  onPick: (amount: number) => void
  /** 全下动作 */
  onAllin: () => void
}

export function QuickBet({ pot, currentBet, min, myChips, disabled = false, onPick, onAllin }: QuickBetProps) {
  // 候选目标先夹紧到 [min, myChips]（短码时贴住余量，走「全下」路径）
  const floor = Math.min(min, myChips)
  const items: { label: string; amount: number }[] = [
    { label: '½ 池', amount: Math.round((pot + currentBet * 2) / 2) },
    { label: '池', amount: pot + currentBet * 2 },
    { label: '最小', amount: min },
  ].map((it) => ({ ...it, amount: Math.min(Math.max(it.amount, floor), myChips) }))

  return (
    <div className="flex items-center gap-1.5" data-testid="quick-bet">
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          disabled={disabled}
          onClick={() => onPick(it.amount)}
          className="rounded-chip border border-gold/25 bg-ink-deep/40 px-2.5 py-1 text-micro text-gold-light transition-[transform,border-color,background-color,opacity] duration-fast ease-standard hover:-translate-y-px hover:border-gold/50 disabled:pointer-events-none disabled:opacity-40"
        >
          {it.label}
        </button>
      ))}
      <button
        type="button"
        disabled={disabled}
        data-action="allin"
        onClick={onAllin}
        className="rounded-chip border border-danger/40 bg-danger/10 px-2.5 py-1 text-micro text-danger transition-[transform,border-color,background-color,opacity] duration-fast ease-standard hover:-translate-y-px hover:border-danger/60 disabled:pointer-events-none disabled:opacity-40"
      >
        全下
      </button>
    </div>
  )
}

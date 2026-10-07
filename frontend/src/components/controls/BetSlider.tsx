/**
 * 下注滑条：range + 数字输入（大底池可精确键入）+ 受控金额。金额区间由父层保证合法。
 */
export interface BetSliderProps {
  min: number
  max: number
  value: number
  disabled?: boolean
  onChange: (v: number) => void
}

export function BetSlider({ min, max, value, disabled = false, onChange }: BetSliderProps) {
  const span = Math.max(1, max - min)
  const pct = Math.min(100, Math.max(0, ((value - min) / span) * 100))
  return (
    <div className="flex min-w-[260px] flex-1 items-center gap-3" data-testid="bet-slider">
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        aria-label="下注金额"
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(Math.min(Math.max(Math.round(v), min), max))
        }}
        className="w-20 rounded-chip border border-gold/25 bg-ink-deep/40 px-2 py-1 text-right font-serif text-body-lg text-gold-light outline-none focus:border-gold/60 disabled:opacity-40"
      />
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={Math.min(Math.max(value, min), max)}
        disabled={disabled}
        aria-label="下注金额滑条"
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-chip bg-gold/20 accent-gold-foil disabled:opacity-40"
        style={{ background: `linear-gradient(90deg, rgb(var(--color-gold-foil) / .55) ${pct}%, rgb(var(--color-gold) / .18) ${pct}%)` }}
      />
    </div>
  )
}

import { memo } from 'react'
import { THEME_KIND_OPTIONS, type DeckStrategy, type ThemeFilter } from '../api/types'

/**
 * 牌池策略表单段（D11）：分层随机 / 主题池二选一；主题池时展开
 * 主题维（公司/年代/标签）+ 主题值输入，产出 roomConfig.deckStrategy + themeFilter。
 */
export interface DeckStrategyFieldProps {
  strategy: DeckStrategy
  themeFilter: ThemeFilter
  onStrategyChange: (strategy: DeckStrategy) => void
  onThemeFilterChange: (filter: ThemeFilter) => void
}

export const DeckStrategyField = memo(function DeckStrategyField({
  strategy,
  themeFilter,
  onStrategyChange,
  onThemeFilterChange,
}: DeckStrategyFieldProps) {
  return (
    <div data-testid="deck-strategy-field" role="radiogroup" aria-label="牌池策略">
      <div className="flex gap-2">
        {(
          [
            { key: 'stratified', label: '分层随机', desc: '档位 × 要素配额' },
            { key: 'theme', label: '主题池', desc: '过滤后再分层' },
          ] as const
        ).map((opt) => (
          <RadioCard
            key={opt.key}
            strategy={opt.key}
            label={opt.label}
            desc={opt.desc}
            checked={strategy === opt.key}
            onSelect={() => onStrategyChange(opt.key)}
          />
        ))}
      </div>

      {strategy === 'theme' && (
        <div className="mt-3 flex items-end gap-3">
          <label className="flex flex-none flex-col gap-1.5">
            <span className="text-micro text-muted">主题维</span>
            <select
              aria-label="主题维"
              value={themeFilter.kind}
              onChange={(e) => {
                const kind = e.target.value
                if (kind === 'company' || kind === 'year' || kind === 'tag') {
                  onThemeFilterChange({ kind, value: themeFilter.value })
                }
              }}
              className="rounded-chip border border-gold/20 bg-ink-deep/40 px-3 py-2 text-caption text-gold-light outline-none focus:border-gold/60"
            >
              {THEME_KIND_OPTIONS.map((o) => (
                <option key={o.kind} value={o.kind}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-micro text-muted">主题值</span>
            <input
              aria-label="主题值"
              value={themeFilter.value}
              onChange={(e) => onThemeFilterChange({ kind: themeFilter.kind, value: e.target.value })}
              placeholder={
                themeFilter.kind === 'company'
                  ? '如 京都动画'
                  : themeFilter.kind === 'year'
                    ? '如 2009'
                    : '如 治愈'
              }
              maxLength={20}
              className="w-full rounded-chip border border-gold/20 bg-ink-deep/40 px-3 py-2 text-caption text-gold-light outline-none placeholder:text-muted/50 focus:border-gold/60"
            />
          </label>
        </div>
      )}
    </div>
  )
})

/** 策略单选卡（role=radio 语义保留；radio 无法套 ui/Button，选中/五态样式在此单点维护） */
function RadioCard({
  strategy,
  label,
  desc,
  checked,
  onSelect,
}: {
  strategy: DeckStrategy
  label: string
  desc: string
  checked: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-strategy={strategy}
      onClick={onSelect}
      className={`flex-1 rounded-tile border px-4 py-3 text-left transition-[border-color,background-color,box-shadow] duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70
        ${checked
          ? 'border-gold-foil/60 bg-gold-foil/10 shadow-mcard'
          : 'border-gold/15 bg-ink-deep/40 hover:border-gold/40'}`}
    >
      <span className="block font-serif text-card-name text-gold-light">{label}</span>
      <span className="block text-micro text-muted">{desc}</span>
    </button>
  )
}

/**
 * 动作徽章：座位旁的「最近动作」小胶囊（跟注/加注/过牌/弃牌/全下），出现后 2.5s 淡出。
 * key 变化即重放动画。
 */

const TONE: Record<string, string> = {
  弃牌: 'border-gold/20 bg-ink-deep/80 text-muted',
  过牌: 'border-gold/30 bg-gold/10 text-gold-light',
  跟注: 'border-gold-foil/40 bg-gold-foil/15 text-gold-foil',
  加注: 'border-danger/40 bg-danger/15 text-danger',
  '全下': 'border-danger/60 bg-danger/20 text-danger',
}

export function ActionBadge({ label, token }: { label: string; token?: string | number }) {
  return (
    <span
      key={token ?? label}
      data-testid="action-badge"
      className={`animate-badge inline-flex items-center rounded-chip border px-2 py-0.5 text-micro shadow-avatar ${
        TONE[label] ?? 'border-gold/25 bg-gold/10 text-gold-light'
      }`}
    >
      {label}
    </span>
  )
}

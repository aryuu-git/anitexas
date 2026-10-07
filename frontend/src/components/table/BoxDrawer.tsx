import type { BoxCard, PoolInfo } from '../../api/types'
import { THEME_KIND_OPTIONS } from '../../api/types'

/**
 * 牌池抽屉（D17）：本手盒名单（名称/评分/档位/年份）+ 牌池摘要（策略/主题/池大小）。
 * 与 TableDock 同款右侧浮层；pool.fallback=true 时显著提示「主题过滤过窄，已回退全库」。
 * 盒名单是公开名单——只含 L1 字段，不带 elements（D7 隐藏纪律）。
 */
export interface BoxDrawerProps {
  open: boolean
  onClose: () => void
  /** 本手盒名单（snapshot.box） */
  box: BoxCard[]
  /** 牌池摘要（snapshot.pool；null = 未收到快照） */
  pool: PoolInfo | null
}

export function BoxDrawer({ open, onClose, box, pool }: BoxDrawerProps) {
  if (!open) return null
  return (
    <aside
      data-testid="box-dock"
      className="fixed right-5 top-24 z-modal flex max-h-[76vh] w-[360px] flex-col overflow-hidden rounded-panel border border-gold-foil/25 bg-ink-deep/95 shadow-lift"
    >
      <header className="flex items-center gap-2 border-b border-gold/15 px-4 py-3">
        <span className="text-kicker text-gold-foil">牌池</span>
        <button
          type="button"
          aria-label="关闭牌池"
          onClick={onClose}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-chip border border-gold/20 bg-ink-deep/40 text-micro text-gold-light transition-[transform,border-color,background-color,opacity] duration-fast ease-standard hover:-translate-y-px hover:border-gold/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70"
        >
          ✕
        </button>
      </header>

      {/* 主题过滤回退：必须显著提示（房内可见） */}
      {pool?.fallback && (
        <div
          role="alert"
          data-testid="pool-fallback"
          className="m-4 rounded-tile border border-danger/40 bg-danger/10 px-3 py-2 text-micro text-danger"
        >
          主题过滤过窄，已回退全库
        </div>
      )}

      {/* 牌池摘要 */}
      <div className="px-4 pt-3 text-micro text-muted" data-testid="pool-summary">
        {pool ? (
          <>
            {pool.strategy === 'theme' ? '主题池' : '分层随机'}
            {pool.theme?.value
              ? ` · ${THEME_KIND_OPTIONS.find((o) => o.kind === pool.theme?.kind)?.label ?? pool.theme.kind}「${pool.theme.value}」`
              : ''}
            {' · 池 '}
            <span className="font-serif text-body text-gold-light">{pool.poolSize}</span> 张
          </>
        ) : (
          '牌池摘要未下发'
        )}
      </div>

      {/* 盒名单（公开 L1 字段） */}
      <div className="mt-3 border-t border-gold/10 px-4 pt-3 text-micro text-muted">本手盒名单</div>
      <div className="flex items-baseline gap-2 px-4 pt-1 text-tiny tracking-[.25em] text-gold-foil">
        <span className="flex-1">作品</span>
        <span className="w-40 text-right">评分 · 档位 · 年份</span>
      </div>
      <ul className="flex-1 overflow-y-auto px-4 pb-4">
        {box.length === 0 && <li className="py-3 text-micro text-muted">名单未下发</li>}
        {box.map((c) => (
          <li
            key={c.id}
            data-testid="box-row"
            className="flex items-baseline gap-2 border-b border-gold/10 py-2 last:border-b-0"
          >
            <span className="flex-1 truncate text-body text-gold-light">{c.title}</span>
            <span className="w-40 whitespace-nowrap text-right text-micro text-muted">
              {c.score} 分 · {c.bucket} 档 · {c.year}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  )
}

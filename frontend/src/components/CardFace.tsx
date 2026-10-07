import { memo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { CardData, Element } from '../api/types'
import { ELEMENT_CLASS_NAMES } from '../api/types'
import { Icon, type IconName } from './ui/Icons'
import { CardFoil } from './card/CardFoil'

/**
 * 牌面三态（A5.2，视觉基准 = docs/rules.html 例子牌阵 .mcard + docs/rules.png）：
 * - hidden   封面区渐变 + 作品首字 + 名字 + 评分档位（L1 恒公开，D1）；
 *            要素区收起，「未揭示」占位
 * - revealed 展开要素 chips（展开动画 250ms）；成组要素芯片描金（金边=成组）
 * - showdown 摊牌态：要素全亮，成组牌描金高亮，散牌压暗（rules .mcard.dim）
 *
 * 隐藏纪律（D7）：card.elements 缺失即未揭示，本组件不做任何补全。
 */
export type CardFaceState = 'hidden' | 'revealed' | 'showdown'

export interface CardFaceProps {
  card: CardData
  state: CardFaceState
  /** 成组牌（showdown 描金高亮） */
  grouped?: boolean
  /** 成组要素（该要素的芯片描金 + 底部标签展示，如 监督·新海诚） */
  groupElement?: Element
  /** 可点击揭示（隐藏模式下自己的牌/公共牌）；回调带牌对象，配合 React.memo 保持引用稳定 */
  interactive?: boolean
  onReveal?: (card: CardData) => void
  /** sm = 公告牌（桌心，112px 档）；md = 牌阵迷你牌（132px 档）；lg = 底牌/摊牌展示 */
  size?: 'sm' | 'md' | 'lg'
  /** 是否显示封面区（渐变 + 首字）；默认 true。桌面可用「封面」开关临时关掉以缩短卡片 */
  showCover?: boolean
  className?: string
  style?: CSSProperties
}

/** 要素类 → 图标（与规则书要素表一致） */
const CLASS_ICONS: Record<number, IconName> = {
  1: 'user',
  2: 'building',
  3: 'tag',
  4: 'cal',
  5: 'book',
}

/**
 * 求一组牌的共同要素（成组标签）：取所有牌共有、且类优先级最高的要素。
 * 摊牌面板/牌阵用它从 groups 反推「同要素 ×N」标签。
 */
export function sharedGroupElement(cards: CardData[], idxs: number[]): Element | null {
  const members = idxs.map((i) => cards[i]).filter(Boolean)
  if (members.length < 2) return null
  const first = members[0].elements ?? []
  for (const cand of first) {
    const shared = members.every((c) =>
      (c.elements ?? []).some((e) => e.class === cand.class && e.value === cand.value),
    )
    if (shared) return cand // elements 按类序 1→5 排列，首个命中即最高优先级
  }
  return null
}

/**
 * 同类多值要素 chip（多标签/多监督…）：默认收起为「类 · N」，悬停/键盘聚焦时弹出完整取值列表。
 * 弹层走 portal 到 body（卡片根节点 overflow-hidden，内联绝对定位会被裁剪）；
 * groupedValue 命中时该 chip 与对应取值描金（成组要素）。
 */
function ElementGroupChip({
  classId,
  els,
  groupedValue,
}: {
  classId: number
  els: Element[]
  groupedValue: string | null
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLSpanElement | null>(null)

  const open = () => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setAnchor({ x: r.left + r.width / 2, y: r.bottom + 6 })
  }
  const close = () => setAnchor(null)

  const inGroup = groupedValue != null

  return (
    <span
      ref={ref}
      tabIndex={0}
      data-collapsed={els.length}
      data-grouped={inGroup}
      aria-label={`${ELEMENT_CLASS_NAMES[classId]} ${els.length} 个：${els.map((e) => e.value).join('、')}`}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
      className={`inline-flex cursor-help items-center gap-1 whitespace-nowrap rounded-chip border px-2 py-0.5 text-micro
        ${inGroup
          ? 'border-gold-foil/50 bg-gold-foil/15 text-gold-foil'
          : 'border-gold/20 bg-gold/10 text-gold-light'}`}
    >
      <Icon name={CLASS_ICONS[classId] ?? 'tag'} size={11} />
      ×{els.length}
      {anchor &&
        createPortal(
          <div
            role="tooltip"
            style={{ position: 'fixed', left: anchor.x, top: anchor.y, transform: 'translateX(-50%)' }}
            className="pointer-events-none z-modal flex max-w-[260px] flex-wrap gap-1.5 rounded-tile border border-gold-foil/40 bg-ink-deep/95 px-2.5 py-2 shadow-lift"
          >
            {els.map((el) => {
              const hit = groupedValue != null && el.value === groupedValue
              return (
                <span
                  key={`${el.class}:${el.value}`}
                  data-grouped={hit}
                  className={`inline-flex items-center gap-1 whitespace-nowrap rounded-chip border px-2 py-0.5 text-micro
                    ${hit
                      ? 'border-gold-foil/50 bg-gold-foil/15 text-gold-foil'
                      : 'border-gold/20 bg-gold/10 text-gold-light'}`}
                >
                  <Icon name={CLASS_ICONS[classId] ?? 'tag'} size={11} />
                  {el.value}
                </span>
              )
            })}
          </div>,
          document.body,
        )}
    </span>
  )
}

export const CardFace = memo(function CardFace({
  card,
  state,
  grouped = false,
  groupElement,
  interactive = false,
  onReveal,
  size = 'md',
  showCover = true,
  className = '',
  style,
}: CardFaceProps) {
  const showElements = state !== 'hidden' && (card.elements?.length ?? 0) > 0
  const dim = state === 'showdown' && !grouped
  // 尺寸档（sm 公告牌 / md 牌阵 / lg 底牌）：宽度、封面、内距、字号随档位收敛
  const isLg = size === 'lg'
  const isSm = size === 'sm'
  const wCls = isLg ? 'w-[208px]' : isSm ? 'w-[104px]' : 'w-[144px]'
  const coverSizeCls = isLg ? 'h-[92px] text-[36px]' : isSm ? 'h-[42px] text-lg' : 'h-[56px] text-2xl'
  const bodyPadCls = isLg ? 'px-3.5 pb-3.5 pt-3' : isSm ? 'px-1.5 pb-1.5 pt-1' : 'px-2.5 pb-2.5 pt-2'
  const titleSizeCls = isLg ? 'text-card-name' : 'text-caption'
  const scoreSizeCls = isLg ? 'text-card-name' : isSm ? 'text-caption' : 'text-body-lg'
  // 要素按类（1..5，类序）分组：单值铺 chip；同类多值（多监督/多标签…）折叠成「类 · N」浮窗。
  const byClass = new Map<number, Element[]>()
  for (const el of card.elements ?? []) {
    const arr = byClass.get(el.class)
    if (arr) arr.push(el)
    else byClass.set(el.class, [el])
  }

  return (
    <div
      data-state={state}
      data-grouped={grouped}
      className={`relative flex flex-col overflow-hidden rounded-card border bg-card-body-soft transition-[transform,border-color,box-shadow,opacity] duration-base ease-standard
        ${grouped
          ? 'border-gold-foil/60 shadow-mcard'
          : dim
            ? 'border-gold/15 opacity-85'
            : 'border-gold-foil/40 shadow-mcard'}
        ${interactive ? 'cursor-pointer hover:-translate-y-1 hover:border-gold-foil/70 hover:shadow-foil focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 focus-visible:ring-offset-2 focus-visible:ring-offset-ink' : ''}
        ${wCls} ${className}`}
      style={style}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `揭示《${card.title}》的要素` : undefined}
      onClick={interactive ? () => onReveal?.(card) : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onReveal?.(card)
              }
            }
          : undefined
      }
    >
      {/* 封面区：渐变 + 首字（D10 生成封面）；showCover=false 时整块去掉（缩短卡片，临时开关） */}
      {showCover && (
        <div
          className={`flex items-center justify-center border-b border-gold-foil/25 bg-cover-sm font-serif text-gold-light/80
            ${dim ? 'opacity-70 saturate-[.6]' : ''}
            ${coverSizeCls}`}
        >
          {/* 无封面降级（D10 生成封面兜底）：monogram 缺失时取作品名首字 */}
          {card.monogram || card.title.slice(0, 1)}
        </div>
      )}

      <div className={`flex flex-1 flex-col ${bodyPadCls}`}>
        {/* 年份 + 评分（L1 恒公开，下注依据 D1） */}
        <div className="flex items-baseline justify-between">
          <span className="text-micro text-muted">{card.year}</span>
          <span className={`font-serif font-bold text-gold ${scoreSizeCls}`}>
            {card.score.toFixed(1)}
          </span>
        </div>
        <div
          className={`mt-1 font-serif text-gold-light line-clamp-2 ${titleSizeCls}`}
          title={card.title}
        >
          {card.title}
        </div>
        <div className="mt-0.5 text-micro text-muted">档位 {card.bucket.toFixed(1)}</div>

        {/* 要素区：展开动画 250ms（A5.2）；未揭示时收起 */}
        <div className={`reveal-expand ${showElements ? 'max-h-[240px] opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="flex flex-wrap gap-1.5 pt-2.5">
            {[1, 2, 3, 4, 5].map((cls) => {
              const els = byClass.get(cls)
              if (!els || els.length === 0) return null
              // 单值要素默认平铺显示
              if (els.length === 1) {
                const el = els[0]
                const inGroup =
                  groupElement != null && el.class === groupElement.class && el.value === groupElement.value
                return (
                  <span
                    key={`${el.class}:${el.value}`}
                    data-grouped={inGroup}
                    className={`inline-flex items-center gap-1 whitespace-nowrap rounded-chip border px-2 py-0.5 text-micro
                      ${inGroup
                        ? 'border-gold-foil/50 bg-gold-foil/15 text-gold-foil'
                        : 'border-gold/20 bg-gold/10 text-gold-light'}`}
                  >
                    <Icon name={CLASS_ICONS[el.class] ?? 'tag'} size={11} />
                    {el.value}
                  </span>
                )
              }
              // 同类多值（多监督/多标签…）：收起成「类 · N」，悬停/聚焦弹出完整列表
              return (
                <ElementGroupChip
                  key={`group-${cls}`}
                  classId={cls}
                  els={els}
                  groupedValue={groupElement != null && groupElement.class === cls ? groupElement.value : null}
                />
              )
            })}
          </div>
        </div>

        {/* 底部标签：成组标签描金；摊牌前无成组信息，只标揭示状态 */}
        {state === 'showdown' && (
          <div className="mt-auto pt-2">
            {groupElement ? (
              <span className="inline-flex whitespace-nowrap rounded-chip border border-gold-foil/45 bg-gold-foil/15 px-2 py-0.5 text-micro text-gold-foil">
                {groupElement.value}
              </span>
            ) : (
              <span className="inline-flex whitespace-nowrap rounded-chip border border-gold/15 bg-gold/5 px-2 py-0.5 text-micro text-muted">
                散牌
              </span>
            )}
          </div>
        )}
        {state === 'revealed' && (
          <div className="mt-auto pt-2">
            {groupElement ? (
              <span className="inline-flex whitespace-nowrap rounded-chip border border-gold-foil/45 bg-gold-foil/15 px-2 py-0.5 text-micro text-gold-foil">
                {groupElement.value}
              </span>
            ) : (
              <span className="inline-flex whitespace-nowrap rounded-chip border border-gold/15 bg-gold/5 px-2 py-0.5 text-micro text-muted">
                已揭示
              </span>
            )}
          </div>
        )}
        {state === 'hidden' && (
          <div className="mt-auto pt-2">
            <span className="inline-flex whitespace-nowrap rounded-chip border border-gold/15 bg-gold/5 px-2 py-0.5 text-micro text-muted">
              {interactive ? '点击揭示要素' : '要素未揭示'}
            </span>
          </div>
        )}
      </div>

      {/* 金箔扫光：高评分牌面（≥8.5）叠加一道光带；reduced-motion 下由全局关闭 */}
      <CardFoil active={showElements && card.score >= 8.5} />
    </div>
  )
})

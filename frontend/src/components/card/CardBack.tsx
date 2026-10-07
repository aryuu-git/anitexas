import type { CSSProperties } from 'react'
import { TableSakura } from '../table/TableSakura'

/**
 * 牌背：樱墨斜纹 + 中心樱花徽记 + 金边（tailwind `bg-card-back` token）。
 * 用于他人底牌、弃牌堆、发牌动画占位。
 */
export function CardBack({
  className = '',
  style,
  size = 'sm',
}: {
  className?: string
  style?: CSSProperties
  size?: 'sm' | 'md'
}) {
  const dims = size === 'md' ? 'h-[92px] w-[64px]' : 'h-[46px] w-[32px]'
  const mark = size === 'md' ? 'h-9 w-9' : 'h-4.5 w-4.5'
  return (
    <span
      data-testid="card-back"
      aria-hidden="true"
      className={`relative inline-flex items-center justify-center overflow-hidden rounded-micro border border-gold-foil/35 bg-card-back shadow-card-lift ${dims} ${className}`}
      style={style}
    >
      <TableSakura className={`${mark} opacity-30`} />
      <span className="pointer-events-none absolute inset-[3px] rounded-[4px] border border-gold-foil/15" />
    </span>
  )
}

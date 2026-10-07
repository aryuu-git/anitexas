import type { ReactNode } from 'react'

/**
 * 面板容器（规则书 .panel 同源）：墨色渐变底 + 1px 金粉描边 + 顶线描金。
 * 「外松内紧」：面板统一 padding，内部栅格自排。
 */
export interface PanelProps {
  /** 顶线描金（.panel.accent） */
  accent?: boolean
  /** 传奇档：金粉渐变底（.tier.legend / 摊牌赢家） */
  legend?: boolean
  className?: string
  children: ReactNode
}

export function Panel({ accent = false, legend = false, className = '', children }: PanelProps) {
  return (
    <section
      className={`relative rounded-panel border p-7 shadow-panel ${
        legend
          ? 'border-gold-foil/50 bg-panel-legend shadow-foil-strong'
          : 'border-gold/15 bg-panel'
      } ${className}`}
    >
      {accent && (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-px rounded-t-panel bg-accent-line"
        />
      )}
      {children}
    </section>
  )
}

/** 区块标题：kicker + 思源宋体标题 + 描述（rules.html .sec-head 同构） */
export interface SectionHeadProps {
  kicker: string
  title: string
  desc?: ReactNode
}

export function SectionHead({ kicker, title, desc }: SectionHeadProps) {
  return (
    <header className="mb-6 flex flex-wrap items-baseline gap-x-4">
      <span className="min-w-[108px] text-kicker text-gold-foil">{kicker}</span>
      <h2 className="font-serif text-sec-title text-gold-light">{title}</h2>
      {desc && <p className="w-full max-w-[860px] text-body text-muted">{desc}</p>}
    </header>
  )
}

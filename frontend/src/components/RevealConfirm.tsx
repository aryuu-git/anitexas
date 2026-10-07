import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button } from './ui/Button'
import type { CardData, RevealScope } from '../api/types'

/**
 * 揭示确认（A5.4 / D3 不可逆）：揭示要素前的确认弹层，scope 决定文案：
 * - public 当众翻开：全桌可见（公共牌 / 「亮一只」走它）；
 * - private 私看：仅自己可见（底牌私看单击也过确认——揭示不可逆，防误触）。
 * 三行提示：可见范围、不可撤销（D3）、揭示成本（v1 费率 0 仅记账 D4）。
 * 弹层可访问性：role=dialog + aria-modal、ESC 取消、打开聚焦确认按钮、
 * Tab 在弹层内首尾循环不逃逸、关闭后焦点归还触发元素。
 */
export interface RevealConfirmProps {
  card: CardData
  /** 揭示范围（决定文案与确认按钮） */
  scope: RevealScope
  /** 揭示费率（积分/次，v1 = 0） */
  revealRate: number
  onConfirm: () => void
  onCancel: () => void
}

/** 弹层内可聚焦元素（Tab 循环圈定用） */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export function RevealConfirm({ card, scope, revealRate, onConfirm, onCancel }: RevealConfirmProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const isPrivate = scope === 'private'

  // 打开：圈定焦点到确认按钮；关闭：焦点归还触发元素
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null
    const returnTo = trigger && trigger !== document.body ? trigger : null
    confirmRef.current?.focus()
    return () => {
      if (returnTo?.isConnected) returnTo.focus()
    }
  }, [])

  /** ESC 取消；Tab 在弹层内首尾循环，不逃出弹层 */
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
    if (e.key !== 'Tab') return
    const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    if (nodes.length === 0) return
    e.preventDefault()
    const idx = nodes.indexOf(document.activeElement as HTMLElement)
    const next = e.shiftKey
      ? idx <= 0
        ? nodes.length - 1
        : idx - 1
      : idx === -1
        ? 0
        : (idx + 1) % nodes.length
    nodes[next].focus()
  }

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink-deep/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={isPrivate ? '私看确认' : '当众翻开确认'}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        className="w-full max-w-[420px] rounded-panel border border-gold-foil/40 bg-panel p-7 shadow-card animate-fade-up"
      >
        <h3 className="font-serif text-tier-name text-gold-light">{isPrivate ? '私看要素' : '当众翻开'}</h3>
        <p className="mt-3 text-body text-muted">
          {isPrivate ? (
            <>
              即将私看《<span className="text-gold-light">{card.title}</span>》的要素。
            </>
          ) : (
            <>
              即将向<strong className="text-gold-light">全桌</strong>展示《
              <span className="text-gold-light">{card.title}</span>》的要素。
            </>
          )}
        </p>
        <ul className="mt-4 space-y-2 text-body">
          <li className="flex items-center gap-2 rounded-tile border border-gold/15 bg-ink-deep/40 px-3.5 py-2.5">
            <span className="whitespace-nowrap text-gold-foil">{isPrivate ? '仅自己可见' : '全桌可见'}</span>
            <span className="text-muted">
              {isPrivate ? '只有你能看到这张牌的要素' : '所有玩家都会看到这张牌的要素'}
            </span>
          </li>
          <li className="flex items-center gap-2 rounded-tile border border-gold/15 bg-ink-deep/40 px-3.5 py-2.5">
            <span className="whitespace-nowrap text-gold-foil">不可撤销</span>
            <span className="text-muted">看过就是看过，不能收回（D3）</span>
          </li>
          <li className="flex items-center gap-2 rounded-tile border border-gold-foil/30 bg-gold-foil/10 px-3.5 py-2.5">
            <span className="whitespace-nowrap text-gold-foil">揭示成本</span>
            <span className="text-muted">
              {revealRate} 积分/次（v1 费率 0，只记账不扣分，D4）
            </span>
          </li>
        </ul>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button ref={confirmRef} variant="gold" size="sm" icon="spark" onClick={onConfirm}>
            {isPrivate ? '确认私看' : '确认当众翻开'}
          </Button>
        </div>
      </div>
    </div>
  )
}

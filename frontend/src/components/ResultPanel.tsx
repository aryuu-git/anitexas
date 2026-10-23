import { useEffect, useRef } from 'react'
import type { NextHandPolicy, SettledPayload, ShowdownHand, SeatState } from '../api/types'
import { TIER_NAMES } from '../api/types'
import { useCountdown } from '../hooks/useCountdown'
import { CardFace, sharedGroupElement } from './CardFace'
import { Panel } from './ui/Panel'
import { Button } from './ui/Button'

/**
 * 结算面板（A5.4 / 产品设计 §7）：本人优先。
 * 首屏只回答「我这手赚了多少、积分变了多少、为什么结束」；
 * 其他玩家牌型与账本折叠。获奖名单按 potWins 合计展示（可多人），
 * 牌力排名与筹码获奖使用不同标签，不把排序首位强行标唯一赢家。
 * 收尾：准备下一手 / 已准备反馈 / 自动下一手真实秒数；关闭不发 ready。
 */
export interface ResultPanelProps {
  /** 摊牌手牌（按比较链降序；null/空 = 有人弃牌提前结束，无摊牌对比） */
  showdown: ShowdownHand[] | null
  /** 结算明细（服务端 lastResult 投影） */
  settled: SettledPayload
  seats: SeatState[]
  mySeat: number
  /** 服务端结束原因（缺省按是否有摊牌推断） */
  endReason?: 'showdown' | 'fold_win'
  /** 本人是否已准备下一手（按钮态） */
  myReady?: boolean
  /** 准备命令确认中 */
  pendingReady?: boolean
  /** 下一手自动开局时刻（epoch ms；null = 未排程） */
  nextHandAt?: number | null
  /** 服务端实际生效的下一手策略 */
  nextHandPolicy?: NextHandPolicy
  /** 服务端时钟校正（毫秒）：倒计时按 serverNow 对齐 */
  serverOffset?: number
  /** 回顾模式：只读上一手结果，不提供准备/离开，不改变参局状态 */
  review?: boolean
  /** 准备下一手（发 ready；全员 ready 提前开局） */
  onReady?: () => void
  /** 离开牌桌（发 leave 后回大厅） */
  onLeave?: () => void
  /** 关闭面板（ESC；不发 ready，桌面仍展示倒计时） */
  onClose?: () => void
  /** 触发按钮已被卸载时的焦点恢复选择器（如结算入口按钮） */
  returnFocusSelector?: string
  /** 是否显示封面区（透传 CardFace）；桌面「封面」开关默认关 */
  showCover?: boolean
}

export function ResultPanel({
  showdown,
  settled,
  seats,
  mySeat,
  endReason,
  myReady = false,
  pendingReady = false,
  nextHandAt = null,
  nextHandPolicy = 'manual',
  serverOffset = 0,
  review = false,
  onReady,
  onLeave,
  onClose,
  returnFocusSelector,
  showCover = true,
}: ResultPanelProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const remaining = useCountdown(nextHandAt, serverOffset)

  const myRow = settled.rows.find((r) => r.seat === mySeat)
  const chipsDelta = myRow?.chipsDelta ?? 0
  const pointsDelta = myRow ? myRow.points.handScore + myRow.points.bondBonus - myRow.points.revealCost : 0
  const wonChips = settled.potWins[mySeat] ?? 0
  const winners = Object.entries(settled.potWins)
    .map(([seat, amount]) => ({ seat: Number(seat), amount }))
    .filter((w) => Number.isFinite(w.seat) && w.amount > 0)
    .sort((a, b) => b.amount - a.amount)
  const reason = endReason ?? (showdown && showdown.length > 1 ? 'showdown' : 'fold_win')
  const hasShowdown = !!showdown && showdown.length > 0

  // 打开时记住触发点并落焦：主按钮 → 关闭按钮 → 面板本身；关闭后焦点回到触发点
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (primaryRef.current) primaryRef.current.focus()
    else if (dialogRef.current) {
      const close = dialogRef.current.querySelector<HTMLElement>('[data-action="close"]')
      ;(close ?? dialogRef.current).focus()
    }
    return () => {
      const prev = previousFocus.current
      // 触发按钮可能随面板打开被条件卸载：退回文档时改按选择器找回入口
      if (prev?.isConnected) {
        prev.focus?.()
        return
      }
      if (returnFocusSelector) {
        document.querySelector<HTMLElement>(returnFocusSelector)?.focus()
      }
    }
  }, [])

  // ESC 关闭（不发 ready）；Tab 焦点圈定在面板内
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose?.()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      const inside = active != null && dialogRef.current.contains(active)
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const nickOf = (seat: number) => seats.find((s) => s.seat === seat)?.nick ?? `座位 ${seat}`
  const foldedOf = (seat: number) => seats.find((s) => s.seat === seat)?.folded ?? false
  const wonBy = (seat: number) => settled.potWins[seat] ?? 0

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-modal flex items-center justify-center p-4 focus:outline-none md:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="本手结算"
    >
      <div className="absolute inset-0 bg-ink/70" aria-hidden="true" />
      <div className="relative flex max-h-[88vh] w-[min(880px,94vw)] flex-col gap-4 overflow-y-auto rounded-panel border border-gold-foil/30 bg-ink-deep p-5 shadow-lift md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-sec-title text-gold-light">本手结算</h2>
            <p className="mt-1 text-body text-muted" data-testid="result-reason">
              {reason === 'fold_win' ? '其他玩家弃牌，提前收池' : '摊牌比较，按最佳五张结算'}
              {review && ' · 这是上一手的结果'}
            </p>
          </div>
          {onClose && (
            <Button variant="ghost" size="sm" data-action="close" onClick={onClose} aria-label="关闭结算">
              关闭
            </Button>
          )}
        </div>

        {/* 本人首屏：筹码净变化 / 积分变化 / 结果原因 */}
        <Panel accent>
          <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
            <div>
              <div className="text-tiny tracking-[.25em] text-gold-foil">你的筹码净变化</div>
              <div
                className={`font-serif text-score ${chipsDelta >= 0 ? 'text-success' : 'text-danger'}`}
                data-testid="my-chips-delta"
              >
                {chipsDelta >= 0 ? `+${chipsDelta}` : chipsDelta}
              </div>
            </div>
            <div>
              <div className="text-tiny tracking-[.25em] text-gold-foil">积分变化</div>
              <div className="font-serif text-tier-name text-gold-light" data-testid="my-points-delta">
                {pointsDelta >= 0 ? `+${pointsDelta}` : pointsDelta}
              </div>
            </div>
            {wonChips > 0 && (
              <span
                className="ml-auto rounded-chip border border-gold-foil/50 bg-gold-foil/15 px-3 py-1 text-body text-gold-foil"
                data-testid="my-pot-win"
              >
                赢得底池 {wonChips}
              </span>
            )}
          </div>
        </Panel>

        {/* 获奖名单：potWins 合计，可能多人；与牌力排名分开表达 */}
        <Panel>
          <h3 className="font-serif text-tier-name text-gold-light">获奖名单</h3>
          {winners.length === 0 ? (
            <p className="mt-2 text-body text-muted">本手没有筹码获奖记录。</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {winners.map((w) => (
                <li
                  key={w.seat}
                  className="flex items-center justify-between rounded-tile border border-gold/15 px-3 py-2"
                  data-testid="winner-row"
                >
                  <span className="text-body text-gold-light">
                    {nickOf(w.seat)}
                    {w.seat === mySeat && <span className="ml-1 text-micro text-muted">（你）</span>}
                  </span>
                  <span className="font-serif text-body-lg text-success">赢得 {w.amount}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* 其他玩家牌型与账本：默认折叠 */}
        <details className="rounded-panel border border-gold/15 bg-panel px-4 py-3" data-testid="result-details">
          <summary className="cursor-pointer font-serif text-body-lg text-gold-light">
            其他玩家牌型与账本
          </summary>

          {hasShowdown ? (
            <div className="mt-4 flex flex-col gap-3">
              {showdown!.map((hand, i) => (
                <div key={hand.seat} className="rounded-tile border border-gold/15 p-3">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
                    <span className="flex h-10 w-10 items-center justify-center rounded-chip border border-gold-foil/60 bg-card-body font-serif text-tier-name text-gold-light">
                      {hand.tier}
                    </span>
                    <h4 className="font-serif text-tier-name text-gold-light">
                      {TIER_NAMES[hand.tier] ?? `第 ${hand.tier} 级`}
                    </h4>
                    <span className="text-body text-muted">
                      {nickOf(hand.seat)}
                      {hand.seat === mySeat && '（你）'}
                    </span>
                    {/* 牌力排名与筹码获奖是两件事 */}
                    <span className="rounded-chip border border-gold/30 px-2 py-0.5 text-micro text-gold-light/80">
                      牌力第 {i + 1}
                    </span>
                    {wonBy(hand.seat) > 0 && (
                      <span className="rounded-chip border border-success/40 bg-success/10 px-2 py-0.5 text-micro text-success">
                        赢得 {wonBy(hand.seat)}
                      </span>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2.5">
                    {hand.cards.map((card, ci) => {
                      const g = hand.groups.find((grp) => grp.includes(ci))
                      return (
                        <CardFace
                          key={card.id}
                          card={card}
                          state="showdown"
                          grouped={g != null}
                          groupElement={g ? sharedGroupElement(hand.cards, g) ?? undefined : undefined}
                          showCover={showCover}
                        />
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-body text-muted">本手没有摊牌对比（弃牌提前结束，底牌未公开）。</p>
          )}

          <h4 className="mt-5 text-tiny tracking-[.25em] text-gold-foil">筹码与积分账本</h4>
          <table className="mt-2 w-full text-body">
            <thead>
              <tr>
                <Th>玩家</Th>
                <Th>筹码盈亏</Th>
                <Th>牌型积分</Th>
                <Th>羁绊加成</Th>
                <Th>揭示成本</Th>
                <Th>积分合计</Th>
              </tr>
            </thead>
            <tbody>
              {settled.rows.map((r) => {
                const total = r.points.handScore + r.points.bondBonus - r.points.revealCost
                return (
                  <tr key={r.seat} className={r.seat === mySeat ? 'bg-gold/5' : ''}>
                    <td className="px-3 py-2.5 text-gold-light">
                      {nickOf(r.seat)}
                      {r.seat === mySeat && <span className="ml-1 text-micro text-muted">（你）</span>}
                      {foldedOf(r.seat) && <span className="ml-1 text-micro text-muted">（已弃牌）</span>}
                    </td>
                    <td className={`px-3 py-2.5 font-serif ${r.chipsDelta >= 0 ? 'text-success' : 'text-danger'}`}>
                      {r.chipsDelta >= 0 ? `+${r.chipsDelta}` : r.chipsDelta}
                    </td>
                    <td className="px-3 py-2.5 text-muted">+{r.points.handScore}</td>
                    <td className="px-3 py-2.5 text-muted">+{r.points.bondBonus}</td>
                    <td className="px-3 py-2.5 text-muted">−{r.points.revealCost}</td>
                    <td className="px-3 py-2.5 font-serif text-gold">{total >= 0 ? `+${total}` : total}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </details>

        {/* 收尾：真实策略与倒计时 + 准备反馈 */}
        <div className="flex flex-wrap items-center gap-3">
          {!review && (
            <span className="text-body text-muted" data-testid="next-hand-status">
              {nextHandPolicy === 'automatic' && nextHandAt != null
                ? remaining > 0
                  ? `下一手 ${remaining} 秒后开始`
                  : '正在确认下一手…'
                : '全体真人准备后开始'}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2.5">
            {!review && onLeave && (
              <Button variant="ghost" data-action="leave" onClick={onLeave}>
                离开
              </Button>
            )}
            {!review && onReady && (
              <Button
                ref={primaryRef}
                variant="gold"
                icon="cards"
                data-action="ready"
                disabled={myReady}
                loading={pendingReady}
                onClick={onReady}
              >
                {myReady ? '已准备，等待其他玩家' : '准备下一手'}
              </Button>
            )}
            {review && onClose && (
              <Button ref={primaryRef} variant="gold" data-action="close" onClick={onClose}>
                关闭
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 表头单元（字距 .25em 的小字，rules.html table th 同款） */
function Th({ children }: { children: string }) {
  return (
    <th className="whitespace-nowrap border-b border-gold-foil/30 px-3 py-2 text-left text-tiny font-medium tracking-[.25em] text-gold-foil">
      {children}
    </th>
  )
}

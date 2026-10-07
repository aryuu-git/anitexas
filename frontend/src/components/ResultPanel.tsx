import { useEffect, useRef } from 'react'
import type { SettledPayload, ShowdownHand, SeatState } from '../api/types'
import { TIER_NAMES } from '../api/types'
import { useCountdown } from '../hooks/useCountdown'
import { CardFace, sharedGroupElement } from './CardFace'
import { Panel } from './ui/Panel'
import { Button } from './ui/Button'

/**
 * 结算面板（A5.4）：摊牌对比 + 筹码与积分明细。
 * 仪式感：牌型名大字（牌型名大字 + 级数环）、成组牌描金；
 * 积分明细固定三行——牌型积分 / 羁绊加成 / 揭示成本（Σ，含次数与费率）。
 * 收尾动作：「立即开始」（发 ready 提前开局）+「离开」（回大厅）；ESC 只关面板、不发 ready。
 * 打开时焦点落在主按钮，Tab 焦点圈定在面板内（role=dialog + aria-modal）。
 */
export interface ResultPanelProps {
  /** 摊牌手牌（按比较链降序；null = 有人弃牌提前结束，无摊牌对比） */
  showdown: ShowdownHand[] | null
  /** 结算明细 */
  settled: SettledPayload
  seats: SeatState[]
  mySeat: number
  /** 立即开始（发 ready；全员 ready 提前开局） */
  onReady?: () => void
  /** 离开牌桌（发 leave 后回大厅） */
  onLeave?: () => void
  /** 关闭面板（ESC；不发 ready，桌面仍展示倒计时） */
  onClose?: () => void
  /** 下一手自动开局时刻（epoch ms；null = 未排程则不显示倒计时） */
  nextHandAt?: number | null
  /** 是否显示封面区（透传 CardFace）；桌面「封面」开关默认关 */
  showCover?: boolean
}

export function ResultPanel({
  showdown,
  settled,
  seats,
  mySeat,
  onReady,
  onLeave,
  onClose,
  nextHandAt = null,
  showCover = true,
}: ResultPanelProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const remaining = useCountdown(nextHandAt)

  // 打开时焦点圈定：先落主按钮（「立即开始」），无主按钮时落面板本身
  useEffect(() => {
    if (primaryRef.current) primaryRef.current.focus()
    else dialogRef.current?.focus()
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

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-modal flex items-center justify-center p-6 focus:outline-none"
      role="dialog"
      aria-modal="true"
      aria-label="本手结算"
    >
      <div className="absolute inset-0 bg-ink/70" aria-hidden="true" />
      <div className="relative flex max-h-[82vh] w-[min(880px,92vw)] flex-col gap-5 overflow-y-auto rounded-panel border border-gold-foil/30 bg-ink-deep p-6 shadow-lift">
      <SectionTitle />

      {/* 摊牌对比：牌型名大字 + best5 成组描金 */}
      {showdown && (
        <div className="flex flex-col gap-4">
          {showdown.map((hand, i) => (
            <Panel
              key={hand.seat}
              accent
              legend={i === 0}
              className={i === 0 ? 'animate-winner-glow' : ''}
            >
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
                <span className="flex h-12 w-12 items-center justify-center rounded-chip border border-gold-foil/60 bg-card-body font-serif text-tier-name text-gold-light">
                  {hand.tier}
                </span>
                <h3 className={`font-serif text-tier-name ${i === 0 ? 'text-gold-foil' : 'text-gold-light'}`}>
                  {TIER_NAMES[hand.tier] ?? `第 ${hand.tier} 级`}
                </h3>
                <span className="text-body text-muted">
                  {nickOf(hand.seat)}
                  {hand.seat === mySeat && '（你）'}
                </span>
                {i === 0 && (
                  <span className="rounded-chip border border-gold-foil/50 bg-gold-foil/15 px-2.5 py-0.5 text-micro text-gold-foil">
                    本手胜者
                  </span>
                )}
              </div>

              {/* best5：成组牌描金 + 组标签 */}
              <div className="mt-4 flex flex-wrap gap-3">
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
            </Panel>
          ))}
        </div>
      )}

      {/* 筹码与积分明细 */}
      <Panel accent>
        <h3 className="font-serif text-tier-name text-gold-light">筹码与积分明细</h3>
        <table className="mt-4 w-full text-body">
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
                  </td>
                  <td className={`px-3 py-2.5 font-serif ${r.chipsDelta >= 0 ? 'text-success' : 'text-danger'}`}>
                    {r.chipsDelta >= 0 ? `+${r.chipsDelta}` : r.chipsDelta}
                  </td>
                  <td className="px-3 py-2.5 text-muted">+{r.points.handScore}</td>
                  <td className="px-3 py-2.5 text-muted">+{r.points.bondBonus}</td>
                  {/* 揭示成本行（A5.4）：Σ 成本；v1 费率 0 只记账（D4） */}
                  <td className="px-3 py-2.5 text-muted">−{r.points.revealCost}</td>
                  <td className="px-3 py-2.5 font-serif text-gold">{total >= 0 ? `+${total}` : total}</td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {/* 收尾：下一手倒计时 + 立即开始 / 离开 */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {nextHandAt != null && (
            <span className="text-body text-muted" data-testid="next-hand-countdown">
              下一手 <span className="font-serif text-body-lg text-gold-light">{remaining}</span> 秒后开始
            </span>
          )}
          <div className="ml-auto flex items-center gap-2.5">
            {onLeave && (
              <Button variant="ghost" data-action="leave" onClick={onLeave}>
                离开
              </Button>
            )}
            {onReady && (
              <Button ref={primaryRef} variant="gold" icon="cards" data-action="ready" onClick={onReady}>
                立即开始
              </Button>
            )}
          </div>
        </div>
      </Panel>
      </div>
    </div>
  )
}

/** 结果页标题（仪式感收尾） */
function SectionTitle() {
  return <h2 className="font-serif text-sec-title text-gold-light">本手结算</h2>
}

/** 表头单元（字距 .25em 的小字，rules.html table th 同款） */
function Th({ children }: { children: string }) {
  return (
    <th className="whitespace-nowrap border-b border-gold-foil/30 px-3 py-2 text-left text-tiny font-medium tracking-[.25em] text-gold-foil">
      {children}
    </th>
  )
}

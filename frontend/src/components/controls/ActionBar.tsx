import { useEffect, useMemo, useState } from 'react'
import type { ActionType } from '../../api/types'
import { DEFAULT_TURN_MS } from '../../api/types'
import { useCountdown } from '../../hooks/useCountdown'
import { Button } from '../ui/Button'
import { BetSlider } from './BetSlider'
import { QuickBet } from './QuickBet'

/**
 * 行动区（v2）：只按服务端 legalActions 渲染，不保留整排灰按钮。
 * - 本人回合：常规为 `[弃牌] [过牌 / 跟注 X] [下注或加注…]`；加注展开内联面板，
 *   面板内保留滑条/快捷注/全下，并标明「加到 Y / 再投入 Z」。
 * - 非本人回合、待确认、断线：只渲染一行权威状态 + 真实倒计时。
 * - 金额语义：amount = 「下注到 / 加注到」的本轮总投入目标（betting.go 的 target 语义）。
 * - 全下：内联二次点击确认；短码跟注直接作为主要合法动作（实际走 allin）。
 * - 快捷键（本人回合且焦点不在输入控件，且该动作合法）：F 弃牌 / C 过牌·跟注 / A 全下 / R 展开金额面板。
 */

export interface ActionBarProps {
  pot: number
  /** 服务端合法动作（控件唯一依据） */
  actions: ActionType[]
  /** 跟齐所需增量（服务端权威） */
  callAmount: number
  currentBet: number
  bigBlind: number
  /** 合法最小加注目标（null = 不可加注） */
  minRaiseTo?: number | null
  /** 本轮已下注 + 剩余筹码 */
  maxRaiseTo?: number
  myChips: number
  isMyTurn: boolean
  pendingType?: ActionType | null
  /** 待确认已超过 5 秒，正在向服务端核对 */
  pendingVerifying?: boolean
  deadline: number | null
  /** 本桌行动时限（毫秒，snapshot.turnMs）；缺省 30s */
  turnMs?: number
  /** 服务端时钟校正（毫秒）：倒计时按 serverNow 对齐 */
  serverOffset?: number
  /** 当前行动者昵称（非本方回合时显示「轮到 X」；未知/等待中为 null） */
  turnNick?: string | null
  /** 非本人回合的权威说明（已弃牌/已全下/本手未参与等；来自视图模型） */
  statusText?: string | null
  /** 连接断开时锁定全部输入 */
  disabled?: boolean
  /** 模态层（结算/上手回顾）打开时锁定快捷键，避免误操作底下的牌局 */
  shortcutsLocked?: boolean
  /** 换手/换街标识（handSeq + phase）：变化时金额按新最小值重置夹紧 */
  resetKey?: string
  onAction: (type: ActionType, amount?: number) => void
}

const ACTION_NAMES: Record<ActionType, string> = {
  check: '过牌',
  bet: '下注',
  call: '跟注',
  raise: '加注',
  fold: '弃牌',
  allin: '全下',
}

export function ActionBar({
  pot,
  actions,
  callAmount,
  currentBet,
  bigBlind,
  minRaiseTo = null,
  maxRaiseTo = 0,
  myChips,
  isMyTurn,
  pendingType = null,
  pendingVerifying = false,
  deadline,
  turnMs = DEFAULT_TURN_MS,
  serverOffset = 0,
  turnNick = null,
  statusText = null,
  disabled = false,
  shortcutsLocked = false,
  resetKey = '',
  onAction,
}: ActionBarProps) {
  /** 本轮已投入（maxRaiseTo = 已投入 + 剩余筹码） */
  const myBet = Math.max(0, (maxRaiseTo > 0 ? maxRaiseTo : myChips) - myChips)
  const maxTarget = Math.max(1, maxRaiseTo > 0 ? maxRaiseTo : myChips + myBet)
  const fallbackMin = currentBet + (minRaiseTo == null ? bigBlind : 0)
  const minTarget = Math.min(maxTarget, Math.max(currentBet + 1, minRaiseTo ?? fallbackMin))

  const [amount, setAmount] = useState(() => minTarget)
  const [panelOpen, setPanelOpen] = useState(false)
  const [allInArmed, setAllInArmed] = useState(false)

  // 换手/换街/换桌：金额按新最小值重置，收起面板与确认态（当前值不可跨回合沿用）
  useEffect(() => {
    setAmount(minTarget)
    setPanelOpen(false)
    setAllInArmed(false)
  }, [resetKey, minTarget, myChips])

  // 全下确认 3 秒未二次点击自动收起，避免误触
  useEffect(() => {
    if (!allInArmed) return
    const timer = window.setTimeout(() => setAllInArmed(false), 3000)
    return () => window.clearTimeout(timer)
  }, [allInArmed])

  const pending = pendingType != null
  const can = (t: ActionType) => isMyTurn && !pending && !disabled && actions.includes(t)
  const target = Math.min(maxTarget, Math.max(minTarget, amount))
  const isBet = currentBet === 0
  const canOpenPanel = can('bet') || can('raise')
  const shortCall = callAmount > 0 && callAmount >= myChips
  const remaining = useCountdown(isMyTurn ? deadline : null, serverOffset)
  const turnSeconds = Math.max(1, Math.round(turnMs / 1000))

  // 全下：第一次点击进入确认，第二次才发出；面板关闭时一并取消
  const requestAllIn = () => {
    if (!can('allin')) return
    if (!allInArmed) {
      setAllInArmed(true)
      return
    }
    setAllInArmed(false)
    onAction('allin')
  }

  const submitTarget = () => {
    if (!canOpenPanel) return
    onAction(isBet ? 'bet' : 'raise', target)
  }

  // 键盘快捷键：只对合法动作生效；焦点在输入控件（滑条/输入框等）时不抢键
  useEffect(() => {
    if (!isMyTurn || disabled || pending || shortcutsLocked) return
    const onKeyDown = (e: KeyboardEvent) => {
      // 长按重复事件不得再次触发（否则会绕过全下二次确认）
      if (e.repeat) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const el = document.activeElement
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          (el as HTMLElement).isContentEditable)
      ) {
        return
      }
      switch (e.key.toLowerCase()) {
        case 'f':
          if (can('fold')) {
            e.preventDefault()
            onAction('fold')
          }
          return
        case 'c':
          if (can('check')) {
            e.preventDefault()
            onAction('check')
          } else if (can('call') && callAmount < myChips) {
            e.preventDefault()
            onAction('call')
          } else if (callAmount > 0 && can('allin')) {
            e.preventDefault()
            onAction('allin')
          }
          return
        case 'a':
          if (can('allin')) {
            e.preventDefault()
            if (!allInArmed) {
              setPanelOpen(true)
              requestAllIn()
            } else {
              requestAllIn()
            }
          }
          return
        case 'r':
          if (canOpenPanel) {
            e.preventDefault()
            setPanelOpen(true)
          }
          return
        default:
          return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const status = useMemo(() => {
    if (pending) {
      return pendingVerifying
        ? '正在核对操作结果…'
        : `确认中：${pendingType ? ACTION_NAMES[pendingType] : '操作'}`
    }
    if (disabled) return '连接中断，操作已锁定，正在恢复…'
    if (!isMyTurn) return statusText || (turnNick ? `轮到 ${turnNick}` : '等待其他玩家')
    if (actions.length === 0) return statusText || '等待服务端给出可执行动作'
    return null
  }, [pending, pendingVerifying, pendingType, disabled, isMyTurn, statusText, turnNick, actions.length])

  return (
    <div
      data-testid="action-bar"
      className="flex flex-wrap items-center gap-x-3 gap-y-3 rounded-panel border border-gold-foil/25 bg-panel px-4 py-3 shadow-panel md:px-6"
    >
      {/* 回合 + 倒计时（≤10 秒转红，SeatTimer 同款语义） */}
      <div className="flex items-center gap-3">
        <span
          className={`flex h-11 w-11 flex-none items-center justify-center rounded-chip border font-serif text-body-lg ${
            isMyTurn
              ? remaining <= 10
                ? 'border-danger/60 text-danger'
                : 'border-gold-foil/60 text-gold-foil'
              : 'border-gold/20 text-muted'
          }`}
          aria-label={`剩余 ${remaining} 秒（本桌限时 ${turnSeconds} 秒，超时自动过牌或弃牌）`}
        >
          {isMyTurn ? remaining : '—'}
        </span>
        {!status && (
          <span className="font-serif text-body-lg text-gold-light">
            轮到你
            <span className="ml-1.5 font-sans text-micro font-normal text-muted" data-testid="my-bet">
              已投 {myBet}
            </span>
          </span>
        )}
      </div>

      {status ? (
        // 非本人回合 / 待确认 / 断线：只保留一行权威状态，不渲染整排灰按钮
        <p className="min-w-0 flex-1 text-body text-gold-light/85" role="status" data-testid="action-status">
          {status}
        </p>
      ) : (
        <>
          <div className="ml-auto flex flex-wrap items-center gap-2.5" data-testid="action-group">
            {can('fold') && (
              <Button variant="ghost" data-action="fold" onClick={() => onAction('fold')}>
                弃牌
              </Button>
            )}
            {can('check') && (
              <Button variant="gold" data-action="check" onClick={() => onAction('check')}>
                过牌
              </Button>
            )}
            {can('call') && (
              <Button
                variant="gold"
                data-action="call"
                onClick={() => (shortCall ? onAction('allin') : onAction('call'))}
              >
                {shortCall ? `跟注（全下 ${myChips}）` : `跟注 ${callAmount}`}
              </Button>
            )}
            {canOpenPanel && (
              <Button
                variant="outline"
                aria-expanded={panelOpen}
                data-action={isBet ? 'bet' : 'raise'}
                onClick={() => setPanelOpen((v) => !v)}
              >
                {isBet ? '下注' : '加注'}
              </Button>
            )}
          </div>

          {/* 金额内联面板：滑条 + 快捷注 + 确认 + 全下（二次确认） */}
          {canOpenPanel && panelOpen && (
            <div
              className="flex w-full flex-wrap items-center gap-x-4 gap-y-3 border-t border-gold/15 pt-3"
              data-testid="bet-panel"
            >
              <div className="flex items-baseline gap-3">
                <span className="font-serif text-body-lg text-gold-light" data-testid="bet-target">
                  {isBet ? '加到' : '加注到'} {target}
                </span>
                <span className="text-micro text-muted">再投入 {Math.max(0, target - myBet)}</span>
              </div>
              <BetSlider
                min={minTarget}
                max={maxTarget}
                value={target}
                onChange={setAmount}
              />
              <QuickBet
                pot={pot}
                currentBet={currentBet}
                min={minTarget}
                myChips={maxTarget}
                allinLabel={allInArmed ? '确认全下' : '全下'}
                onPick={setAmount}
                onAllin={requestAllIn}
              />
              <Button
                variant="gold"
                data-action="confirm-bet"
                disabled={!canOpenPanel}
                onClick={submitTarget}
              >
                {isBet ? '下注到' : '加注到'} {target}
              </Button>
              {allInArmed && (
                <Button variant="ghost" size="sm" data-action="cancel-allin" onClick={() => setAllInArmed(false)}>
                  取消全下
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

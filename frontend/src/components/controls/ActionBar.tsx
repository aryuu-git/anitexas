import { useEffect, useState } from 'react'
import type { ActionType } from '../../api/types'
import { DEFAULT_TURN_MS } from '../../api/types'
import { useCountdown } from '../../hooks/useCountdown'
import { Button } from '../ui/Button'
import { BetSlider } from './BetSlider'
import { QuickBet } from './QuickBet'

/**
 * 行动条（v2）：贴着「自己」座位的操作面板——倒计时 + 下注滑条/快捷注 + 动作按钮。
 * 金额语义：amount = 「下注到 / 加注到」的本轮总投入目标（betting.go 的 target 语义），
 * 最小目标 = currentBet + minRaise（全下豁免）；不足最小注不允许提交（防服务端回 error），
 * 短码（myChips < 最小目标或 < toCall）时「全下」是可用路径。
 * 快捷键（自己回合且焦点不在输入控件）：F 弃牌 / C 过牌·跟注 / A 全下 / R 加注·下注。
 */

export interface ActionBarProps {
  pot: number
  toCall: number
  currentBet: number
  bigBlind: number
  /** 最小加注增量（服务端权威，snapshot/acted 下发）：target ≥ currentBet + minRaise */
  minRaise?: number
  myChips: number
  isMyTurn: boolean
  pendingType?: ActionType | null
  deadline: number | null
  /** 本桌行动时限（毫秒，snapshot.turnMs）；缺省 30s */
  turnMs?: number
  /** 当前行动者昵称（非本方回合时显示「轮到 X」；未知/等待中为 null） */
  turnNick?: string | null
  /** 连接断开时禁用全部输入（断线体验） */
  disabled?: boolean
  /** 换手/换街标识（handSeq + phase）：变化时金额按新最小值重置夹紧 */
  resetKey?: string
  onAction: (type: ActionType, amount?: number) => void
}

export function ActionBar({
  pot,
  toCall,
  currentBet,
  bigBlind,
  minRaise = 0,
  myChips,
  isMyTurn,
  pendingType = null,
  deadline,
  turnMs = DEFAULT_TURN_MS,
  turnNick = null,
  disabled = false,
  resetKey = '',
  onAction,
}: ActionBarProps) {
  // 最小目标：本轮总投入 ≥ currentBet + minRaise（minRaise 缺省时按大盲，旧版服务端兼容）
  const raiseStep = minRaise > 0 ? minRaise : bigBlind
  const minTarget = currentBet + raiseStep
  const [amount, setAmount] = useState(() => Math.min(myChips, minTarget))
  // 换手/换街/换桌：金额按新最小值重置夹紧（当前值不可跨回合沿用）
  useEffect(() => {
    setAmount(Math.min(myChips, minTarget))
  }, [resetKey, minTarget, myChips])

  const locked = !isMyTurn || pendingType != null || disabled
  const target = Math.min(myChips, Math.max(minTarget, amount))
  const amountInvalid = target < minTarget // 短码：目标够不到最小注，只能全下
  const remaining = useCountdown(isMyTurn ? deadline : null)
  const turnSeconds = Math.max(1, Math.round(turnMs / 1000))
  const canCall = toCall > 0 && toCall <= myChips

  // 键盘快捷键：焦点在输入控件（滑条/输入框等）时不抢键
  useEffect(() => {
    if (!isMyTurn || disabled) return
    const onKeyDown = (e: KeyboardEvent) => {
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
          if (!locked) {
            e.preventDefault()
            onAction('fold')
          }
          return
        case 'c':
          if (locked) return
          if (toCall > 0) {
            if (canCall) {
              e.preventDefault()
              onAction('call')
            }
          } else {
            e.preventDefault()
            onAction('check')
          }
          return
        case 'a':
          if (!locked) {
            e.preventDefault()
            onAction('allin')
          }
          return
        case 'r':
          // R = 加注；本轮尚无注时同义于「下注到 target」（同一个目标语义）
          if (!locked && !amountInvalid) {
            e.preventDefault()
            onAction(currentBet > 0 ? 'raise' : 'bet', target)
          }
          return
        default:
          return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isMyTurn, disabled, locked, toCall, canCall, amountInvalid, currentBet, target, onAction])

  return (
    <div
      data-testid="action-bar"
      className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-panel border border-gold-foil/25 bg-panel px-6 py-3.5 shadow-panel"
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
          aria-label={`剩余 ${remaining} 秒（本桌限时 ${turnSeconds} 秒）`}
        >
          {isMyTurn ? remaining : '—'}
        </span>
        <span className="font-serif text-body-lg text-gold-light">
          {isMyTurn ? '轮到你' : turnNick ? `轮到 ${turnNick}` : '等待其他玩家'}
        </span>
      </div>

      {/* 金额：滑条 + 快捷注（amount = 加到的目标） */}
      <BetSlider
        min={Math.min(minTarget, myChips)}
        max={Math.max(myChips, 1)}
        value={target}
        disabled={locked}
        onChange={setAmount}
      />
      <QuickBet
        pot={pot}
        currentBet={currentBet}
        min={minTarget}
        myChips={myChips}
        disabled={locked}
        onPick={setAmount}
        onAllin={() => onAction('allin')}
      />

      {/* 动作组 */}
      <div className="ml-auto flex flex-wrap items-center gap-2.5" data-testid="action-group">
        <Button
          variant="ghost"
          disabled={locked || toCall > 0}
          loading={pendingType === 'check'}
          data-action="check"
          onClick={() => onAction('check')}
        >
          过牌
        </Button>
        <Button
          variant="outline"
          disabled={locked || toCall > 0 || amountInvalid}
          loading={pendingType === 'bet'}
          data-action="bet"
          onClick={() => onAction('bet', target)}
        >
          下注到 {target}
        </Button>
        <Button
          variant="gold"
          disabled={locked || !canCall}
          loading={pendingType === 'call'}
          data-action="call"
          onClick={() => onAction('call')}
        >
          跟注{toCall > 0 ? ` ${toCall}` : ''}
        </Button>
        <Button
          variant="gold"
          disabled={locked || currentBet <= 0 || amountInvalid}
          loading={pendingType === 'raise'}
          data-action="raise"
          onClick={() => onAction('raise', target)}
        >
          加注到 {target}
        </Button>
        {/* 全下：动作而非金额（服务端按余量结算）；短码时唯一可用路径 */}
        <Button variant="danger" disabled={locked} loading={pendingType === 'allin'} data-action="allin" onClick={() => onAction('allin')}>
          全下
        </Button>
        <Button variant="danger" disabled={locked} loading={pendingType === 'fold'} data-action="fold" onClick={() => onAction('fold')}>
          弃牌
        </Button>
      </div>
    </div>
  )
}

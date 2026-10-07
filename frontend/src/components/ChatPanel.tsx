import { memo, useEffect, useRef, useState, type FormEvent } from 'react'
import { CHAT_MAX_LEN, CHAT_THROTTLE_MS } from '../api/types'
import { Icon } from './ui/Icons'

/**
 * 聊天面板（say/said，与 emote/emoted 同构）：右侧可折叠、房主可关（chatEnabled）。
 * 客户端纪律：消息截断 CHAT_MAX_LEN、发送节流 CHAT_THROTTLE_MS（简单防刷屏，
 * 服务端另有同限校验兜底）；节流窗口内的发送**排队补发**，窗口过后按序自动发出，不丢弃。
 */

/** 展示行（nick 由上层按座位解析） */
export interface ChatLine {
  seat: number
  nick: string
  text: string
}

export interface ChatPanelProps {
  messages: ChatLine[]
  /** 房主开放聊天（roomConfig.chatEnabled）；false 时输入框置灰 */
  chatEnabled: boolean
  /** 观战/未入座等禁言态：输入与发送一并禁用（房主开关之外的上行闸门） */
  disabled?: boolean
  onSay: (text: string) => void
  /** 裸态：去掉外层面板边框/标题/折叠，供浮窗 TableDock 内嵌（默认 false 为独立右栏） */
  bare?: boolean
}

export const ChatPanel = memo(function ChatPanel({
  messages,
  chatEnabled,
  disabled = false,
  onSay,
  bare = false,
}: ChatPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [text, setText] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const lastSentAtRef = useRef(0)
  // 节流窗口内被拦下的消息队列（排队补发，不丢弃）
  const queueRef = useRef<string[]>([])
  const flushTimerRef = useRef<number | null>(null)
  const onSayRef = useRef(onSay)
  useEffect(() => {
    onSayRef.current = onSay
  }, [onSay])

  // 节流提示倒数（仅展示用；发送判定以 lastSentAtRef 为准）
  useEffect(() => {
    if (cooldown <= Date.now()) return
    const timer = window.setTimeout(() => setCooldown(0), cooldown - Date.now())
    return () => window.clearTimeout(timer)
  }, [cooldown])

  /** 排队补发：窗口一到按序发出队首；队列非空则续排下一段窗口 */
  const scheduleFlush = () => {
    if (flushTimerRef.current != null) return
    const wait = Math.max(0, lastSentAtRef.current + CHAT_THROTTLE_MS - Date.now())
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null
      const next = queueRef.current.shift()
      if (next === undefined) {
        setCooldown(0)
        return
      }
      lastSentAtRef.current = Date.now()
      onSayRef.current(next)
      if (queueRef.current.length > 0) scheduleFlush()
      else setCooldown(0)
    }, wait)
  }

  // 卸载时清掉排队补发定时器
  useEffect(
    () => () => {
      if (flushTimerRef.current != null) window.clearTimeout(flushTimerRef.current)
    },
    [],
  )

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!chatEnabled || disabled) return // 置灰之外的兜底：任何提交路径都不得上行
    const body = text.trim().slice(0, CHAT_MAX_LEN)
    if (!body) return
    const now = Date.now()
    if (queueRef.current.length > 0 || now - lastSentAtRef.current < CHAT_THROTTLE_MS) {
      // 节流窗口内：入队，窗口过后自动补发（不丢弃）；提示「发言太频繁，请稍候」
      queueRef.current.push(body)
      setText('')
      setCooldown(lastSentAtRef.current + CHAT_THROTTLE_MS)
      scheduleFlush()
      return
    }
    lastSentAtRef.current = now
    setText('')
    onSay(body)
  }

  return (
    <aside
      data-testid="chat-panel"
      data-collapsed={bare ? false : collapsed}
      className={
        bare
          ? 'flex w-full flex-col'
          : 'flex w-[240px] flex-none flex-col rounded-panel border border-gold/15 bg-panel-soft shadow-panel'
      }
    >
      {!bare && (
        <div className="flex items-center gap-2 px-4 py-3">
          <span className="text-kicker text-gold-foil">CHAT</span>
          <span className="text-micro text-muted">牌桌聊天</span>
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开聊天面板' : '折叠聊天面板'}
            onClick={() => setCollapsed((v) => !v)}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-chip border border-gold/20 bg-ink-deep/40 text-micro text-gold-light transition-[transform,border-color,background-color,opacity] duration-fast ease-standard hover:-translate-y-px hover:border-gold/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70"
          >
            <Icon name={collapsed ? 'chevronLeft' : 'chevronRight'} size={15} />
          </button>
        </div>
      )}

      {(bare || !collapsed) && (
        <>
          <ul
            data-testid="chat-log"
            aria-live="polite"
            className="flex max-h-[240px] flex-1 flex-col gap-2 overflow-y-auto px-4 pb-3"
          >
            {messages.length === 0 && (
              <li className="text-micro text-muted">还没有消息，打个招呼吧。</li>
            )}
            {messages.map((m, i) => (
              <li key={`${m.seat}-${i}`} className="text-caption text-gold-light">
                <span className="text-micro text-gold-foil">{m.nick}</span>
                <span className="text-muted"> · </span>
                {m.text}
              </li>
            ))}
          </ul>

          <form onSubmit={onSubmit} className="flex items-center gap-2 px-4 pb-3.5">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={!chatEnabled || disabled}
              maxLength={CHAT_MAX_LEN}
              placeholder={
                !chatEnabled ? '房主已关闭聊天' : disabled ? '暂不可发言' : '说点什么…'
              }
              aria-label="聊天输入"
              data-state={chatEnabled && !disabled ? 'ready' : 'disabled'}
              className="w-full rounded-chip border border-gold/20 bg-ink-deep/40 px-3 py-1.5 text-caption text-gold-light outline-none placeholder:text-muted/50 focus:border-gold/60 disabled:opacity-40"
            />
            <button
              type="submit"
              disabled={!chatEnabled || disabled || text.trim().length === 0}
              className="flex-none rounded-chip border border-gold/25 bg-gold/10 px-3 py-1.5 text-micro text-gold-light transition-[transform,border-color,background-color,opacity] duration-fast ease-standard hover:-translate-y-px hover:border-gold/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 disabled:pointer-events-none disabled:opacity-40"
            >
              发送
            </button>
          </form>
          {cooldown > Date.now() && (
            <div className="px-4 pb-3 text-micro text-muted" data-testid="chat-throttle-hint">
              发言太频繁，请稍候
            </div>
          )}
        </>
      )}
    </aside>
  )
})

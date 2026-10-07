import { useEffect, useState } from 'react'
import { EMOTE_GLYPHS, EMOTE_KEYS, type EmoteKey } from '../api/types'

/**
 * 快捷表情气泡栏（D15）：8 个表情键（服务端白名单）、10 秒冷却。
 * 冷却期间按钮禁用并显示剩余秒数；服务端另有 emote_failed 兜底。
 */
export interface EmoteBarProps {
  /** 冷却截止时刻（epoch ms；0 = 无冷却） */
  cooldownUntil: number
  onEmote: (key: EmoteKey) => void
  /** 观战/未入座时禁用 */
  disabled?: boolean
  /** 裸态：去掉外层面板与标题，供浮窗 TableDock 内嵌（默认 false 为独立条） */
  bare?: boolean
}

/** 表情键 → 中文名（aria-label 用；8 键全覆盖） */
export const EMOTE_LABELS: Record<EmoteKey, string> = {
  clap: '鼓掌',
  smile: '微笑',
  wow: '惊讶',
  think: '思考',
  cry: '哭泣',
  angry: '生气',
  sweat: '流汗',
  love: '喜爱',
}

/** 冷却剩余秒数（向上取整） */
const remainingSeconds = (until: number) =>
  Math.max(0, Math.ceil((until - Date.now()) / 1000))

export function EmoteBar({ cooldownUntil, onEmote, disabled = false, bare = false }: EmoteBarProps) {
  const [left, setLeft] = useState(() => remainingSeconds(cooldownUntil))

  useEffect(() => {
    setLeft(remainingSeconds(cooldownUntil))
    if (cooldownUntil <= Date.now()) return
    const timer = window.setInterval(() => setLeft(remainingSeconds(cooldownUntil)), 250)
    return () => window.clearInterval(timer)
  }, [cooldownUntil])

  const cooling = left > 0
  return (
    <div
      data-testid="emote-bar"
      className={
        bare
          ? 'flex flex-wrap items-center gap-2'
          : 'flex flex-wrap items-center gap-2 rounded-panel border border-gold/15 bg-panel px-5 py-3 shadow-panel'
      }
    >
      {!bare && (
        <>
          <span className="text-kicker text-gold-foil">EMOTE</span>
          <span className="text-micro text-muted">快捷表情</span>
        </>
      )}
      <div className="flex flex-wrap gap-1.5">
        {EMOTE_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            aria-label={`表情：${EMOTE_LABELS[key]}`}
            disabled={disabled || cooling}
            data-key={key}
            data-state={cooling ? 'cooldown' : 'ready'}
            onClick={() => onEmote(key)}
            className="flex h-9 w-9 items-center justify-center rounded-chip border border-gold/20 bg-ink-deep/40 text-lg transition-[transform,border-color,background-color,opacity] duration-fast ease-standard hover:-translate-y-px hover:border-gold/50 hover:bg-gold/10 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 disabled:pointer-events-none disabled:opacity-40"
          >
            {EMOTE_GLYPHS[key]}
          </button>
        ))}
      </div>
      {cooling && (
        <span className="ml-auto text-micro text-muted">冷却 {left}s</span>
      )}
    </div>
  )
}

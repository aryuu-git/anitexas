/**
 * 准备室（docs/experience-handoff/01-product-design.md §5）。
 *
 * 只展示房间摘要、邀请区与权威座位名单：不渲染下注滑条、公共牌空槽与零底池。
 * 等待名单来自服务端 readiness（blockers），不从座位数量或昵称自行推断。
 */
import { useEffect, useRef, useState } from 'react'
import type { ExperienceView } from '../../api/experienceState'
import type { RoomState } from '../../api/roomState'
import { Button } from '../../components/ui/Button'
import { Panel } from '../../components/ui/Panel'

export interface RoomWaitingViewProps {
  code: string
  state: RoomState
  view: ExperienceView
  /** 权威状态已同步且连接可用（否则按钮禁用） */
  linkUp: boolean
  /** 准备命令确认中 */
  pendingReady: boolean
  /** 连接说明（连接中/重连中/已连接） */
  connLabel: string
  onReady: () => void
  onLeave: () => void
}

type CopyKind = 'code' | 'invite'

/** 邀请链接：跟随 Vite BASE_URL，不拼死根路径 */
function inviteUrl(code: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  return `${window.location.origin}${base}/room/${code.toUpperCase()}`
}

export function RoomWaitingView({
  code,
  state,
  view,
  linkUp,
  pendingReady,
  connLabel,
  onReady,
  onLeave,
}: RoomWaitingViewProps) {
  const [copied, setCopied] = useState<CopyKind | null>(null)
  /** 剪贴板不可用：展示可选中的完整文本 */
  const [fallbackText, setFallbackText] = useState<string | null>(null)
  const copyTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  const copy = async (kind: CopyKind, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setFallbackText(null)
      setCopied(kind)
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(null), 2000)
    } catch {
      setCopied(null)
      setFallbackText(text)
    }
  }

  const roomCode = (state.roomCode || code).toUpperCase()
  const link = inviteUrl(roomCode)
  const seats = [...state.seats].sort((a, b) => a.seat - b.seat)
  const summary = [
    `${state.seats.length || seats.length} 座`,
    `盲注 ${state.smallBlind}/${state.bigBlind}`,
    state.autoReveal ? '要素自动展开' : '手动展开要素',
  ].join(' · ')

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-content flex-col gap-5 px-6 py-8 md:px-8">
      {/* 房间工具栏 */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <h1 className="font-serif text-sec-title text-gold-light">
          房间 <span className="tracking-[.25em] text-gold-foil">{roomCode}</span>
        </h1>
        <Button variant="outline" size="sm" icon="cards" onClick={() => void copy('code', roomCode)}>
          {copied === 'code' ? '已复制' : '复制房间码'}
        </Button>
        <Button variant="outline" size="sm" icon="link" onClick={() => void copy('invite', link)}>
          {copied === 'invite' ? '已复制' : '复制邀请链接'}
        </Button>
        <span className="ml-auto text-body text-muted" role="status" data-testid="conn-status">
          {connLabel}
        </span>
        <Button variant="ghost" size="sm" onClick={onLeave}>
          离开
        </Button>
      </header>

      {fallbackText && (
        <div className="flex flex-col gap-2 rounded-tile border border-gold/25 bg-gold/10 px-4 py-3">
          <span className="text-body text-gold-light">剪贴板不可用，请手动复制：</span>
          <input
            readOnly
            value={fallbackText}
            aria-label="邀请信息"
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-tile border border-gold/20 bg-ink-deep/60 px-3 py-2 text-body text-gold-light outline-none"
          />
        </div>
      )}

      <Panel accent>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="font-serif text-tier-name text-gold-light">准备室</h2>
          <span className="text-body text-muted">{summary}</span>
          <span className="ml-auto text-body text-gold-light/80">
            {view.myReady ? '你已准备' : '你尚未准备'}
          </span>
        </div>

        <ul className="mt-5 flex flex-col gap-2" data-testid="waiting-seats">
          {seats.map((s) => {
            const empty = (s.occupantKind ?? (s.nick ? 'human' : 'empty')) === 'empty'
            const bot = s.occupantKind === 'bot'
            const mine = s.seat === state.mySeat
            return (
              <li
                key={s.seat}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-tile border border-gold/15 bg-ink-deep/40 px-4 py-3"
              >
                <span className="font-serif text-card-name text-gold-light">
                  {empty ? '空座' : s.nick}
                  {mine && <span className="ml-2 text-micro text-gold-foil">（你）</span>}
                  {bot && <span className="ml-2 text-micro text-muted">机器人</span>}
                </span>
                {empty ? (
                  <span className="text-body text-muted">开局由机器人补位</span>
                ) : (
                  <span className="ml-auto flex items-center gap-2 text-body">
                    {s.connection === 'offline' && (
                      <span className="rounded-chip border border-danger/40 bg-danger/10 px-2 py-0.5 text-micro text-danger">
                        已断线
                      </span>
                    )}
                    <span className={s.ready ? 'text-success' : 'text-muted'}>
                      {bot ? '等待开局' : s.ready ? '已准备' : '未准备'}
                    </span>
                  </span>
                )}
              </li>
            )
          })}
          {seats.length === 0 && <li className="text-body text-muted">正在同步座位…</li>}
        </ul>

        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-gold/10 pt-5">
          <div className="flex flex-col gap-1">
            <span className="text-body text-gold-light" data-testid="ready-progress">
              {view.readyProgress}
            </span>
            <span className="text-body text-muted" data-testid="ready-hint">
              {view.myReady
                ? view.waitingNames.length > 0
                  ? `等待 ${view.waitingNames.join('、')} 准备后开始。`
                  : '已准备，等待其他真人。'
                : '你准备后自动补齐机器人并发牌。'}
            </span>
          </div>
          <Button
            className="ml-auto"
            variant="gold"
            size="lg"
            icon="spark"
            disabled={!linkUp || view.myReady}
            loading={pendingReady}
            onClick={onReady}
          >
            {view.myReady ? '已准备' : '我准备好了'}
          </Button>
        </div>
      </Panel>
    </div>
  )
}

/**
 * 准备室（docs/experience-handoff/05 §3）。
 *
 * 朋友房：邀请朋友 → 各自准备 → 房主点击“开始游戏”才发牌。
 * 练习房：机器人默认补齐，房主可切手动/自动续局。
 * 所有权限与阻塞原因来自服务端 state.canStart / startBlockedReason，前端不自行猜测。
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
  /** 当前确认中的命令类型（ready / cancelReady / start / addBot / removeBot / setTarget / nextHandPolicy） */
  pendingType: string | null
  /** 连接说明（连接中/重连中/已连接） */
  connLabel: string
  onReady: () => void
  onCancelReady: () => void
  onStart: () => void
  onAddBot: () => void
  onRemoveBot: (seat: number) => void
  onSetTarget: (n: number) => void
  onNextPolicy: (policy: 'manual' | 'automatic') => void
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
  pendingType,
  connLabel,
  onReady,
  onCancelReady,
  onStart,
  onAddBot,
  onRemoveBot,
  onSetTarget,
  onNextPolicy,
  onLeave,
}: RoomWaitingViewProps) {
  const [copied, setCopied] = useState<CopyKind | null>(null)
  const [fallbackText, setFallbackText] = useState<string | null>(null)
  const [targetDraft, setTargetDraft] = useState(state.targetHumanCount)
  const copyTimer = useRef<number | null>(null)

  useEffect(() => {
    setTargetDraft(state.targetHumanCount)
  }, [state.targetHumanCount])

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
  const isPractice = view.roomKind === 'practice'
  const occupiedHumans = seats.filter((s) => s.occupantKind === 'human').length
  const occupiedBots = seats.filter((s) => s.occupantKind === 'bot').length
  const canAddBot = view.isHost && occupiedHumans + occupiedBots < seats.length
  const summary = [
    isPractice ? '练习房' : '朋友房',
    `${seats.length || state.targetHumanCount} 座`,
    `真人 ${view.humanCount}/${view.targetHumanCount}`,
    occupiedBots > 0 ? `机器人 ${view.botCount}` : '机器人关闭',
    `盲注 ${state.smallBlind}/${state.bigBlind}`,
  ].join(' · ')
  const busy = pendingType != null

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-content flex-col gap-5 px-4 py-8 md:px-8">
      {/* 房间工具栏 */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <h1 className="font-serif text-sec-title text-gold-light">
          房间 <span className="tracking-[.25em] text-gold-foil">{roomCode}</span>
        </h1>
        <span className="text-body text-muted">{summary}</span>
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

      {/* 邀请区：一个主按钮，房间码作为备用 */}
      <Panel accent>
        <div className="flex flex-col gap-4 md:flex-row md:items-center">
          <div className="min-w-0 flex-1">
            <h2 className="font-serif text-tier-name text-gold-light">
              {isPractice ? '练习桌已就绪' : '邀请朋友入座'}
            </h2>
            <p className="mt-1 text-body text-muted">
              {isPractice
                ? '机器人已补齐空座；你准备好后即可开始。'
                : `复制链接发给朋友，人齐后各自准备。还差 ${Math.max(0, view.targetHumanCount - occupiedHumans)} 位。`}
            </p>
            <p className="mt-2 truncate text-body text-gold-light/70" data-testid="invite-link">
              {link}
            </p>
          </div>
          <div className="flex flex-none items-center gap-2">
            <Button
              variant="gold"
              size="lg"
              icon="link"
              disabled={busy}
              onClick={() => void copy('invite', link)}
            >
              {copied === 'invite' ? '已复制邀请' : '复制邀请链接'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              icon="cards"
              aria-label="复制房间码"
              onClick={() => void copy('code', roomCode)}
            >
              {copied === 'code' ? '已复制' : roomCode}
            </Button>
          </div>
        </div>
      </Panel>

      <Panel>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="font-serif text-tier-name text-gold-light">座位</h2>
          <span className="text-body text-muted">{view.readyProgress}</span>
          {occupiedBots > 0 && <span className="text-body text-muted">机器人 {occupiedBots}</span>}
        </div>

        <ul className="mt-4 flex flex-col gap-2" data-testid="waiting-seats">
          {seats.map((s) => {
            const empty = (s.occupantKind ?? (s.nick ? 'human' : 'empty')) === 'empty'
            const bot = s.occupantKind === 'bot'
            const mine = s.seat === state.mySeat
            const host = s.seat === state.hostSeat
            return (
              <li
                key={s.seat}
                data-testid={`waiting-seat-${s.seat}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-tile border border-gold/15 bg-ink-deep/40 px-4 py-3"
              >
                <span className="font-serif text-card-name text-gold-light">
                  {empty ? '空座' : s.nick}
                  {mine && <span className="ml-2 text-micro text-gold-foil">（你）</span>}
                  {host && <span className="ml-2 text-micro text-gold-foil">房主</span>}
                  {bot && <span className="ml-2 text-micro text-muted">机器人</span>}
                </span>
                <span className="ml-auto flex items-center gap-2 text-body">
                  {empty ? (
                    <span className="text-muted">等待朋友</span>
                  ) : bot ? (
                    <span className="text-muted">等待开始</span>
                  ) : s.connection === 'offline' ? (
                    <span className="rounded-chip border border-danger/40 bg-danger/10 px-2 py-0.5 text-micro text-danger">
                      已断线
                    </span>
                  ) : (
                    <span className={s.ready ? 'text-success' : 'text-muted'}>
                      {s.ready ? '已准备' : '未准备'}
                    </span>
                  )}
                  {view.isHost && bot && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!linkUp || busy}
                      onClick={() => onRemoveBot(s.seat)}
                    >
                      移除
                    </Button>
                  )}
                </span>
              </li>
            )
          })}
          {seats.length === 0 && <li className="text-body text-muted">正在同步座位…</li>}
        </ul>

        {/* 房主工具：人数目标 / 添加机器人 / 续局方式 */}
        {view.isHost && (
          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-gold/10 pt-4">
            <label className="flex items-end gap-2">
              <span className="pb-2.5 text-body text-muted">目标人数</span>
              <input
                type="number"
                min={Math.max(2, view.humanCount)}
                max={seats.length}
                value={targetDraft}
                aria-label="目标人数"
                onChange={(e) => setTargetDraft(Number(e.target.value))}
                className="w-20 rounded-tile border border-gold/20 bg-ink-deep/40 px-3 py-2.5 text-right font-serif text-body-lg text-gold-light outline-none focus:border-gold/60"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!linkUp || busy || targetDraft === state.targetHumanCount}
                onClick={() => onSetTarget(targetDraft)}
              >
                调整
              </Button>
            </label>
            <Button
              variant="outline"
              size="sm"
              icon="spark"
              disabled={!linkUp || busy || !canAddBot}
              loading={pendingType === 'addBot'}
              onClick={onAddBot}
            >
              添加机器人
            </Button>
            {isPractice && (
              <div className="flex items-center gap-2">
                <span className="text-body text-muted">下一手</span>
                <Button
                  variant={state.nextHandPolicy === 'manual' ? 'outline' : 'ghost'}
                  size="sm"
                  disabled={!linkUp || busy}
                  aria-pressed={state.nextHandPolicy === 'manual'}
                  onClick={() => onNextPolicy('manual')}
                >
                  手动开始
                </Button>
                <Button
                  variant={state.nextHandPolicy === 'automatic' ? 'outline' : 'ghost'}
                  size="sm"
                  disabled={!linkUp || busy}
                  aria-pressed={state.nextHandPolicy === 'automatic'}
                  onClick={() => onNextPolicy('automatic')}
                >
                  自动续局
                </Button>
              </div>
            )}
          </div>
        )}

        {/* 主操作：房主开始 / 玩家准备与取消准备 */}
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-gold/10 pt-5">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-body text-gold-light" data-testid="ready-progress">
              {view.readyProgress}
            </span>
            <span className="text-body text-muted" data-testid="ready-hint">
              {view.isHost
                ? view.canStart
                  ? '人都到齐并已准备，可以开始。'
                  : view.startBlockedReason || '等待队友准备。'
                : view.myReady
                  ? '已准备，等待房主开始。'
                  : '准备只表示你已就位，不会自动发牌。'}
            </span>
          </div>
          {view.isHost ? (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {view.myReady ? (
                <Button
                  variant="ghost"
                  disabled={!linkUp || busy}
                  loading={pendingType === 'cancelReady'}
                  onClick={onCancelReady}
                >
                  取消准备
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="lg"
                  disabled={!linkUp || busy}
                  loading={pendingType === 'ready'}
                  onClick={onReady}
                >
                  我准备好了
                </Button>
              )}
              <Button
                variant="gold"
                size="lg"
                icon="spark"
                disabled={!linkUp || busy || !view.canStart}
                loading={pendingType === 'start'}
                onClick={onStart}
              >
                开始游戏
              </Button>
            </div>
          ) : view.myReady ? (
            <Button
              className="ml-auto"
              variant="outline"
              size="lg"
              disabled={!linkUp || busy}
              loading={pendingType === 'cancelReady'}
              onClick={onCancelReady}
            >
              取消准备
            </Button>
          ) : (
            <Button
              className="ml-auto"
              variant="gold"
              size="lg"
              icon="spark"
              disabled={!linkUp || busy}
              loading={pendingType === 'ready'}
              onClick={onReady}
            >
              我准备好了
            </Button>
          )}
        </div>
      </Panel>
    </div>
  )
}

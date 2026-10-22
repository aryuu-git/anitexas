/**
 * 统一加入流程（docs/experience-handoff/01-product-design.md §4）：
 * 首页输入房间码、点击列表「查看」、邀请链接直达共用。
 *
 * 第一步只 GET 房间摘要（不占座）；第二步明确点击「入座」，POST join 由服务端原子复核。
 * 成功后保存恢复凭据（sessionStorage）并把回执交给调用方（大厅跳转 / 房间页建立 WS）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiClientError, joinRoom, previewRoom, type JoinResponse, type RoomSummary } from '../../api/client'
import { saveIdentity } from '../../api/identity'
import { validateNick } from '../../api/nickname'
import { Button } from '../../components/ui/Button'

type Phase = 'loading' | 'ready' | 'error' | 'joining'

/** 命令幂等键（crypto.randomUUID 不可用时退化为时间戳 + 计数） */
let joinSeq = 0
function newJoinRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `join-${Date.now()}-${++joinSeq}`
}

export interface JoinFlowProps {
  /** 规范化后的房间码（大写） */
  code: string
  nick: string
  onJoined: (joined: JoinResponse) => void
  /** 返回入口（收起预览 / 回首页 / 换房间码） */
  onCancel: () => void
  /** 昵称无效时聚焦昵称输入 */
  onNickInvalid?: (message: string) => void
}

/** 房间摘要 → 加入文案与按钮（不推测服务端未下发的 joinMode） */
function joinHint(room: RoomSummary): { detail: string; action: string } {
  if (room.joinable === false) {
    return { detail: '当前没有可加入座位。', action: '刷新房间状态' }
  }
  if (room.phase === 'waiting' || !room.phase) {
    return { detail: '加入后准备，即可开始。', action: '加入准备室' }
  }
  const hand = room.handSeq ? `第 ${room.handSeq} 手` : '进行中'
  return {
    detail: `房间${hand}进行中；加入后将按服务端复核结果入座，并继承该座位的当前筹码与本手状态。`,
    action: '确认加入',
  }
}

function joinErrorText(err: unknown): string {
  if (!(err instanceof ApiClientError)) return '加入失败，请稍后重试'
  switch (err.code) {
    case 'room_not_found':
    case 'room_closed':
      return '房间不存在或已关闭'
    case 'nick_taken':
      return '昵称已被占用；换个昵称，或用原来的浏览器恢复身份'
    case 'room_full':
      return '当前没有可加入座位'
    default:
      return err.message || '加入失败，请稍后重试'
  }
}

export function JoinFlow({ code, nick, onJoined, onCancel, onNickInvalid }: JoinFlowProps) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [room, setRoom] = useState<RoomSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 服务端在预览后状态变化：提示重新确认，不静默改加入方式 */
  const [stale, setStale] = useState(false)
  const requestIdRef = useRef(newJoinRequestId())

  /** keepError=true：入座失败后的重载，保留失败原因，不让摘要刷新把它清掉 */
  const loadPreview = useCallback(async (keepError = false) => {
    setPhase('loading')
    if (!keepError) setError(null)
    try {
      const summary = await previewRoom(code)
      setRoom(summary)
      setPhase('ready')
    } catch (err) {
      setRoom(null)
      if (!keepError) {
        setError(err instanceof ApiClientError && err.code === 'room_not_found' ? '房间不存在或已关闭' : '房间摘要加载失败')
      }
      setPhase('error')
    }
  }, [code])

  useEffect(() => {
    requestIdRef.current = newJoinRequestId()
    setStale(false)
    void loadPreview()
  }, [loadPreview])

  const onJoin = () => {
    const nickError = validateNick(nick)
    if (nickError) {
      onNickInvalid?.(nickError)
      return
    }
    if (!room) return
    setPhase('joining')
    setError(null)
    joinRoom(code, {
      nick: nick.trim(),
      joinRequestId: requestIdRef.current,
      roomInstanceId: undefined,
    })
      .then((joined) => {
        saveIdentity(code, joined)
        onJoined(joined)
      })
      .catch((err: unknown) => {
        setError(joinErrorText(err))
        setPhase('ready')
        // 加入失败多因座位/房间状态在预览后变化：刷新摘要，让用户按新状态重新确认
        setStale(true)
        void loadPreview(true)
      })
  }

  if (phase === 'loading') {
    return (
      <div data-testid="join-preview-loading" role="status" className="text-body text-muted">
        正在获取房间摘要…
      </div>
    )
  }

  if (phase === 'error' || !room) {
    return (
      <div className="flex flex-col gap-3">
        <div data-testid="join-preview-error" role="alert" className="rounded-tile border border-danger/40 bg-danger/10 px-4 py-2.5 text-body text-danger">
          {error ?? '房间摘要加载失败'}
        </div>
        <div className="flex gap-2.5">
          <Button variant="outline" onClick={() => void loadPreview()}>
            重新加载
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            返回
          </Button>
        </div>
      </div>
    )
  }

  const hint = joinHint(room)
  const meta = [
    `${room.seats} 座`,
    `盲注 ${room.smallBlind}/${room.bigBlind}`,
    room.autoReveal ? '要素自动展开' : '手动展开要素',
  ]
  const people =
    room.phase === 'waiting' || !room.phase
      ? `${room.humanCount ?? room.players} 位真人 / ${room.seats} 座`
      : `${room.humanCount ?? 0} 真人 + ${room.botCount ?? 0} 机器人`

  return (
    <div className="flex flex-col gap-4" data-testid="join-preview">
      <div className="rounded-tile border border-gold/20 bg-ink-deep/40 px-4 py-3.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-serif text-tier-name tracking-[.2em] text-gold-light">{room.code}</span>
          <span className="text-body text-muted">{room.host} 的桌</span>
          <span className="ml-auto text-body text-gold-light/80">{people}</span>
        </div>
        <div className="mt-2 text-body text-muted">{meta.join(' · ')}</div>
        <p className="mt-3 text-body text-gold-light/90" data-testid="join-preview-hint">
          {hint.detail}
        </p>
      </div>

      {stale && (
        <div role="status" className="rounded-tile border border-gold/25 bg-gold/10 px-4 py-2.5 text-body text-gold-light">
          房间状态已更新，请确认最新摘要后再加入。
        </div>
      )}
      {error && (
        <div data-testid="join-error" role="alert" className="rounded-tile border border-danger/40 bg-danger/10 px-4 py-2.5 text-body text-danger">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          variant="gold"
          loading={phase === 'joining'}
          onClick={room.joinable === false ? () => void loadPreview() : onJoin}
        >
          {hint.action}
        </Button>
        <Button variant="ghost" onClick={() => void loadPreview()}>
          刷新摘要
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          返回
        </Button>
      </div>
    </div>
  )
}

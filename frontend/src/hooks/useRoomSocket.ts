import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientMessage, Envelope, StateFrame } from '../api/types'

/**
 * 对局面 WebSocket 连接（architecture.md §5）。
 *
 * - 信封 {t, seq, p}：seq 单调递增，乱序旧事件直接丢弃（snapshot 例外，始终采纳并推进基线）
 * - v2 权威状态：收到 state 帧才算 live（连接打开 ≠ 已同步）；同实例较小 revision 直接丢弃
 * - 断线自动重连（指数退避 1s→30s，最多 10 次）；重连成功后重发 join 触发服务端
 *   下发 state 帧做快照恢复（A4.3）
 * - 心跳 ping 保活
 */

/** 重连上限：超过即判定「连接失败请刷新」（RoomPage 连接状态文案消费） */
export const WS_MAX_RETRIES = 10
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30000
const PING_INTERVAL_MS = 25000

/** 入座握手参数（重连时重放 join 以恢复快照） */
export interface JoinInfo {
  roomCode: string
  nick: string
  ticket: string
  /** v2 客户端声明；服务端不支持时给版本错误 */
  protocolVersion?: number
}

/** 定时器句柄（window 定时器恒为 number，规避 DOM/Node 双环境歧义） */
type TimerId = number

interface UseRoomSocketReturn {
  /** 发送上行消息（未连接时静默丢弃，等快照恢复补状态） */
  send: (msg: ClientMessage) => void
  /** 传输层已连接（不代表已同步） */
  connected: boolean
  /** 已收到 v2 权威状态帧（游戏输入的唯一门控） */
  live: boolean
  /** 服务端时钟 - 本地时钟（毫秒，用于倒计时校正） */
  serverOffset: number
  /** 当前重连次数（0 = 未重连） */
  retries: number
}

export function useRoomSocket(
  /** WS 地址；null 表示未启用（走 mock 桌面） */
  url: string | null,
  join: JoinInfo | null,
  onEvent: (e: Envelope) => void,
): UseRoomSocketReturn {
  const wsRef = useRef<WebSocket | null>(null)
  // 连接代际：effect 重跑/StrictMode 双挂载时让在飞的旧连接自杀，防双 WS 并存
  const generationRef = useRef(0)
  const retriesRef = useRef(0)
  const [retries, setRetries] = useState(0)
  const [connected, setConnected] = useState(false)
  const [live, setLive] = useState(false)
  const [serverOffset, setServerOffset] = useState(0)
  const retryTimerRef = useRef<TimerId | undefined>(undefined)
  const pingTimerRef = useRef<TimerId | undefined>(undefined)
  // 乱序过滤：seq 基线（snapshot 全量采纳并推进）
  const lastSeqRef = useRef(0)
  // v2 权威状态：实例与 revision 基线
  const instanceRef = useRef('')
  const revisionRef = useRef(-1)
  const onEventRef = useRef(onEvent)
  const joinRef = useRef(join)

  useEffect(() => {
    onEventRef.current = onEvent
    joinRef.current = join
  }, [onEvent, join])

  const bumpRetries = useCallback(() => {
    retriesRef.current += 1
    setRetries(retriesRef.current)
  }, [])

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  const connect = useCallback(
    (gen: number) => {
      if (!url) return
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch {
        scheduleReconnect(gen)
        return
      }
      wsRef.current = ws

      ws.onopen = () => {
        if (generationRef.current !== gen) {
          ws.close()
          return
        }
        setConnected(true)
        // 不在这里清零重连计数：服务端「接受后立刻断开」时若清零，就会永远按 1s 重连。
        // 只有收到首个 v2 权威帧才算真正恢复（见 onmessage）。
        // 重连/首次入座都重放 join：服务端据此下发权威状态帧（快照恢复）
        const j = joinRef.current
        if (j) ws.send(JSON.stringify({ t: 'join', seq: 0, p: { ...j, protocolVersion: 2 } }))
        window.clearInterval(pingTimerRef.current)
        pingTimerRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: 'ping', p: {} }))
          }
        }, PING_INTERVAL_MS)
      }

      ws.onmessage = (ev) => {
        if (generationRef.current !== gen) return
        let env: Envelope
        try {
          env = JSON.parse(String(ev.data)) as Envelope
        } catch {
          return
        }
        // v2 权威帧：实例变化清空基线；同实例较小 revision 丢弃
        if (env.t === 'state') {
          const frame = env.p as StateFrame
          if (!frame || frame.protocolVersion < 2) return
          if (instanceRef.current !== frame.roomInstanceId) {
            instanceRef.current = frame.roomInstanceId
            revisionRef.current = -1
          }
          if (frame.revision < revisionRef.current) return
          // 相同 revision 只在携带回执/事件时放行（不重播旧动画）
          const duplicate = frame.revision === revisionRef.current
          if (!duplicate) revisionRef.current = frame.revision
          if (typeof frame.serverNow === 'number') setServerOffset(frame.serverNow - Date.now())
          // 权威帧到达才判定恢复完成：重连计数与退避在此清零
          if (retriesRef.current !== 0) {
            retriesRef.current = 0
            setRetries(0)
          }
          setLive(true)
          // 重连后安静房间的同 revision join 帧：只同步连接态，不重放事件内容
          if (duplicate && (frame.receipts?.length ?? 0) === 0 && (frame.events?.length ?? 0) === 0) return
        } else if (env.t === 'snapshot') {
          // 旧版快照不推进 v2 revision；仅在尚未 live 时作为兼容数据
        }
        // 乱序旧事件丢弃；snapshot 是全量真源，始终采纳
        if (env.t !== 'snapshot' && env.t !== 'state' && typeof env.seq === 'number' && env.seq <= lastSeqRef.current) {
          return
        }
        if (typeof env.seq === 'number') lastSeqRef.current = Math.max(lastSeqRef.current, env.seq)
        onEventRef.current(env)
      }

      ws.onclose = () => {
        if (generationRef.current !== gen) return
        setConnected(false)
        setLive(false)
        window.clearInterval(pingTimerRef.current)
        pingTimerRef.current = undefined
        scheduleReconnect(gen)
      }

      ws.onerror = () => {
        ws.close()
      }

      function scheduleReconnect(gen: number) {
        if (generationRef.current !== gen) return
        if (retriesRef.current >= WS_MAX_RETRIES) return
        bumpRetries()
        const delay = Math.min(BASE_DELAY_MS * 2 ** (retriesRef.current - 1), MAX_DELAY_MS)
        retryTimerRef.current = window.setTimeout(() => connect(gen), delay)
      }
    },
    [url, bumpRetries],
  )

  useEffect(() => {
    if (!url || !join) return
    const gen = ++generationRef.current
    // 新房间/新身份：重置权威状态基线
    instanceRef.current = ''
    revisionRef.current = -1
    lastSeqRef.current = 0
    setLive(false)
    connect(gen)
    return () => {
      // 代际推进使在飞回调全部失效，再关连接
      generationRef.current++
      window.clearTimeout(retryTimerRef.current)
      window.clearInterval(pingTimerRef.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [url, join, connect])

  return { send, connected, live, serverOffset, retries }
}

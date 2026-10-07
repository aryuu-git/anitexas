import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientMessage, Envelope } from '../api/types'

/**
 * 对局面 WebSocket 连接（architecture.md §5）。
 *
 * - 信封 {t, seq, p}：seq 单调递增，乱序旧事件直接丢弃（snapshot 例外，始终采纳并推进基线）
 * - 断线自动重连（指数退避 1s→30s，最多 10 次）；重连成功后重发 join 触发服务端
 *   下发 snapshot 做快照恢复（A4.3）
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
}

/** 定时器句柄（window 定时器恒为 number，规避 DOM/Node 双环境歧义） */
type TimerId = number

interface UseRoomSocketReturn {
  /** 发送上行消息（未连接时静默丢弃，等快照恢复补状态） */
  send: (msg: ClientMessage) => void
  connected: boolean
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
  const retryTimerRef = useRef<TimerId | undefined>(undefined)
  const pingTimerRef = useRef<TimerId | undefined>(undefined)
  // 乱序过滤：seq 基线（snapshot 全量采纳并推进）
  const lastSeqRef = useRef(0)
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
        retriesRef.current = 0
        setRetries(0)
        // 重连/首次入座都重放 join：服务端据此下发 snapshot（快照恢复）
        const j = joinRef.current
        if (j) ws.send(JSON.stringify({ t: 'join', seq: 0, p: j }))
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
        // 乱序旧事件丢弃；snapshot 是全量真源，始终采纳
        if (env.t !== 'snapshot' && typeof env.seq === 'number' && env.seq <= lastSeqRef.current) {
          return
        }
        if (typeof env.seq === 'number') lastSeqRef.current = Math.max(lastSeqRef.current, env.seq)
        onEventRef.current(env)
      }

      ws.onclose = () => {
        if (generationRef.current !== gen) return
        setConnected(false)
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

  return { send, connected, retries }
}

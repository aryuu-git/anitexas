// @vitest-environment happy-dom
// v2 连接门控回归：接受后立刻断开不应把重连计数清零；收到权威帧才算恢复并清零；
// revision/实例门控丢弃旧帧，同 revision 仅放行带回执/事件的帧。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRoomSocket, WS_MAX_RETRIES } from './useRoomSocket'
import type { Envelope, StateFrame } from '../api/types'

class FakeSocket {
  static instances: FakeSocket[] = []
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3

  readyState = FakeSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }

  /** 模拟握手成功 */
  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  /** 模拟服务端接受后立刻断开 */
  drop() {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }

  receive(env: Envelope) {
    this.onmessage?.({ data: JSON.stringify(env) })
  }

  static latest(): FakeSocket {
    const s = FakeSocket.instances[FakeSocket.instances.length - 1]
    if (!s) throw new Error('no socket')
    return s
  }
}

const join = { roomCode: 'SAKURA', nick: '你', ticket: 't1', protocolVersion: 2 }

function frame(over: Partial<StateFrame> = {}): StateFrame {
  return {
    protocolVersion: 2,
    roomCode: 'SAKURA',
    roomInstanceId: 'inst-1',
    revision: 1,
    serverNow: Date.now(),
    reason: 'join',
    state: {} as StateFrame['state'],
    events: [],
    receipts: [],
    ...over,
  }
}

const stateEnv = (seq: number, f: StateFrame): Envelope => ({ t: 'state', seq, p: f })

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useRoomSocket 重连与权威门控', () => {
  it('接受后立刻断开：重连计数累计到上限后停止，不会无限按 1s 重连', async () => {
    const onEvent = vi.fn()
    const { result } = renderHook(() => useRoomSocket('ws://test', join, onEvent))
    expect(FakeSocket.instances).toHaveLength(1)

    // 每次「打开→立刻断开」，再推进足够时间触发下一次重连
    for (let i = 0; i < WS_MAX_RETRIES + 2; i++) {
      act(() => FakeSocket.latest().open())
      act(() => FakeSocket.latest().drop())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31000)
      })
      if (FakeSocket.instances.length >= WS_MAX_RETRIES + 1) break
    }

    // 首次连接 + 最多 WS_MAX_RETRIES 次重连，不会更多
    expect(FakeSocket.instances.length).toBeLessThanOrEqual(WS_MAX_RETRIES + 1)
    expect(result.current.retries).toBe(WS_MAX_RETRIES)
    expect(result.current.live).toBe(false)
  })

  it('收到首个 v2 权威帧才 live，并把重连计数清零', async () => {
    const onEvent = vi.fn()
    const { result } = renderHook(() => useRoomSocket('ws://test', join, onEvent))

    act(() => FakeSocket.latest().open())
    act(() => FakeSocket.latest().drop())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(result.current.retries).toBe(1)
    expect(result.current.live).toBe(false)

    const socket = FakeSocket.latest()
    act(() => socket.open())
    await act(async () => {
      socket.receive(stateEnv(1, frame()))
    })

    expect(result.current.live).toBe(true)
    expect(result.current.retries).toBe(0)
    expect(result.current.connected).toBe(true)
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it('断线重连后收到同 revision 的 join 帧：live=true 且重连计数清零', async () => {
    const onEvent = vi.fn()
    const { result } = renderHook(() => useRoomSocket('ws://test', join, onEvent))

    const first = FakeSocket.latest()
    act(() => first.open())
    await act(async () => {
      first.receive(stateEnv(1, frame({ revision: 0 })))
    })
    expect(result.current.live).toBe(true)

    act(() => first.drop())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(result.current.retries).toBe(1)
    expect(result.current.live).toBe(false)

    const second = FakeSocket.latest()
    act(() => second.open())
    await act(async () => {
      second.receive(stateEnv(2, frame({ revision: 0 })))
    })

    expect(result.current.live).toBe(true)
    expect(result.current.retries).toBe(0)
  })

  it('低 revision 丢弃；同 revision 仅放行带回执的帧', async () => {
    const onEvent = vi.fn()
    const { result } = renderHook(() => useRoomSocket('ws://test', join, onEvent))
    const socket = FakeSocket.latest()
    act(() => socket.open())

    await act(async () => {
      socket.receive(stateEnv(1, frame({ revision: 3 })))
      socket.receive(stateEnv(2, frame({ revision: 2 }))) // 旧帧
      socket.receive(stateEnv(3, frame({ revision: 3 }))) // 同 revision 无回执/事件
      socket.receive(
        stateEnv(4, frame({ revision: 3, receipts: [{ requestId: 'r1', status: 'applied' }] })),
      )
    })

    expect(result.current.live).toBe(true)
    expect(onEvent).toHaveBeenCalledTimes(2) // 首个 rev3 + 带回执的 rev3
    const calls = onEvent.mock.calls
    const last = calls[calls.length - 1][0] as Envelope
    expect((last.p as StateFrame).receipts[0].requestId).toBe('r1')
  })

  it('实例变化重置 revision 基线，新实例低 revision 也采纳', async () => {
    const onEvent = vi.fn()
    renderHook(() => useRoomSocket('ws://test', join, onEvent))
    const socket = FakeSocket.latest()
    act(() => socket.open())

    await act(async () => {
      socket.receive(stateEnv(1, frame({ roomInstanceId: 'inst-1', revision: 9 })))
      socket.receive(stateEnv(2, frame({ roomInstanceId: 'inst-2', revision: 1 })))
    })

    expect(onEvent).toHaveBeenCalledTimes(2)
    const calls = onEvent.mock.calls
    expect(((calls[calls.length - 1][0] as Envelope).p as StateFrame).roomInstanceId).toBe('inst-2')
  })
})

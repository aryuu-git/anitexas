// @vitest-environment happy-dom
// 短命状态自动过期：pendingType 超时解锁、lastError 提示自动清除（token 变化重置计时，
// 页面重渲不推倒计时）。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { useAutoExpire } from './useAutoExpire'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** 定时器观测台：token 非空起 ttl 后计一次过期 */
function ExpiryProbe({ token, ttl, onExpire }: { token: unknown; ttl: number; onExpire: () => void }) {
  useAutoExpire(token, ttl, onExpire)
  return null
}

/** lastError 消费台：与对局桌同构（提示到点自动清） */
function ErrorProbe() {
  const [lastError, setLastError] = useState<string | null>(null)
  useAutoExpire(lastError, 5000, () => setLastError(null))
  return (
    <div>
      <button type="button" onClick={() => setLastError('服务端未确认')}>
        报错
      </button>
      {lastError && <div role="alert">{lastError}</div>}
    </div>
  )
}

describe('useAutoExpire 自动过期', () => {
  it('token 非空：ttl 到点触发 onExpire；token 清空后不再触发', () => {
    const onExpire = vi.fn()
    const { rerender } = render(<ExpiryProbe token="err" ttl={5000} onExpire={onExpire} />)
    act(() => void vi.advanceTimersByTime(4999))
    expect(onExpire).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(1))
    expect(onExpire).toHaveBeenCalledTimes(1)
    rerender(<ExpiryProbe token={null} ttl={5000} onExpire={onExpire} />)
    act(() => void vi.advanceTimersByTime(5000))
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('token 变化重置计时；回调换身份（页面重渲）不推倒计时', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<ExpiryProbe token="err" ttl={5000} onExpire={first} />)
    act(() => void vi.advanceTimersByTime(2000))
    // token 换新值：旧计时取消、重新起表（若未重置，first 会在 t=5s 被调用）
    rerender(<ExpiryProbe token="err2" ttl={5000} onExpire={first} />)
    act(() => void vi.advanceTimersByTime(4000))
    expect(first).not.toHaveBeenCalled()
    // 重渲只换回调身份、token 不变：原计时器继续走（若被推倒，t=7s 不会触发）
    rerender(<ExpiryProbe token="err2" ttl={5000} onExpire={second} />)
    act(() => void vi.advanceTimersByTime(1000))
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('lastError 提示到点自动清除', () => {
    render(<ErrorProbe />)
    fireEvent.click(screen.getByText('报错'))
    expect(screen.getByRole('alert').textContent).toBe('服务端未确认')
    act(() => void vi.advanceTimersByTime(5000))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

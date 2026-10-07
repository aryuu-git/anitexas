import { useEffect, useRef } from 'react'

/**
 * 短命状态自动过期：token 非空起 ttlMs 后触发 onExpire；token 变化即重置计时。
 * 两处消费（对局桌）：
 *   - pendingType 超时未获服务端确认 → 自动解锁并提示「服务端未确认」
 *   - lastError 提示到点 → 自动清除
 * 回调经 ref 订阅：页面常态重渲（倒计时 tick 等）不会把计时器推倒重来。
 */

/** 动作确认超时（ms）：到点未收到服务端回执即自动解锁 */
export const PENDING_CONFIRM_MS = 5000

/** 提示文案寿命（ms）：到点自动清除 */
export const NOTICE_TTL_MS = 5000

export function useAutoExpire(token: unknown, ttlMs: number, onExpire: () => void): void {
  const expireRef = useRef(onExpire)
  useEffect(() => {
    expireRef.current = onExpire
  })

  useEffect(() => {
    if (token === null || token === undefined) return
    const timer = window.setTimeout(() => expireRef.current(), ttlMs)
    return () => window.clearTimeout(timer)
  }, [token, ttlMs])
}

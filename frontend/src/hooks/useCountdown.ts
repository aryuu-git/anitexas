import { useEffect, useState } from 'react'

/**
 * 行动倒计时：输入截止时刻（epoch ms），返回剩余秒数（向上取整，最小 0）。
 * 250ms 一拍，保证倒计时环走针平滑；deadline 为 null 时返回 0。
 * serverOffset = 服务端时刻 - 本地时刻（毫秒）：v2 用 serverNow 校正时差，
 * 每次权威帧重新同步；0 表示未校正（旧版/本地演示）。
 */
export function useCountdown(deadline: number | null, serverOffset = 0): number {
  const [remaining, setRemaining] = useState(() => computeRemaining(deadline, serverOffset))

  useEffect(() => {
    if (deadline === null) {
      setRemaining(0)
      return
    }
    // 立即对齐一次，再定周期刷新
    setRemaining(computeRemaining(deadline, serverOffset))
    const timer = window.setInterval(() => setRemaining(computeRemaining(deadline, serverOffset)), 250)
    return () => window.clearInterval(timer)
  }, [deadline, serverOffset])

  return remaining
}

/** 剩余秒数计算（向上取整：最后 1 秒内仍显示 1，避免「还剩 0 秒」的错觉） */
function computeRemaining(deadline: number | null, serverOffset: number): number {
  if (deadline === null) return 0
  return Math.max(0, Math.ceil((deadline - (Date.now() + serverOffset)) / 1000))
}

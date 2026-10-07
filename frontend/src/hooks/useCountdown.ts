import { useEffect, useState } from 'react'

/**
 * 行动倒计时：输入截止时刻（epoch ms），返回剩余秒数（向上取整，最小 0）。
 * 250ms 一拍，保证倒计时环走针平滑；deadline 为 null 时返回 0。
 */
export function useCountdown(deadline: number | null): number {
  const [remaining, setRemaining] = useState(() => computeRemaining(deadline))

  useEffect(() => {
    if (deadline === null) {
      setRemaining(0)
      return
    }
    // 立即对齐一次，再定周期刷新
    setRemaining(computeRemaining(deadline))
    const timer = window.setInterval(() => setRemaining(computeRemaining(deadline)), 250)
    return () => window.clearInterval(timer)
  }, [deadline])

  return remaining
}

/** 剩余秒数计算（向上取整：最后 1 秒内仍显示 1，避免「还剩 0 秒」的错觉） */
function computeRemaining(deadline: number | null): number {
  if (deadline === null) return 0
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
}

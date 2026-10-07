import { useEffect, useState } from 'react'

/**
 * 赢家扫光：赢家确定时递增 token（一次性动画，1.6s 后自隐），供桌沿跑一圈金光。
 */
export function useTableSweep(winnerSeat: number | null): number {
  const [token, setToken] = useState(0)
  useEffect(() => {
    if (winnerSeat != null) setToken((t) => t + 1)
  }, [winnerSeat])
  return token
}

import { useCallback, type CSSProperties } from 'react'

/**
 * 发牌动画：以「手数」为 token，让牌面/座位牌背重挂载并播放发牌动画；
 * 按座位序号给出错峰延迟（从庄家位依次发出）。
 */
export function useDealAnimation(handSeq: number) {
  const key = `hand-${handSeq}`
  const delayFor = useCallback(
    (order: number): CSSProperties => ({ '--deal-delay': `${Math.max(0, order) * 70}ms` }) as CSSProperties,
    [],
  )
  return { key, delayFor }
}

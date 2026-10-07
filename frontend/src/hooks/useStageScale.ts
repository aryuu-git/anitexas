import { useEffect, useState } from 'react'

/**
 * 舞台等比缩放：对局桌按固定设计尺寸（STAGE_W × STAGE_H）排版，
 * 再按视口等比缩放，保证「一页显示」（不出现纵向滚动）。
 * 上限 maxScale 防止大屏被拉得过大；下限 minScale 防止小屏被压得过小——
 * 视口低于下限时返回 minScale，由外层容器滚动兜底（移动端）。
 */
export function useStageScale(
  stageW: number,
  stageH: number,
  maxScale = 1.35,
  minScale = 0.6,
): number {
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const compute = () => {
      const s = Math.min(window.innerWidth / stageW, window.innerHeight / stageH)
      setScale(Math.min(Math.max(s, minScale), maxScale))
    }
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [stageW, stageH, maxScale, minScale])

  return scale
}

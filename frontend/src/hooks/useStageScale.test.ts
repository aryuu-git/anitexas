// @vitest-environment happy-dom
// 舞台缩放契约：下限 0.6（视口过小时返回下限，由外层滚动兜底）、上限 1.35、
// 视口等比、minScale 可调、resize 重算。
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useStageScale } from './useStageScale'

afterEach(cleanup)

/** 设置视口尺寸（happy-dom 下 innerWidth/innerHeight 可覆写） */
function setViewport(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: h })
}

describe('useStageScale 舞台缩放', () => {
  it('视口过小：scale 不低于下限 0.6（外层滚动兜底）', () => {
    setViewport(400, 300) // 400/1000 = 0.4 < 0.6
    const { result } = renderHook(() => useStageScale(1000, 600))
    expect(result.current).toBeCloseTo(0.6)
  })

  it('视口过大：scale 不超过上限 1.35', () => {
    setViewport(3000, 2000) // 3.0 > 1.35
    const { result } = renderHook(() => useStageScale(1000, 600))
    expect(result.current).toBeCloseTo(1.35)
  })

  it('常规视口：按视口/设计尺寸等比；resize 重新计算', () => {
    setViewport(1000, 600)
    const { result } = renderHook(() => useStageScale(1000, 600))
    expect(result.current).toBeCloseTo(1)
    act(() => {
      setViewport(750, 450)
      window.dispatchEvent(new Event('resize'))
    })
    expect(result.current).toBeCloseTo(0.75)
  })

  it('minScale 可调：下限参数生效', () => {
    setViewport(400, 300) // 0.4
    const { result } = renderHook(() => useStageScale(1000, 600, 1.35, 0.3))
    expect(result.current).toBeCloseTo(0.4)
  })
})

// @vitest-environment happy-dom
// 阶段进度：未发生的轮次标「跳过」而不是完成；全下直发有徽标；当前轮高亮。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { PhaseStep } from '../../api/experienceState'
import { PhaseProgress } from './PhaseProgress'

afterEach(cleanup)

const step = (key: PhaseStep['key'], label: string, status: PhaseStep['status']): PhaseStep => ({
  key,
  label,
  detail: '',
  status,
})

describe('PhaseProgress 阶段进度', () => {
  it('显示第 X 手与四轮状态；跳过不等于完成', () => {
    render(
      <PhaseProgress
        handSeq={3}
        steps={[
          step('preflop', '第 1 轮 · 底牌下注', 'done'),
          step('flop', '第 2 轮 · 翻牌', 'current'),
          step('turn', '第 3 轮 · 转牌', 'skipped'),
          step('river', '第 4 轮 · 河牌', 'skipped'),
        ]}
      />,
    )
    expect(screen.getByText('第 3 手')).toBeTruthy()
    expect(screen.getByTestId('phase-step-preflop').getAttribute('data-status')).toBe('done')
    expect(screen.getByTestId('phase-step-flop').getAttribute('data-status')).toBe('current')
    expect(screen.getByTestId('phase-step-turn').getAttribute('data-status')).toBe('skipped')
    expect(screen.getAllByText('（跳过）')).toHaveLength(2)
    expect(screen.queryByText('全下发牌')).toBeNull()
  })

  it('全下直发显示徽标', () => {
    render(
      <PhaseProgress
        handSeq={1}
        runout
        steps={[
          step('preflop', '第 1 轮 · 底牌下注', 'done'),
          step('flop', '第 2 轮 · 翻牌', 'done'),
          step('turn', '第 3 轮 · 转牌', 'done'),
          step('river', '第 4 轮 · 河牌', 'done'),
        ]}
      />,
    )
    expect(screen.getByText('全下发牌')).toBeTruthy()
  })
})

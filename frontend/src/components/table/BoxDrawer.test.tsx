// @vitest-environment happy-dom
// 牌池抽屉回归：盒名单（名称/评分/档位/年份）+ 牌池摘要 + 主题过滤回退显著提示。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { BoxDrawer } from './BoxDrawer'
import type { BoxCard, PoolInfo } from '../../api/types'

afterEach(cleanup)

const box: BoxCard[] = [
  { id: 101, title: '你的名字。', score: 8.4, bucket: 8.5, year: 2016 },
  { id: 103, title: 'CLANNAD', score: 8.4, bucket: 8.5, year: 2007 },
]

const pool: PoolInfo = {
  strategy: 'theme',
  theme: { kind: 'company', value: '京都动画' },
  poolSize: 13,
  fallback: true,
}

describe('BoxDrawer 牌池抽屉', () => {
  it('展示盒名单（名称/评分/档位/年份）与牌池摘要', () => {
    render(<BoxDrawer open onClose={vi.fn()} box={box} pool={{ ...pool, fallback: false }} />)
    const rows = screen.getAllByTestId('box-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('你的名字。')
    expect(rows[0].textContent).toContain('8.4 分')
    expect(rows[0].textContent).toContain('8.5 档')
    expect(rows[0].textContent).toContain('2016')
    const summary = screen.getByTestId('pool-summary').textContent ?? ''
    expect(summary).toContain('主题池')
    expect(summary).toContain('京都动画')
    expect(summary).toContain('13')
  })

  it('pool.fallback=true 显著提示「主题过滤过窄，已回退全库」', () => {
    render(<BoxDrawer open onClose={vi.fn()} box={box} pool={pool} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('主题过滤过窄，已回退全库')
  })

  it('收起时不渲染；名单空时给兜底文案', () => {
    const { rerender } = render(<BoxDrawer open={false} onClose={vi.fn()} box={box} pool={pool} />)
    expect(screen.queryByTestId('box-dock')).toBeNull()
    rerender(<BoxDrawer open onClose={vi.fn()} box={[]} pool={null} />)
    expect(screen.getByText('名单未下发')).toBeTruthy()
    expect(screen.getByText('牌池摘要未下发')).toBeTruthy()
  })
})

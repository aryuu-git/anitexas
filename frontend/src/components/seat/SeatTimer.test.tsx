// @vitest-environment happy-dom
// SeatTimer 回归：无截止不渲染；有截止渲染进度环。
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { SeatTimer } from './SeatTimer'

afterEach(cleanup)

describe('SeatTimer 计时环', () => {
  it('deadline 为 null：不渲染', () => {
    const { container } = render(<SeatTimer deadline={null} total={30} />)
    expect(container.querySelector('[data-testid="seat-timer"]')).toBeNull()
  })

  it('有截止：渲染进度环并带剩余秒数标签', () => {
    const { container } = render(<SeatTimer deadline={Date.now() + 12000} total={30} />)
    const el = container.querySelector('[data-testid="seat-timer"]')
    expect(el).toBeTruthy()
    expect(el?.getAttribute('aria-label')).toMatch(/剩余 \d+ 秒/)
  })
})

// @vitest-environment happy-dom
// BetSlider 回归：数字输入与滑条同受控，键入值夹紧到 [min, max]（大底池精确键入）。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BetSlider } from './BetSlider'

afterEach(cleanup)

describe('BetSlider 下注滑条', () => {
  it('数字输入键入即夹紧到区间：超上限取 max、低于下限取 min', () => {
    const onChange = vi.fn()
    render(<BetSlider min={10} max={100} value={50} onChange={onChange} />)
    const input = screen.getByLabelText('下注金额')
    fireEvent.change(input, { target: { value: '999' } })
    expect(onChange).toHaveBeenLastCalledWith(100)
    fireEvent.change(input, { target: { value: '3' } })
    expect(onChange).toHaveBeenLastCalledWith(10)
  })

  it('受控回显 value；disabled 时输入与滑条都禁用', () => {
    render(<BetSlider min={10} max={100} value={42} disabled onChange={vi.fn()} />)
    expect((screen.getByLabelText('下注金额') as HTMLInputElement).value).toBe('42')
    expect((screen.getByLabelText('下注金额') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('下注金额滑条') as HTMLInputElement).disabled).toBe(true)
  })
})

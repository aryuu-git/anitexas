// @vitest-environment happy-dom
// ChipStack 回归：金额 → 面额分层渲染（降序），0/负数不渲染。
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ChipStack } from './ChipStack'

afterEach(cleanup)

describe('ChipStack 筹码堆', () => {
  it('按面额降序分层渲染', () => {
    const { container } = render(<ChipStack amount={137} />)
    const denoms = [...container.querySelectorAll('[data-denom]')].map((e) => e.getAttribute('data-denom'))
    expect(denoms).toEqual(['100', '25', '5', '1'])
  })

  it('0 / 负数不渲染', () => {
    expect(render(<ChipStack amount={0} />).container.querySelector('[data-testid="chip-stack"]')).toBeNull()
    cleanup()
    expect(render(<ChipStack amount={-3} />).container.querySelector('[data-testid="chip-stack"]')).toBeNull()
  })
})

// @vitest-environment happy-dom
// PlayerSeat 回归：他人牌背/自己大牌、行动态（环+计时）、弃牌 muck、远近侧 DOM 顺序。
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { PlayerSeat } from './PlayerSeat'
import type { SeatState } from '../../api/types'

afterEach(cleanup)

const base: SeatState = {
  seat: 1,
  nick: 'bot·樱',
  chips: 200,
  points: 0,
  bet: 0,
  folded: false,
  acted: false,
  isDealer: false,
  holeCount: 2,
  ready: false,
  rebuys: 0,
}

const order = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-testid="seat-plate"],[data-testid="hole-card-backs"]')].map((e) =>
    e.getAttribute('data-testid'),
  )

describe('PlayerSeat 座位', () => {
  it('他人座位：牌背 + 头像 + 名牌', () => {
    const { container } = render(<PlayerSeat seat={base} isTurn={false} />)
    expect(container.querySelector('[data-testid="hole-card-backs"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="seat-avatar"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="seat-plate"]')).toBeTruthy()
  })

  it('自己座位：不显示牌背（底牌由桌面下方大牌展示）', () => {
    const { container } = render(<PlayerSeat seat={{ ...base, seat: 0 }} isTurn={false} isMe />)
    expect(container.querySelector('[data-testid="hole-card-backs"]')).toBeNull()
  })

  it('行动中：状态环 acting + 计时环在场', () => {
    const { container } = render(<PlayerSeat seat={base} isTurn deadline={Date.now() + 20000} />)
    expect(container.querySelector('[data-testid="status-ring"]')?.getAttribute('data-state')).toBe('acting')
    expect(container.querySelector('[data-testid="seat-timer"]')).toBeTruthy()
  })

  it('弃牌：状态环 folded + 牌背 muck 态', () => {
    const { container } = render(<PlayerSeat seat={{ ...base, folded: true }} isTurn={false} />)
    expect(container.querySelector('[data-testid="status-ring"]')?.getAttribute('data-state')).toBe('folded')
    expect(container.querySelector('[data-testid="hole-card-backs"]')?.getAttribute('data-state')).toBe('muck')
  })

  it('赢家优先于其它状态', () => {
    const { container } = render(<PlayerSeat seat={{ ...base, folded: true }} isTurn winner />)
    expect(container.querySelector('[data-testid="status-ring"]')?.getAttribute('data-state')).toBe('winner')
  })

  it('朝向：近侧牌背在前，远侧牌背在后', () => {
    expect(order(render(<PlayerSeat seat={base} isTurn={false} facing={1} />).container)).toEqual([
      'hole-card-backs',
      'seat-plate',
    ])
    cleanup()
    expect(order(render(<PlayerSeat seat={base} isTurn={false} facing={-1} />).container)).toEqual([
      'seat-plate',
      'hole-card-backs',
    ])
  })

  it('准备标记与重买计数：ready 显示「准备」，rebuys>0 显示「重买×N」', () => {
    const { container, rerender } = render(<PlayerSeat seat={{ ...base, ready: true }} isTurn={false} />)
    expect(container.querySelector('[data-testid="ready-badge"]')?.textContent).toBe('准备')
    expect(container.querySelector('[data-testid="rebuy-badge"]')).toBeNull()
    rerender(<PlayerSeat seat={{ ...base, ready: true, rebuys: 2 }} isTurn={false} />)
    expect(container.querySelector('[data-testid="rebuy-badge"]')?.textContent).toBe('重买×2')
  })

  it('默认不显示准备/重买小签', () => {
    const { container } = render(<PlayerSeat seat={base} isTurn={false} />)
    expect(container.querySelector('[data-testid="ready-badge"]')).toBeNull()
    expect(container.querySelector('[data-testid="rebuy-badge"]')).toBeNull()
  })
})

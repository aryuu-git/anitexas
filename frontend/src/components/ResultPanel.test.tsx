// @vitest-environment happy-dom
// 结算面板回归：dialog 语义 + 打开焦点落在主按钮 + ESC 关闭不发 ready + 离开/立即开始回调
// + 下一手倒计时展示。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ResultPanel } from './ResultPanel'
import type { SettledPayload, SeatState } from '../api/types'

afterEach(cleanup)

const settled: SettledPayload = {
  rows: [{ seat: 0, chipsDelta: 180, points: { handScore: 42, bondBonus: 12, revealCost: 0 } }],
  potWins: { 0: 180 },
}

const seats: SeatState[] = [
  {
    seat: 0,
    nick: '你',
    chips: 1180,
    points: 54,
    bet: 0,
    folded: false,
    acted: true,
    isDealer: true,
    holeCount: 2,
    ready: false,
    rebuys: 0,
  },
]

const base = {
  showdown: null,
  settled,
  seats,
  mySeat: 0,
  onReady: vi.fn(),
  onLeave: vi.fn(),
  onClose: vi.fn(),
  nextHandAt: Date.now() + 8000,
  showCover: false,
}

describe('ResultPanel 结算面板', () => {
  it('dialog 语义：role=dialog 且 aria-modal，打开时焦点落在主按钮', () => {
    render(<ResultPanel {...base} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /立即开始/ }))
  })

  it('ESC 关闭面板，不发 ready', () => {
    const onReady = vi.fn()
    const onClose = vi.fn()
    render(<ResultPanel {...base} onReady={onReady} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onReady).not.toHaveBeenCalled()
  })

  it('「离开」回大厅、「立即开始」发 ready', () => {
    const onReady = vi.fn()
    const onLeave = vi.fn()
    render(<ResultPanel {...base} onReady={onReady} onLeave={onLeave} />)
    fireEvent.click(screen.getByRole('button', { name: '离开' }))
    expect(onLeave).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /立即开始/ }))
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('展示下一手倒计时（nextHandAt）', () => {
    render(<ResultPanel {...base} />)
    expect(screen.getByTestId('next-hand-countdown').textContent).toMatch(/下一手 \d+ 秒后开始/)
  })

  it('无主按钮时焦点落在面板本身', () => {
    render(<ResultPanel {...base} onReady={undefined} />)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })
})

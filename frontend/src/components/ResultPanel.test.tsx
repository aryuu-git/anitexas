// @vitest-environment happy-dom
// 结算面板回归（产品设计 §7）：本人优先首屏、真实获奖名单、折叠明细、
// 准备反馈、自动下一手、回顾只读、ESC/关闭不发 ready、焦点恢复。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ResultPanel } from './ResultPanel'
import type { CardData, SeatState, SettledPayload, ShowdownHand } from '../api/types'

afterEach(cleanup)

const settled: SettledPayload = {
  rows: [
    { seat: 0, chipsDelta: 180, points: { handScore: 42, bondBonus: 12, revealCost: 0 } },
    { seat: 1, chipsDelta: -180, points: { handScore: 8, bondBonus: 0, revealCost: 2 } },
  ],
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
  {
    seat: 1,
    nick: '樱',
    chips: 820,
    points: 0,
    bet: 0,
    folded: false,
    acted: true,
    isDealer: false,
    holeCount: 2,
    ready: false,
    rebuys: 0,
  },
]

function card(id: number): CardData {
  return { id, title: `牌 ${id}`, score: 80, bucket: 3, year: 2015, monogram: `牌` }
}

const showdown: ShowdownHand[] = [
  { seat: 0, cards: [card(1), card(2), card(3), card(4), card(5)], groups: [[0, 1]], tier: 4, tiebreak: [1] },
  { seat: 1, cards: [card(6), card(7), card(8), card(9), card(10)], groups: [], tier: 2, tiebreak: [0] },
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
  nextHandPolicy: 'automatic' as const,
  showCover: false,
}

describe('ResultPanel 结算面板', () => {
  it('首屏先给本人筹码/积分净变化与赢得底池，明细默认折叠', () => {
    render(<ResultPanel {...base} />)
    expect(screen.getByTestId('my-chips-delta').textContent).toBe('+180')
    expect(screen.getByTestId('my-points-delta').textContent).toBe('+54')
    expect(screen.getByTestId('my-pot-win').textContent).toContain('赢得底池 180')
    expect((screen.getByTestId('result-details') as HTMLDetailsElement).open).toBe(false)
  })

  it('按 potWins 展示多位获奖者，不把牌力首位标成唯一赢家', () => {
    render(
      <ResultPanel
        {...base}
        settled={{ ...settled, potWins: { 0: 120, 1: 80 } }}
        showdown={showdown}
      />,
    )
    const rows = screen.getAllByTestId('winner-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('赢得 120')
    expect(rows[1].textContent).toContain('赢得 80')
    expect(document.body.textContent).not.toMatch(/唯一赢家|获胜者/)
  })

  it('弃牌提前结束：说明原因且明细里明确没有摊牌对比', () => {
    render(<ResultPanel {...base} endReason="fold_win" />)
    expect(screen.getByTestId('result-reason').textContent).toContain('其他玩家弃牌，提前收池')
    expect(screen.getByTestId('result-details').textContent).toContain('本手没有摊牌对比')
  })

  it('摊牌明细区分「牌力排名」与「筹码获奖」标签', () => {
    render(<ResultPanel {...base} showdown={showdown} endReason="showdown" />)
    const details = screen.getByTestId('result-details')
    expect(details.textContent).toContain('牌力第 1')
    expect(details.textContent).toContain('牌力第 2')
    expect(details.textContent).toContain('赢得 180')
  })

  it('准备下一手：点击发 ready；已准备显示等待反馈并禁用', () => {
    const onReady = vi.fn()
    const { rerender } = render(<ResultPanel {...base} onReady={onReady} />)
    fireEvent.click(screen.getByRole('button', { name: '准备下一手' }))
    expect(onReady).toHaveBeenCalledTimes(1)

    rerender(<ResultPanel {...base} onReady={onReady} myReady />)
    const ready = screen.getByRole('button', { name: '已准备，等待其他玩家' })
    expect((ready as HTMLButtonElement).disabled).toBe(true)
  })

  it('准备确认中显示 loading 且不可重复点击', () => {
    const onReady = vi.fn()
    render(<ResultPanel {...base} onReady={onReady} pendingReady />)
    const btn = screen.getByRole('button', { name: '准备下一手' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect(btn.getAttribute('aria-busy')).toBe('true')
  })

  it('自动下一手显示真实秒数，倒计时归零后显示正在确认', () => {
    const { rerender } = render(<ResultPanel {...base} />)
    expect(screen.getByTestId('next-hand-status').textContent).toMatch(/下一手 \d+ 秒后开始/)

    rerender(<ResultPanel {...base} nextHandAt={Date.now() - 1000} />)
    expect(screen.getByTestId('next-hand-status').textContent).toBe('正在确认下一手…')
  })

  it('手动模式提示全体真人准备后开始，取消排程不臆造倒计时', () => {
    render(<ResultPanel {...base} nextHandPolicy="manual" nextHandAt={null} />)
    expect(screen.getByTestId('next-hand-status').textContent).toBe('全体真人准备后开始')
  })

  it('ESC 关闭面板，不发 ready', () => {
    const onReady = vi.fn()
    const onClose = vi.fn()
    render(<ResultPanel {...base} onReady={onReady} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onReady).not.toHaveBeenCalled()
  })

  it('「离开」回大厅、「准备下一手」发 ready，关闭不发 ready', () => {
    const onReady = vi.fn()
    const onLeave = vi.fn()
    const onClose = vi.fn()
    render(<ResultPanel {...base} onReady={onReady} onLeave={onLeave} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: '离开' }))
    expect(onLeave).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '准备下一手' }))
    expect(onReady).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '关闭结算' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('回顾模式只读：保留结果明细，不提供准备/离开与下一手排程', () => {
    const onReady = vi.fn()
    const onLeave = vi.fn()
    const onClose = vi.fn()
    render(
      <ResultPanel
        {...base}
        review
        showdown={showdown}
        endReason="showdown"
        onReady={onReady}
        onLeave={onLeave}
        onClose={onClose}
      />,
    )
    expect(screen.getByTestId('result-reason').textContent).toContain('这是上一手的结果')
    expect(screen.queryByTestId('next-hand-status')).toBeNull()
    expect(screen.queryByRole('button', { name: '准备下一手' })).toBeNull()
    expect(screen.queryByRole('button', { name: '离开' })).toBeNull()
    expect(screen.getByTestId('my-chips-delta').textContent).toBe('+180')

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onReady).not.toHaveBeenCalled()
  })

  it('dialog 语义：role=dialog 且 aria-modal，打开时焦点落在主按钮', () => {
    render(<ResultPanel {...base} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '准备下一手' }))
  })

  it('无主按钮时焦点落在关闭按钮', () => {
    render(<ResultPanel {...base} onReady={undefined} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭结算' }))
  })

  it('触发按钮已卸载时按 returnFocusSelector 恢复焦点', () => {
    const trigger = document.createElement('button')
    trigger.textContent = '查看本手结果'
    document.body.appendChild(trigger)
    trigger.focus()

    const fallback = document.createElement('button')
    fallback.setAttribute('data-testid', 'review-result')
    fallback.textContent = '查看本手结果'
    document.body.appendChild(fallback)

    const { unmount } = render(
      <ResultPanel {...base} returnFocusSelector='[data-testid="review-result"]' />,
    )
    // 打开面板时触发按钮被条件卸载
    trigger.remove()
    unmount()
    expect(document.activeElement).toBe(fallback)

    fallback.remove()
  })

  it('关闭后焦点回到打开前的触发点', () => {
    const trigger = document.createElement('button')
    trigger.textContent = '查看结果'
    document.body.appendChild(trigger)
    trigger.focus()

    const { unmount } = render(<ResultPanel {...base} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '准备下一手' }))

    unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})

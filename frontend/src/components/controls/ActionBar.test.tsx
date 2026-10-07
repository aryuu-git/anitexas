// @vitest-environment happy-dom
// ActionBar 回归：动作可用性（无注/有注/短码/非自己回合）+ 目标金额语义（下注到/加注到，
// minRaise 下限、换手重置夹紧）+ 全下可达 + 快捷键 + 倒计时告急变红。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ActionBar } from './ActionBar'

afterEach(cleanup)

const base = {
  pot: 30,
  toCall: 0,
  currentBet: 0,
  bigBlind: 10,
  myChips: 500,
  isMyTurn: true,
  pendingType: null,
  deadline: null,
  onAction: vi.fn(),
}

const btn = (t: string) =>
  screen.getByTestId('action-group').querySelector(`[data-action="${t}"]`) as HTMLButtonElement
const quickPick = (label: string) =>
  [...screen.getByTestId('quick-bet').querySelectorAll('button')].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement

describe('ActionBar 行动条', () => {
  it('无注回合：过牌/下注/弃牌可点，跟注/加注禁用', () => {
    render(<ActionBar {...base} />)
    expect(btn('check').disabled).toBe(false)
    expect(btn('bet').disabled).toBe(false)
    expect(btn('fold').disabled).toBe(false)
    expect(btn('call').disabled).toBe(true)
    expect(btn('raise').disabled).toBe(true)
  })

  it('点过牌回调 check', () => {
    const onAction = vi.fn()
    render(<ActionBar {...base} onAction={onAction} />)
    fireEvent.click(btn('check'))
    expect(onAction).toHaveBeenCalledWith('check')
  })

  it('有注回合：跟注可点、过牌禁用；滑条与快捷注在场', () => {
    render(<ActionBar {...base} toCall={20} currentBet={20} />)
    expect(btn('call').disabled).toBe(false)
    expect(btn('check').disabled).toBe(true)
    expect(screen.getByTestId('bet-slider')).toBeTruthy()
    expect(screen.getByTestId('quick-bet')).toBeTruthy()
  })

  it('非自己回合：全部动作禁用（含全下）', () => {
    render(<ActionBar {...base} isMyTurn={false} />)
    for (const t of ['check', 'bet', 'call', 'raise', 'allin', 'fold']) expect(btn(t).disabled).toBe(true)
  })

  it('金额按钮是目标语义：「下注到 / 加注到 X」', () => {
    render(<ActionBar {...base} currentBet={50} minRaise={20} />)
    expect(btn('bet').textContent).toBe('下注到 70')
    expect(btn('raise').textContent).toBe('加注到 70')
  })

  it('minRaise 下限：加注目标 ≥ currentBet + minRaise', () => {
    const onAction = vi.fn()
    render(<ActionBar {...base} currentBet={50} minRaise={20} onAction={onAction} />)
    fireEvent.click(btn('raise'))
    expect(onAction).toHaveBeenCalledWith('raise', 70)
  })

  it('换手/换街（resetKey 变化）：金额按新最小值重置夹紧', () => {
    const { rerender } = render(<ActionBar {...base} currentBet={50} minRaise={20} resetKey="1:preflop" />)
    fireEvent.click(quickPick('池')) // 候选 = pot + currentBet*2 = 130
    expect(btn('raise').textContent).toBe('加注到 130')
    rerender(<ActionBar {...base} currentBet={50} minRaise={20} resetKey="2:preflop" />)
    expect(btn('raise').textContent).toBe('加注到 70')
  })

  it('全下可达：动作按钮与快捷注「全下」都发 allin 动作', () => {
    const onAction = vi.fn()
    render(<ActionBar {...base} onAction={onAction} />)
    fireEvent.click(btn('allin'))
    expect(onAction).toHaveBeenCalledWith('allin')
    onAction.mockClear()
    fireEvent.click(quickPick('全下'))
    expect(onAction).toHaveBeenCalledWith('allin')
  })

  it('短码（myChips < toCall 或 < 最小目标）：下注/加注禁用，全下是可用路径', () => {
    render(<ActionBar {...base} myChips={30} toCall={50} currentBet={50} minRaise={20} />)
    expect(btn('call').disabled).toBe(true)
    expect(btn('bet').disabled).toBe(true)
    expect(btn('raise').disabled).toBe(true)
    expect(btn('allin').disabled).toBe(false)
    expect(btn('fold').disabled).toBe(false)
  })

  it('快捷键：F 弃牌 / C 过牌·跟注 / A 全下 / R 加注（无注时 R = 下注）', () => {
    const onAction = vi.fn()
    render(<ActionBar {...base} onAction={onAction} />)
    fireEvent.keyDown(window, { key: 'f' })
    fireEvent.keyDown(window, { key: 'c' })
    fireEvent.keyDown(window, { key: 'a' })
    fireEvent.keyDown(window, { key: 'r' })
    expect(onAction).toHaveBeenNthCalledWith(1, 'fold')
    expect(onAction).toHaveBeenNthCalledWith(2, 'check')
    expect(onAction).toHaveBeenNthCalledWith(3, 'allin')
    expect(onAction).toHaveBeenNthCalledWith(4, 'bet', 10)
  })

  it('快捷键：有注时 C 跟注、R 加注到目标', () => {
    const onAction = vi.fn()
    render(<ActionBar {...base} toCall={20} currentBet={20} onAction={onAction} />)
    fireEvent.keyDown(window, { key: 'c' })
    fireEvent.keyDown(window, { key: 'r' })
    expect(onAction).toHaveBeenNthCalledWith(1, 'call')
    expect(onAction).toHaveBeenNthCalledWith(2, 'raise', 30)
  })

  it('快捷键：焦点在输入控件时不抢键', () => {
    const onAction = vi.fn()
    render(<ActionBar {...base} onAction={onAction} />)
    screen.getByLabelText('下注金额滑条').focus()
    fireEvent.keyDown(window, { key: 'f' })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('倒计时 ≤10 秒变红（SeatTimer 同款语义）', () => {
    const { rerender } = render(<ActionBar {...base} deadline={Date.now() + 25000} turnMs={30000} />)
    expect(screen.getByLabelText(/剩余/).className).not.toContain('text-danger')
    rerender(<ActionBar {...base} deadline={Date.now() + 5000} turnMs={30000} />)
    expect(screen.getByLabelText(/剩余/).className).toContain('text-danger')
  })

  it('非本方回合指明当前行动者：轮到 X / 等待其他玩家', () => {
    const { rerender } = render(<ActionBar {...base} isMyTurn={false} turnNick="樱" />)
    expect(screen.getByText('轮到 樱')).toBeTruthy()
    rerender(<ActionBar {...base} isMyTurn={false} turnNick={null} />)
    expect(screen.getByText('等待其他玩家')).toBeTruthy()
  })
})

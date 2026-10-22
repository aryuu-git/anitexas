// @vitest-environment happy-dom
// ActionBar 回归：只按 legalActions 渲染（不保留整排灰按钮）+ 非本人回合一行状态
// + 内联金额面板（加到/再投入）+ 全下二次确认 + 短码跟注 + 快捷键 + 倒计时告急。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ActionBar, type ActionBarProps } from './ActionBar'

afterEach(cleanup)

const base: ActionBarProps = {
  pot: 30,
  actions: ['fold', 'check', 'bet', 'allin'],
  callAmount: 0,
  currentBet: 0,
  bigBlind: 10,
  minRaiseTo: 10,
  maxRaiseTo: 500,
  myChips: 500,
  isMyTurn: true,
  pendingType: null,
  deadline: null,
  onAction: vi.fn(),
}

/** 动作组里的按钮（不存在返回 null） */
const btn = (t: string) =>
  screen.getByTestId('action-group').querySelector(`[data-action="${t}"]`) as HTMLButtonElement | null
const panelBtn = (t: string) =>
  screen.getByTestId('bet-panel').querySelector(`[data-action="${t}"]`) as HTMLButtonElement | null
const quickPick = (label: string) =>
  [...screen.getByTestId('quick-bet').querySelectorAll('button')].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement

describe('ActionBar 行动区', () => {
  it('无注回合：只渲染弃牌/过牌/下注，不出现跟注、加注与整排灰按钮', () => {
    render(<ActionBar {...base} />)
    expect(btn('fold')).toBeTruthy()
    expect(btn('check')).toBeTruthy()
    expect(btn('bet')).toBeTruthy()
    expect(btn('call')).toBeNull()
    expect(btn('raise')).toBeNull()
    // 全下收在金额面板里，默认不占整排位置
    expect(btn('allin')).toBeNull()
    expect(screen.queryByTestId('bet-panel')).toBeNull()
  })

  it('点过牌回调 check', () => {
    const onAction = vi.fn()
    render(<ActionBar {...base} onAction={onAction} />)
    fireEvent.click(btn('check')!)
    expect(onAction).toHaveBeenCalledWith('check')
  })

  it('有注回合：跟注显示服务端 callAmount，点按回调 call', () => {
    const onAction = vi.fn()
    render(
      <ActionBar
        {...base}
        actions={['fold', 'call', 'raise', 'allin']}
        callAmount={20}
        currentBet={20}
        minRaiseTo={30}
        onAction={onAction}
      />,
    )
    expect(btn('check')).toBeNull()
    expect(btn('call')!.textContent).toBe('跟注 20')
    fireEvent.click(btn('call')!)
    expect(onAction).toHaveBeenCalledWith('call')
  })

  it('加注…展开内联面板：滑条/快捷注在场，确认按钮是「加注到 Y」并附带再投入', () => {
    const onAction = vi.fn()
    render(
      <ActionBar
        {...base}
        actions={['fold', 'call', 'raise', 'allin']}
        callAmount={20}
        currentBet={20}
        minRaiseTo={30}
        onAction={onAction}
      />,
    )
    fireEvent.click(btn('raise')!)
    expect(screen.getByTestId('bet-panel')).toBeTruthy()
    expect(screen.getByTestId('bet-slider')).toBeTruthy()
    expect(screen.getByTestId('quick-bet')).toBeTruthy()
    expect(screen.getByTestId('bet-target').textContent).toContain('加注到 30')
    expect(screen.getByText('再投入 30')).toBeTruthy()
    fireEvent.click(panelBtn('confirm-bet')!)
    expect(onAction).toHaveBeenCalledWith('raise', 30)
  })

  it('下注面板确认按钮是「下注到 Y」', () => {
    const onAction = vi.fn()
    render(<ActionBar {...base} onAction={onAction} />)
    fireEvent.click(btn('bet')!)
    expect(panelBtn('confirm-bet')!.textContent).toBe('下注到 10')
    fireEvent.click(panelBtn('confirm-bet')!)
    expect(onAction).toHaveBeenCalledWith('bet', 10)
  })

  it('换手/换街（resetKey 变化）：收起面板，金额按新最小值重置', () => {
    const { rerender } = render(
      <ActionBar
        {...base}
        actions={['fold', 'call', 'raise', 'allin']}
        callAmount={50}
        currentBet={50}
        minRaiseTo={70}
        resetKey="1:preflop"
      />,
    )
    fireEvent.click(btn('raise')!)
    fireEvent.click(quickPick('池')) // 候选 = pot + currentBet*2 = 130
    expect(screen.getByTestId('bet-target').textContent).toContain('130')
    rerender(
      <ActionBar
        {...base}
        actions={['fold', 'call', 'raise', 'allin']}
        callAmount={50}
        currentBet={50}
        minRaiseTo={70}
        resetKey="2:preflop"
      />,
    )
    expect(screen.queryByTestId('bet-panel')).toBeNull()
    fireEvent.click(btn('raise')!)
    expect(screen.getByTestId('bet-target').textContent).toContain('加注到 70')
  })

  it('全下需要内联二次确认，且可取消', () => {
    const onAction = vi.fn()
    render(<ActionBar {...base} onAction={onAction} />)
    fireEvent.click(btn('bet')!)
    fireEvent.click(panelBtn('allin')!)
    expect(onAction).not.toHaveBeenCalled()
    expect(panelBtn('allin')!.textContent).toBe('确认全下')
    fireEvent.click(panelBtn('cancel-allin')!)
    expect(panelBtn('allin')!.textContent).toBe('全下')
    fireEvent.click(panelBtn('allin')!)
    fireEvent.click(panelBtn('allin')!)
    expect(onAction).toHaveBeenCalledWith('allin')
  })

  it('短码跟注：直接作为主要合法动作，实际发 allin，且没有下注/加注入口', () => {
    const onAction = vi.fn()
    render(
      <ActionBar
        {...base}
        actions={['fold', 'call', 'allin']}
        callAmount={50}
        currentBet={50}
        minRaiseTo={null}
        maxRaiseTo={30}
        myChips={30}
        onAction={onAction}
      />,
    )
    expect(btn('call')!.textContent).toContain('跟注（全下 30）')
    expect(btn('bet')).toBeNull()
    expect(btn('raise')).toBeNull()
    fireEvent.click(btn('call')!)
    expect(onAction).toHaveBeenCalledWith('allin')
  })

  it('非本人回合：只有一行状态，不渲染任何动作按钮', () => {
    render(<ActionBar {...base} isMyTurn={false} turnNick="樱" />)
    expect(screen.queryByTestId('action-group')).toBeNull()
    expect(screen.getByTestId('action-status').textContent).toBe('轮到 樱')
  })

  it('非本人回合优先显示权威状态文案（已弃牌/已全下/未参与）', () => {
    render(<ActionBar {...base} isMyTurn={false} statusText="你已弃牌，等待本手结算" />)
    expect(screen.getByTestId('action-status').textContent).toBe('你已弃牌，等待本手结算')
  })

  it('待确认：只显示确认中；超过 5 秒显示正在核对，不解除锁定', () => {
    const { rerender } = render(<ActionBar {...base} pendingType="call" />)
    expect(screen.getByTestId('action-status').textContent).toBe('确认中：跟注')
    expect(screen.queryByTestId('action-group')).toBeNull()
    rerender(<ActionBar {...base} pendingType="call" pendingVerifying />)
    expect(screen.getByTestId('action-status').textContent).toBe('正在核对操作结果…')
    expect(screen.queryByTestId('action-group')).toBeNull()
  })

  it('快捷键只对合法动作生效：F 弃牌 / C 过牌 / R 展开面板；无合法全下时 A 无效', () => {
    const onAction = vi.fn()
    render(<ActionBar {...base} actions={['fold', 'check', 'bet']} onAction={onAction} />)
    fireEvent.keyDown(window, { key: 'f' })
    fireEvent.keyDown(window, { key: 'c' })
    fireEvent.keyDown(window, { key: 'a' })
    fireEvent.keyDown(window, { key: 'r' })
    expect(onAction).toHaveBeenNthCalledWith(1, 'fold')
    expect(onAction).toHaveBeenNthCalledWith(2, 'check')
    expect(onAction).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('bet-panel')).toBeTruthy()
  })

  it('长按重复键不会绕过全下二次确认', () => {
    const onAction = vi.fn()
    render(<ActionBar {...base} onAction={onAction} />)
    fireEvent.keyDown(window, { key: 'a' }) // 首次：展开面板并进入待确认
    expect(onAction).not.toHaveBeenCalled()
    expect(screen.getByTestId('bet-panel')).toBeTruthy()

    // 长按产生的 repeat 事件不得触发第二次（真正的确认）
    fireEvent.keyDown(window, { key: 'a', repeat: true })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('模态层打开（shortcutsLocked）时不响应快捷键，避免误操作底下牌局', () => {
    const onAction = vi.fn()
    render(<ActionBar {...base} shortcutsLocked onAction={onAction} />)
    fireEvent.keyDown(window, { key: 'f' })
    fireEvent.keyDown(window, { key: 'c' })
    fireEvent.keyDown(window, { key: 'a' })
    expect(onAction).not.toHaveBeenCalled()
    expect(screen.queryByTestId('bet-panel')).toBeNull()
  })

  it('快捷键：有注时 C 跟注；焦点在输入控件时不抢键', () => {
    const onAction = vi.fn()
    render(
      <ActionBar
        {...base}
        actions={['fold', 'call', 'raise', 'allin']}
        callAmount={20}
        currentBet={20}
        minRaiseTo={30}
        onAction={onAction}
      />,
    )
    fireEvent.keyDown(window, { key: 'c' })
    expect(onAction).toHaveBeenNthCalledWith(1, 'call')
    fireEvent.click(btn('raise')!)
    screen.getByLabelText('下注金额滑条').focus()
    fireEvent.keyDown(window, { key: 'f' })
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('倒计时 ≤10 秒变红（SeatTimer 同款语义）', () => {
    const { rerender } = render(<ActionBar {...base} deadline={Date.now() + 25000} turnMs={30000} />)
    expect(screen.getByLabelText(/剩余/).className).not.toContain('text-danger')
    rerender(<ActionBar {...base} deadline={Date.now() + 5000} turnMs={30000} />)
    expect(screen.getByLabelText(/剩余/).className).toContain('text-danger')
  })

  it('非本方回合且未知行动者：等待其他玩家', () => {
    render(<ActionBar {...base} isMyTurn={false} turnNick={null} />)
    expect(screen.getByTestId('action-status').textContent).toBe('等待其他玩家')
  })
})

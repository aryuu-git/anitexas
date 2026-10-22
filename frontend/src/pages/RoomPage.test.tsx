// @vitest-environment happy-dom
// RoomPage 装配冒烟（mock 桌）：ready 开局落到行动条、牌池抽屉开合、离开回大厅。
// 纯装配层验证（路由 + mock 桌 + 状态归约），牌桌内部组件各测各的。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

/** 装配对局桌（mock 桌离线演示，避开 REST/WS） */
async function renderRoom() {
  vi.stubEnv('VITE_USE_MOCK', '1')
  // 动态导入：RoomPage 的 USE_MOCK 在模块求值时读取 import.meta.env，
  // 静态导入会先于 stubEnv 执行而固定成非 mock（真实 REST/WS 路径），故此处必须延迟加载
  const { default: RoomPage } = await import('./RoomPage')
  return render(
    <MemoryRouter initialEntries={['/room/DEMO']}>
      <Routes>
        <Route path="/room/:code" element={<RoomPage />} />
        <Route path="/" element={<div data-testid="lobby">大厅</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RoomPage 装配', () => {
  it('准备室：显示权威座位名单；本人准备后进入牌桌（阶段进度 + 行动区）', async () => {
    await renderRoom()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('DEMO')
    expect(screen.getByTestId('conn-status').textContent).toContain('mock')
    // 准备室：不渲染下注条/空公共牌/零底池
    const seats = await screen.findByTestId('waiting-seats')
    expect(seats.textContent).toContain('机器人')
    expect(screen.queryByTestId('action-bar')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '我准备好了' }))
    const bar = await screen.findByTestId('action-bar')
    // 对局页四区：阶段进度 + 行动区；非本人回合只保留一行状态
    expect(screen.getByTestId('phase-progress')).toBeTruthy()
    expect(bar.textContent).toMatch(/轮到|等待|轮到你/)
  })

  it('牌池抽屉：准备后进入牌桌，开合自如，盒名单 13 张', async () => {
    await renderRoom()
    await screen.findByTestId('waiting-seats')
    fireEvent.click(screen.getByRole('button', { name: '我准备好了' }))
    await screen.findByTestId('action-bar')
    fireEvent.click(screen.getByRole('button', { name: '牌池' }))
    expect(screen.getAllByTestId('box-row')).toHaveLength(13)
    fireEvent.click(screen.getByRole('button', { name: '关闭牌池' }))
    expect(screen.queryByTestId('box-dock')).toBeNull()
  })

  it('离开：发 leave 后回大厅', async () => {
    await renderRoom()
    fireEvent.click(screen.getByRole('button', { name: '离开' }))
    expect(await screen.findByTestId('lobby')).toBeTruthy()
  })

  it('结算：本人优先摘要；关闭不发 ready；上手结果只读回顾随新一手收起', async () => {
    vi.useFakeTimers()
    try {
      await renderRoom()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      fireEvent.click(screen.getByRole('button', { name: '我准备好了' }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900)
      })

      // 全下：A 首次展开并进入二次确认，再按一次才真正发出
      fireEvent.keyDown(window, { key: 'a' })
      await act(async () => {})
      fireEvent.keyDown(window, { key: 'a' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12000)
      })

      // 结算首屏先给本人净变化与结束原因
      expect(screen.getByTestId('my-chips-delta')).toBeTruthy()
      expect(screen.getByTestId('my-points-delta')).toBeTruthy()
      expect(screen.getByTestId('result-reason').textContent).toMatch(/弃牌|摊牌/)

      // 关闭只收起面板，不发 ready；入口转为「查看本手结果」
      fireEvent.click(screen.getByRole('button', { name: '关闭结算' }))
      expect(screen.queryByTestId('my-chips-delta')).toBeNull()
      expect(screen.getByRole('button', { name: '查看本手结果' })).toBeTruthy()

      // 自动进入下一手后，入口转为只读「上手结果」
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000)
      })
      fireEvent.click(screen.getByRole('button', { name: '上手结果' }))
      await act(async () => {})
      expect(screen.getByTestId('result-reason').textContent).toContain('这是上一手的结果')
      const dialog = within(screen.getByRole('dialog'))
      expect(dialog.queryByRole('button', { name: '准备下一手' })).toBeNull()
      expect(dialog.queryByRole('button', { name: '离开' })).toBeNull()
      expect(dialog.getByRole('button', { name: '关闭' })).toBeTruthy()
      // 回顾关闭：桌面行动区仍在（不改变参局状态）
      fireEvent.click(dialog.getByRole('button', { name: '关闭' }))
      expect(screen.queryByTestId('my-chips-delta')).toBeNull()
      expect(screen.getByTestId('action-bar')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('聊天未读徽标：浮窗收起期间到达的消息计数，打开清零', async () => {
    await renderRoom()
    await screen.findByTestId('waiting-seats')
    fireEvent.click(screen.getByRole('button', { name: '我准备好了' }))
    await screen.findByTestId('action-bar')
    // 开浮窗发一条：自己的回显即时到达（浮窗开着不计数）；bot 应答在 1200ms 后到
    fireEvent.click(screen.getByRole('button', { name: /表情与聊天/ }))
    fireEvent.change(screen.getByLabelText('聊天输入'), { target: { value: '你好' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    fireEvent.click(screen.getByRole('button', { name: /表情与聊天/ })) // 收起
    expect(screen.queryByTestId('chat-unread')).toBeNull()
    const badge = await screen.findByTestId('chat-unread', {}, { timeout: 4000 })
    expect(badge.textContent).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: /表情与聊天/ })) // 打开清零
    expect(screen.queryByTestId('chat-unread')).toBeNull()
  })
})

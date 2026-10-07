// @vitest-environment happy-dom
// RoomPage 装配冒烟（mock 桌）：ready 开局落到行动条、牌池抽屉开合、离开回大厅。
// 纯装配层验证（路由 + mock 桌 + 状态归约），牌桌内部组件各测各的。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  it('等待态：房间信息在场，「准备开局」推到行动条（含全下按钮）', async () => {
    await renderRoom()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('DEMO')
    expect(screen.getByTestId('conn-status').textContent).toContain('mock')
    // 等 mock 桌落座广播（bot 的 readied 上座），此时点「准备开局」才凑满全员
    await screen.findAllByTestId('ready-badge')
    fireEvent.click(screen.getByRole('button', { name: '准备开局' }))
    const bar = await screen.findByTestId('action-bar')
    expect(bar.querySelector('[data-action="allin"]')).toBeTruthy()
    expect(bar.textContent).toContain('下注到')
  })

  it('牌池抽屉：开合自如，盒名单 13 张', async () => {
    await renderRoom()
    await screen.findAllByTestId('ready-badge')
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

  it('聊天未读徽标：浮窗收起期间到达的消息计数，打开清零', async () => {
    await renderRoom()
    await screen.findAllByTestId('ready-badge')
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

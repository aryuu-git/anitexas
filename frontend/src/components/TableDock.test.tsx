// @vitest-environment happy-dom
// 桌边浮窗契约：disabled 透传禁用聊天输入与表情栏（观战/未入座）、关闭按钮关浮窗。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TableDock } from './TableDock'
import { EMOTE_LABELS } from './EmoteBar'
import { EMOTE_KEYS } from '../api/types'

afterEach(cleanup)

const noop = () => {}

describe('TableDock 桌边浮窗', () => {
  it('disabled：聊天输入与 8 个表情键全部禁用', () => {
    render(
      <TableDock
        open
        onClose={noop}
        messages={[]}
        chatEnabled
        disabled
        onSay={vi.fn()}
        cooldownUntil={0}
        onEmote={vi.fn()}
      />,
    )
    const input = screen.getByLabelText('聊天输入') as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect(input.getAttribute('data-state')).toBe('disabled')
    for (const key of EMOTE_KEYS) {
      expect((screen.getByLabelText(`表情：${EMOTE_LABELS[key]}`) as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('未禁用：聊天输入与表情键可用', () => {
    render(
      <TableDock
        open
        onClose={noop}
        messages={[]}
        chatEnabled
        onSay={vi.fn()}
        cooldownUntil={0}
        onEmote={vi.fn()}
      />,
    )
    expect((screen.getByLabelText('聊天输入') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByLabelText('表情：鼓掌') as HTMLButtonElement).disabled).toBe(false)
  })

  it('关闭按钮触发 onClose；open=false 不渲染', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <TableDock
        open
        onClose={onClose}
        messages={[]}
        chatEnabled
        onSay={vi.fn()}
        cooldownUntil={0}
        onEmote={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByLabelText('关闭侧栏'))
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(
      <TableDock
        open={false}
        onClose={onClose}
        messages={[]}
        chatEnabled
        onSay={vi.fn()}
        cooldownUntil={0}
        onEmote={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('table-dock')).toBeNull()
  })
})

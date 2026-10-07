// @vitest-environment happy-dom
// 聊天面板交互契约：消息渲染、say 上行、消息限长、客户端节流（窗口内排队补发不丢弃）、
// 房主开关（chatEnabled=false 置灰）、禁言态（disabled 置灰）、可折叠、聊天流 aria-live。
// 服务端另有 chat_disabled/chat_too_long 兜底，本测试守客户端侧纪律。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { ChatPanel, type ChatLine } from './ChatPanel'
import { CHAT_MAX_LEN, CHAT_THROTTLE_MS } from '../api/types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const LINES: ChatLine[] = [
  { seat: 0, nick: '你', text: '这把稳了' },
  { seat: 1, nick: '墨镜', text: '未必哦' },
]

/** 表单提交（输入 + 发送） */
function say(text: string) {
  fireEvent.change(screen.getByLabelText('聊天输入'), { target: { value: text } })
  fireEvent.submit(screen.getByLabelText('聊天输入').closest('form') as HTMLFormElement)
}

describe('ChatPanel 聊天面板', () => {
  it('渲染消息行（昵称 + 文本），空账本有占位', () => {
    const { container, unmount } = render(
      <ChatPanel messages={LINES} chatEnabled onSay={vi.fn()} />,
    )
    expect(container.textContent).toContain('你')
    expect(container.textContent).toContain('这把稳了')
    expect(container.textContent).toContain('墨镜')
    expect(container.textContent).toContain('未必哦')
    unmount()
    render(<ChatPanel messages={[]} chatEnabled onSay={vi.fn()} />)
    expect(screen.getByTestId('chat-log').textContent).toContain('还没有消息')
  })

  it('聊天流容器 aria-live="polite"', () => {
    render(<ChatPanel messages={LINES} chatEnabled onSay={vi.fn()} />)
    expect(screen.getByTestId('chat-log').getAttribute('aria-live')).toBe('polite')
  })

  it('提交非空文本回传 say，输入清空', () => {
    const onSay = vi.fn()
    render(<ChatPanel messages={[]} chatEnabled onSay={onSay} />)
    say('  加油  ')
    expect(onSay).toHaveBeenCalledTimes(1)
    expect(onSay).toHaveBeenCalledWith('加油')
    expect((screen.getByLabelText('聊天输入') as HTMLInputElement).value).toBe('')
  })

  it('空白文本不上报', () => {
    const onSay = vi.fn()
    render(<ChatPanel messages={[]} chatEnabled onSay={onSay} />)
    say('   ')
    expect(onSay).not.toHaveBeenCalled()
  })

  it(`消息截断到 ${CHAT_MAX_LEN} 字（超长不整条透传）`, () => {
    const onSay = vi.fn()
    render(<ChatPanel messages={[]} chatEnabled onSay={onSay} />)
    const input = screen.getByLabelText('聊天输入') as HTMLInputElement
    expect(input.getAttribute('maxlength')).toBe(String(CHAT_MAX_LEN))
    say('长'.repeat(CHAT_MAX_LEN + 50))
    expect(onSay).toHaveBeenCalledWith('长'.repeat(CHAT_MAX_LEN))
  })

  it('客户端节流：窗口内连发排队补发不丢弃，提示「发言太频繁，请稍候」', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'))
    const onSay = vi.fn()
    render(<ChatPanel messages={[]} chatEnabled onSay={onSay} />)

    say('第一条')
    expect(onSay).toHaveBeenCalledTimes(1)
    say('第二条') // 节流窗口内：入队 + 提示，不丢弃
    expect(onSay).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('chat-throttle-hint').textContent).toContain('发言太频繁，请稍候')

    act(() => {
      vi.advanceTimersByTime(CHAT_THROTTLE_MS)
    })
    // 窗口过后自动补发
    expect(onSay).toHaveBeenCalledTimes(2)
    expect(onSay).toHaveBeenLastCalledWith('第二条')

    say('第三条') // 补发刚占用新窗口：继续排队
    expect(onSay).toHaveBeenCalledTimes(2)
    act(() => {
      vi.advanceTimersByTime(CHAT_THROTTLE_MS)
    })
    expect(onSay).toHaveBeenCalledTimes(3)
    expect(onSay).toHaveBeenLastCalledWith('第三条')
  })

  it('房主关聊天（chatEnabled=false）：输入框与发送均置灰', () => {
    const onSay = vi.fn()
    render(<ChatPanel messages={LINES} chatEnabled={false} onSay={onSay} />)
    const input = screen.getByLabelText('聊天输入') as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect(input.getAttribute('data-state')).toBe('disabled')
    expect(input.placeholder).toContain('房主已关闭聊天')
    say('试图发言')
    expect(onSay).not.toHaveBeenCalled()
  })

  it('禁言态（disabled，观战/未入座）：输入框置灰，提交不上行', () => {
    const onSay = vi.fn()
    render(<ChatPanel messages={LINES} chatEnabled disabled onSay={onSay} />)
    const input = screen.getByLabelText('聊天输入') as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect(input.getAttribute('data-state')).toBe('disabled')
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect(onSay).not.toHaveBeenCalled()
  })

  it('可折叠：折叠后收起消息与输入，再展开恢复', () => {
    render(<ChatPanel messages={LINES} chatEnabled onSay={vi.fn()} />)
    const toggle = screen.getByLabelText('折叠聊天面板')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(screen.queryByTestId('chat-log')).toBeNull()
    expect(screen.queryByLabelText('聊天输入')).toBeNull()
    expect(screen.getByLabelText('展开聊天面板').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByLabelText('展开聊天面板'))
    expect(screen.getByTestId('chat-log')).toBeTruthy()
    expect(screen.getByLabelText('聊天输入')).toBeTruthy()
  })
})

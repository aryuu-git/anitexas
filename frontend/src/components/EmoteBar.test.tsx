// @vitest-environment happy-dom
// 快捷表情冷却回归（D15）：8 键白名单、aria-label 中文全覆盖、点击上报、
// 10 秒冷却禁用与恢复、disabled（观战/未入座）禁用。
// 服务端另有 emote_failed 兜底（mock/后端同规则），本测试守客户端交互契约。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { EmoteBar, EMOTE_LABELS } from './EmoteBar'
import { EMOTE_KEYS } from '../api/types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('EmoteBar 表情冷却', () => {
  it('渲染白名单 8 键，aria-label 中文全覆盖，点击回传表情键', () => {
    const onEmote = vi.fn()
    render(<EmoteBar cooldownUntil={0} onEmote={onEmote} />)
    for (const key of EMOTE_KEYS) {
      expect(screen.getByLabelText(`表情：${EMOTE_LABELS[key]}`)).toBeTruthy()
    }
    // 8 个 key 全覆盖中文名（漏一个即 aria-label 回退英文键名）
    expect(Object.keys(EMOTE_LABELS).sort()).toEqual([...EMOTE_KEYS].sort())
    fireEvent.click(screen.getByLabelText('表情：鼓掌'))
    expect(onEmote).toHaveBeenCalledWith('clap')
  })

  it('发出表情后进入 10 秒冷却（禁用 + 倒数），冷却结束恢复', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'))
    const onEmote = vi.fn()
    const { rerender } = render(<EmoteBar cooldownUntil={0} onEmote={onEmote} />)

    // 发出表情 → 父层回填冷却截止（+10s）
    fireEvent.click(screen.getByLabelText('表情：鼓掌'))
    rerender(<EmoteBar cooldownUntil={Date.now() + 10000} onEmote={onEmote} />)

    const clap = screen.getByLabelText('表情：鼓掌') as HTMLButtonElement
    expect(clap.disabled).toBe(true)
    expect(clap.getAttribute('data-state')).toBe('cooldown')
    expect(screen.getByText(/冷却 10s/)).toBeTruthy()
    fireEvent.click(clap)
    expect(onEmote).toHaveBeenCalledTimes(1) // 冷却期内点击不上报

    // 10 秒后恢复（act 内推进定时器以冲刷状态）
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(clap.disabled).toBe(false)
    expect(clap.getAttribute('data-state')).toBe('ready')
  })

  it('disabled（观战/未入座）：8 键全部禁用，点击不上报', () => {
    const onEmote = vi.fn()
    render(<EmoteBar cooldownUntil={0} onEmote={onEmote} disabled />)
    for (const key of EMOTE_KEYS) {
      const btn = screen.getByLabelText(`表情：${EMOTE_LABELS[key]}`) as HTMLButtonElement
      expect(btn.disabled).toBe(true)
    }
    fireEvent.click(screen.getByLabelText('表情：鼓掌'))
    expect(onEmote).not.toHaveBeenCalled()
  })
})

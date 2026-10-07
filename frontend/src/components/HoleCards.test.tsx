// @vitest-environment happy-dom
// HoleCards 揭示交互契约：私看单击走 RevealConfirm（scope=private）确认后才 onReveal(private)；
// 「亮一只」当众翻开走确认（public）；ESC 取消不揭示（D3 揭示不可逆，防误触）。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { HoleCards } from './HoleCards'
import { C101_KIMINONAWA, C102_TENKINOKO } from '../api/mockCards'

afterEach(cleanup)

const CARDS = [C101_KIMINONAWA, C102_TENKINOKO]

describe('HoleCards 底牌揭示', () => {
  it('私看单击打开确认弹层（仅自己可见），确认后才 onReveal(牌, private)', () => {
    const onReveal = vi.fn()
    render(
      <HoleCards myCards={CARDS} autoReveal={false} canReveal revealRate={0} onReveal={onReveal} />,
    )
    fireEvent.click(screen.getByLabelText('揭示《你的名字。》的要素'))
    expect(onReveal).not.toHaveBeenCalled() // 未确认不得揭示（D3 不可逆）
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('私看确认')
    expect(dialog.textContent).toContain('仅自己可见')
    fireEvent.click(screen.getByRole('button', { name: '确认私看' }))
    expect(onReveal).toHaveBeenCalledTimes(1)
    expect(onReveal).toHaveBeenCalledWith(C101_KIMINONAWA, 'private')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('ESC 取消私看：弹层关闭且不揭示', () => {
    const onReveal = vi.fn()
    render(
      <HoleCards myCards={CARDS} autoReveal={false} canReveal revealRate={0} onReveal={onReveal} />,
    )
    fireEvent.click(screen.getByLabelText('揭示《天气之子》的要素'))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onReveal).not.toHaveBeenCalled()
  })

  it('「亮一只」当众翻开确认（全桌可见）后 onReveal(第一张未揭示牌, public)', () => {
    const onReveal = vi.fn()
    render(
      <HoleCards myCards={CARDS} autoReveal={false} canReveal revealRate={0} onReveal={onReveal} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '亮一只' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('当众翻开确认')
    expect(dialog.textContent).toContain('全桌可见')
    fireEvent.click(screen.getByRole('button', { name: '确认当众翻开' }))
    expect(onReveal).toHaveBeenCalledTimes(1)
    expect(onReveal).toHaveBeenCalledWith(C101_KIMINONAWA, 'public')
  })

  it('autoReveal（开局已揭示）：牌面不可点，不弹确认', () => {
    const onReveal = vi.fn()
    render(
      <HoleCards myCards={CARDS} autoReveal canReveal={false} revealRate={0} onReveal={onReveal} />,
    )
    expect(screen.queryByLabelText('揭示《你的名字。》的要素')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onReveal).not.toHaveBeenCalled()
  })
})

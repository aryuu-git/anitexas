// @vitest-environment happy-dom
// CommunityRow 回归：5 位按 3-1-1 分三组；空位渲染占位；非 5 位退化为单组；
// 公共牌揭示走「当众翻开」确认（scope=public），确认后才 onReveal(牌, public)。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { CommunityRow } from './CommunityRow'
import { C103_CLANNAD, C104_KON, C105_STEINSGATE, withElements } from '../../api/mockCards'

afterEach(cleanup)

const noop = () => {}

describe('CommunityRow 公告牌分组', () => {
  it('5 位且空池：渲染 3 组（3-1-1）共 5 个占位', () => {
    const { container } = render(
      <CommunityRow community={[]} autoReveal={false} canReveal={false} revealRate={0} onReveal={noop} />,
    )
    expect(container.querySelectorAll('[data-testid="community-group"]').length).toBe(3)
    expect(container.querySelectorAll('[data-testid="community-slot"]').length).toBe(5)
  })

  it('翻牌三张落在第一组', () => {
    const flop = [withElements(C103_CLANNAD), withElements(C104_KON), withElements(C105_STEINSGATE)]
    const { container } = render(
      <CommunityRow community={flop} autoReveal canReveal={false} revealRate={0} onReveal={noop} />,
    )
    const groups = container.querySelectorAll('[data-testid="community-group"]')
    expect(groups[0].querySelectorAll('[data-state]').length).toBe(3)
  })

  it('非 5 位（3 位）退化为单组', () => {
    const { container } = render(
      <CommunityRow community={[]} communitySlots={3} autoReveal={false} canReveal={false} revealRate={0} onReveal={noop} />,
    )
    expect(container.querySelectorAll('[data-testid="community-group"]').length).toBe(1)
    expect(container.querySelectorAll('[data-testid="community-slot"]').length).toBe(3)
  })

  it('公共牌揭示：单击牌面开当众翻开确认（全桌可见），确认后 onReveal(牌, public)', () => {
    const onReveal = vi.fn()
    render(
      <CommunityRow community={[C104_KON]} autoReveal={false} canReveal revealRate={0} onReveal={onReveal} />,
    )
    fireEvent.click(screen.getByLabelText('揭示《轻音少女》的要素'))
    expect(onReveal).not.toHaveBeenCalled() // 未确认不得揭示
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('当众翻开确认')
    expect(dialog.textContent).toContain('全桌可见')
    fireEvent.click(screen.getByRole('button', { name: '确认当众翻开' }))
    expect(onReveal).toHaveBeenCalledTimes(1)
    expect(onReveal).toHaveBeenCalledWith(C104_KON, 'public')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('ESC 取消揭示确认：弹层关闭且不揭示', () => {
    const onReveal = vi.fn()
    render(
      <CommunityRow community={[C104_KON]} autoReveal={false} canReveal revealRate={0} onReveal={onReveal} />,
    )
    fireEvent.click(screen.getByLabelText('揭示《轻音少女》的要素'))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onReveal).not.toHaveBeenCalled()
  })
})

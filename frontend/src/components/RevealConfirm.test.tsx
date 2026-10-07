// @vitest-environment happy-dom
// 揭示确认弹层（D3 不可逆）交互契约：scope 文案分支、role=dialog + aria-modal、
// 打开聚焦确认按钮、Tab 弹层内首尾循环不逃逸、ESC 取消、关闭后焦点归还触发元素。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { RevealConfirm } from './RevealConfirm'
import { C101_KIMINONAWA } from '../api/mockCards'

afterEach(cleanup)

const noop = () => {}

/** 触发按钮 + 弹层的最小宿主（测焦点归还） */
function Harness({ onConfirm = noop, onCancel = noop }: { onConfirm?: () => void; onCancel?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        触发揭示
      </button>
      {open && (
        <RevealConfirm
          card={C101_KIMINONAWA}
          scope="private"
          revealRate={0}
          onConfirm={() => {
            setOpen(false)
            onConfirm()
          }}
          onCancel={() => {
            setOpen(false)
            onCancel()
          }}
        />
      )}
    </div>
  )
}

describe('RevealConfirm 揭示确认弹层', () => {
  it('role=dialog + aria-modal；scope=private 三行文案：仅自己可见 / 不可撤销 / 揭示成本', () => {
    render(
      <RevealConfirm card={C101_KIMINONAWA} scope="private" revealRate={0} onConfirm={noop} onCancel={noop} />,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('私看确认')
    expect(dialog.textContent).toContain('仅自己可见')
    expect(dialog.textContent).toContain('不可撤销')
    expect(dialog.textContent).toContain('揭示成本')
    expect(screen.getByRole('button', { name: '确认私看' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()
    // 私看不得出现全桌文案
    expect(dialog.textContent).not.toContain('全桌可见')
  })

  it('scope=public 文案：全桌可见 / 不可撤销 / 揭示成本（含费率）', () => {
    render(
      <RevealConfirm card={C101_KIMINONAWA} scope="public" revealRate={3} onConfirm={noop} onCancel={noop} />,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('当众翻开确认')
    expect(dialog.textContent).toContain('全桌可见')
    expect(dialog.textContent).toContain('不可撤销')
    expect(dialog.textContent).toContain('揭示成本')
    expect(dialog.textContent).toContain('3 积分/次')
    expect(screen.getByRole('button', { name: '确认当众翻开' })).toBeTruthy()
  })

  it('打开时焦点圈定确认按钮', () => {
    render(
      <RevealConfirm card={C101_KIMINONAWA} scope="private" revealRate={0} onConfirm={noop} onCancel={noop} />,
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '确认私看' }))
  })

  it('Tab 在弹层内首尾循环不逃逸；Shift+Tab 反向循环', () => {
    render(
      <RevealConfirm card={C101_KIMINONAWA} scope="private" revealRate={0} onConfirm={noop} onCancel={noop} />,
    )
    const confirm = screen.getByRole('button', { name: '确认私看' })
    const cancel = screen.getByRole('button', { name: '取消' })
    expect(document.activeElement).toBe(confirm)

    const tab = (shift = false) =>
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey: shift })

    tab() // 尾（确认）→ 头（取消）
    expect(document.activeElement).toBe(cancel)
    tab() // 头 → 尾
    expect(document.activeElement).toBe(confirm)
    tab(true) // 头反向 → 尾
    expect(document.activeElement).toBe(cancel)
    tab(true) // 尾反向 → 头
    expect(document.activeElement).toBe(confirm)
  })

  it('ESC 取消并关闭；关闭后焦点归还触发元素', () => {
    const onCancel = vi.fn()
    render(<Harness onCancel={onCancel} />)
    const trigger = screen.getByRole('button', { name: '触发揭示' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '确认私看' }))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('确认按钮回传 onConfirm（不可逆动作的唯一放行口）', () => {
    const onConfirm = vi.fn()
    render(<Harness onConfirm={onConfirm} />)
    fireEvent.click(screen.getByRole('button', { name: '触发揭示' }))
    fireEvent.click(screen.getByRole('button', { name: '确认私看' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

// @vitest-environment happy-dom
// 可验证发牌（commit-reveal）徽章：固证徽章三态 + 「验证」按钮本地 SHA-256 比对反馈。
// 已知向量 = mock 桌面夹具（anitexas-mock-seed-2026 的 SHA-256），通过/失败双向断言。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { SeedBadge } from './SeedBadge'

afterEach(cleanup)

const SEED = 'anitexas-mock-seed-2026'
const COMMIT = 'b43850884fa5bde6bd64cc2a35ee92ea4ae3d6fffaf3020f5d7e27d7b1d6ade2'

describe('SeedBadge 发牌固证', () => {
  it('无固证（后端未启用）不渲染徽章', () => {
    const { container } = render(<SeedBadge seedCommit={null} seedReveal={null} />)
    expect(container.textContent).toBe('')
  })

  it('只有固证：展示「发牌已固证」，摊牌前无验证按钮', () => {
    render(<SeedBadge seedCommit={COMMIT} seedReveal={null} />)
    expect(screen.getByTestId('seed-badge').textContent).toContain('发牌已固证')
    expect(screen.queryByText('验证')).toBeNull()
  })

  it('验证通过：本地 SHA-256 与固证一致 → 明确通过反馈', async () => {
    render(<SeedBadge seedCommit={COMMIT} seedReveal={SEED} />)
    const badge = screen.getByTestId('seed-badge')
    expect(badge.getAttribute('data-verify')).toBe('idle')
    fireEvent.click(screen.getByText('验证'))
    await waitFor(() => expect(screen.getByTestId('verify-result').textContent).toContain('验证通过'))
    expect(badge.getAttribute('data-verify')).toBe('pass')
  })

  it('验证失败：种子与固证不符 → 明确失败反馈', async () => {
    render(<SeedBadge seedCommit={COMMIT} seedReveal="被换过的种子" />)
    fireEvent.click(screen.getByText('验证'))
    await waitFor(() => expect(screen.getByTestId('verify-result').textContent).toContain('验证失败'))
    expect(screen.getByTestId('seed-badge').getAttribute('data-verify')).toBe('fail')
  })
})

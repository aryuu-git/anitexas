// @vitest-environment happy-dom
// 牌池策略表单段（D11）：分层随机/主题池切换、主题维（公司/年代/标签）+ 主题值，
// 产出 roomConfig.deckStrategy + themeFilter 的回调契约。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { DeckStrategyField } from './DeckStrategyField'
import type { DeckStrategy, ThemeFilter } from '../api/types'

afterEach(cleanup)

function renderField(strategy: DeckStrategy = 'stratified', themeFilter: ThemeFilter = { kind: 'company', value: '' }) {
  const onStrategyChange = vi.fn()
  const onThemeFilterChange = vi.fn()
  render(
    <DeckStrategyField
      strategy={strategy}
      themeFilter={themeFilter}
      onStrategyChange={onStrategyChange}
      onThemeFilterChange={onThemeFilterChange}
    />,
  )
  return { onStrategyChange, onThemeFilterChange }
}

describe('DeckStrategyField 牌池策略', () => {
  it('分层随机/主题池二选一，当前项 aria-checked', () => {
    renderField('theme')
    const stratified = screen.getByTestId('deck-strategy-field').querySelector('[data-strategy="stratified"]')
    const theme = screen.getByTestId('deck-strategy-field').querySelector('[data-strategy="theme"]')
    expect(stratified?.getAttribute('aria-checked')).toBe('false')
    expect(theme?.getAttribute('aria-checked')).toBe('true')
  })

  it('切换策略回调 deckStrategy', () => {
    const { onStrategyChange } = renderField()
    const theme = screen.getByTestId('deck-strategy-field').querySelector('[data-strategy="theme"]')
    fireEvent.click(theme as Element)
    expect(onStrategyChange).toHaveBeenCalledWith('theme')
  })

  it('分层随机时主题维/主题值不出现（主题池专属）', () => {
    renderField('stratified')
    expect(screen.queryByLabelText('主题维')).toBeNull()
    expect(screen.queryByLabelText('主题值')).toBeNull()
  })

  it('主题池：主题维下拉含 公司/年代/标签，改选回调 kind（保留已有主题值）', () => {
    const { onThemeFilterChange } = renderField('theme', { kind: 'company', value: '京都动画' })
    const kindSelect = screen.getByLabelText('主题维') as HTMLSelectElement
    const kinds = Array.from(kindSelect.options).map((o) => o.value)
    expect(kinds).toEqual(['company', 'year', 'tag'])
    fireEvent.change(kindSelect, { target: { value: 'year' } })
    expect(onThemeFilterChange).toHaveBeenLastCalledWith({ kind: 'year', value: '京都动画' })
  })

  it('主题池：主题值输入回调 themeFilter', () => {
    const { onThemeFilterChange } = renderField('theme', { kind: 'tag', value: '' })
    fireEvent.change(screen.getByLabelText('主题值'), { target: { value: '治愈' } })
    expect(onThemeFilterChange).toHaveBeenCalledWith({ kind: 'tag', value: '治愈' })
  })
})

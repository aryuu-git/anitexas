// @vitest-environment happy-dom
// CardFace 三态渲染回归（A5.2）：隐藏 / 已展开 / 摊牌的信息可见性与成组描金标记。
// 可见性契约：L1（名/评分/档位）恒可见；L2 要素仅 revealed/showdown 出现（D7）；
// 成组标记以 data-grouped 暴露（描金视觉走 token，走查对照 rules.png）。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { CardFace, sharedGroupElement } from './CardFace'
import { C101_KIMINONAWA, C103_CLANNAD, C104_KON, withElements } from '../api/mockCards'
import type { CardData } from '../api/types'

// vitest 未开 globals，RTL 自动清理不生效——显式清理防 DOM 跨用例残留
afterEach(cleanup)

describe('CardFace 三态渲染', () => {
  it('hidden：只有 L1（首字/名/评分/档位），要素区收起', () => {
    const { container } = render(<CardFace card={C101_KIMINONAWA} state="hidden" />)
    expect(container.textContent).toContain('你的名字。')
    expect(container.textContent).toContain('8.4')
    expect(container.textContent).toContain('档位 8.5')
    expect(container.textContent).toContain('你') // 封面首字
    // 要素芯片不得出现（隐藏数据纪律 D7 的 UI 侧）
    expect(screen.queryByText(/监督/)).toBeNull()
    expect(screen.queryByText(/新海诚/)).toBeNull()
    // 未揭示占位提示
    expect(container.textContent).toContain('要素未揭示')
  })

  it('revealed：要素 chips 全量可见，成组要素芯片描金标记', () => {
    const card = withElements(C101_KIMINONAWA)
    const { container } = render(
      <CardFace card={card} state="revealed" groupElement={{ class: 1, value: '新海诚' }} />,
    )
    expect(container.textContent).toContain('新海诚')
    expect(container.textContent).toContain('CoMix Wave')
    expect(container.textContent).toContain('原创')
    // 金边 = 成组：成组芯片 data-grouped=true，其余 false
    const chips = container.querySelectorAll('span[data-grouped]')
    expect(chips.length).toBe(5)
    const goldChip = container.querySelector('span[data-grouped="true"]')
    expect(goldChip?.textContent).toContain('新海诚')
  })

  it('单值要素默认平铺显示（含单个标签）', () => {
    // 你的名字。要素：监督 新海诚 / 公司 CoMix Wave / 标签 恋爱 / 年份 2016 / 原作类型 原创（每类各 1）
    const { container } = render(<CardFace card={withElements(C101_KIMINONAWA)} state="revealed" />)
    expect(container.textContent).toContain('新海诚')
    expect(container.textContent).toContain('CoMix Wave')
    expect(container.textContent).toContain('恋爱')
    expect(container.textContent).toContain('原创')
    // 无折叠 chip
    expect(container.querySelectorAll('[data-collapsed]').length).toBe(0)
  })

  it('同类多值（多监督/多标签）折叠为「×N」，悬停弹出完整列表', () => {
    const card: CardData = {
      ...withElements(C101_KIMINONAWA),
      elements: [
        { class: 1, value: '监督甲' },
        { class: 1, value: '监督乙' },
        { class: 2, value: '某公司' },
        { class: 3, value: '恋爱' },
        { class: 3, value: '治愈' },
        { class: 4, value: '2016' },
        { class: 5, value: '原创' },
      ],
    }
    const { container } = render(<CardFace card={card} state="revealed" />)
    // 单值类默认平铺
    expect(container.textContent).toContain('某公司')
    expect(container.textContent).toContain('2016')
    expect(container.textContent).toContain('原创')
    // 多值类折叠为「×N」，取值默认不出现
    expect(container.textContent).not.toContain('监督甲')
    expect(container.textContent).not.toContain('恋爱')
    const collapsed = container.querySelectorAll('[data-collapsed]')
    expect(collapsed.length).toBe(2) // 监督 + 标签
    expect(collapsed[0].textContent).toContain('×2')
    expect(collapsed[0].getAttribute('aria-label')).toContain('监督')
    expect(collapsed[1].getAttribute('aria-label')).toContain('标签')
    // 悬停第一个折叠 chip（监督）→ 弹层（portal 到 body）列出两人
    fireEvent.mouseEnter(collapsed[0])
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toContain('监督甲')
    expect(tip.textContent).toContain('监督乙')
  })

  it('封面开关：showCover=false 不渲染封面区；默认渲染', () => {
    const off = render(<CardFace card={C101_KIMINONAWA} state="hidden" showCover={false} />).container
    expect(off.querySelector('.bg-cover-sm')).toBeNull()
    cleanup()
    const on = render(<CardFace card={C101_KIMINONAWA} state="hidden" />).container
    expect(on.querySelector('.bg-cover-sm')?.textContent).toBe('你')
  })

  it('showdown：成组牌描金高亮（data-grouped=true），散牌压暗（false）', () => {
    const grouped = render(
      <CardFace card={withElements(C103_CLANNAD)} state="showdown" grouped groupElement={{ class: 2, value: '京都动画' }} />,
    ).container
    expect(grouped.querySelector('[data-grouped="true"]')?.getAttribute('data-state')).toBe('showdown')
    cleanup()

    const stray = render(<CardFace card={withElements(C101_KIMINONAWA)} state="showdown" />).container
    const root = stray.querySelector('[data-state="showdown"]')
    expect(root?.getAttribute('data-grouped')).toBe('false')
    // 散牌底部标签
    expect(stray.textContent).toContain('散牌')
  })

  it('revealed 态底部标签展示成组要素', () => {
    const { container } = render(
      <CardFace card={withElements(C103_CLANNAD)} state="revealed" groupElement={{ class: 2, value: '京都动画' }} />,
    )
    expect(container.textContent).toContain('京都动画')
  })

  it('无封面降级：monogram 缺失时封面取作品名首字', () => {
    const noCover = { ...C101_KIMINONAWA, monogram: '' }
    const { container } = render(<CardFace card={noCover} state="hidden" />)
    // 封面区是首个无 role 的展示块：首字「你」必须出现（title 里的「你」在正文，取封面区单独断言）
    const cover = container.querySelector('.bg-cover-sm')
    expect(cover?.textContent).toBe('你')
  })
})

describe('CardFace 揭示交互', () => {
  it('interactive：点击触发 onReveal（私看流）', () => {
    const onReveal = vi.fn()
    render(<CardFace card={C101_KIMINONAWA} state="hidden" interactive onReveal={onReveal} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  it('非 interactive：点击不触发', () => {
    const onReveal = vi.fn()
    render(<CardFace card={C101_KIMINONAWA} state="hidden" onReveal={onReveal} />)
    fireEvent.click(screen.getByText('你的名字。'))
    expect(onReveal).not.toHaveBeenCalled()
  })
})

describe('sharedGroupElement 成组标签推导', () => {
  it('取整组共有且类优先级最高的要素', () => {
    const cards = [withElements(C103_CLANNAD), withElements(C104_KON)]
    // CLANNAD 与轻音少女共有「公司·京都动画」（另有年份等非共有项）
    expect(sharedGroupElement(cards, [0, 1])).toEqual({ class: 2, value: '京都动画' })
  })

  it('无共同要素返回 null（散牌）', () => {
    const cards = [withElements(C101_KIMINONAWA), withElements(C103_CLANNAD)]
    expect(sharedGroupElement(cards, [0, 1])).toBeNull()
  })
})

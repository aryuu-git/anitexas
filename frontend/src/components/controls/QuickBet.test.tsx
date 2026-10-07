// @vitest-environment happy-dom
// QuickBet 回归：候选目标按 [min, myChips] 夹紧；「全下」走动作回调而非金额。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { QuickBet } from './QuickBet'

afterEach(cleanup)

const pickBtn = (label: string) =>
  [...screen.getByTestId('quick-bet').querySelectorAll('button')].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement

describe('QuickBet 快捷注', () => {
  it('「全下」触发 allin 动作，不回填金额', () => {
    const onPick = vi.fn()
    const onAllin = vi.fn()
    render(<QuickBet pot={100} currentBet={0} min={10} myChips={500} onPick={onPick} onAllin={onAllin} />)
    fireEvent.click(pickBtn('全下'))
    expect(onAllin).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('候选目标按最小值夹紧', () => {
    const onPick = vi.fn()
    render(<QuickBet pot={0} currentBet={0} min={70} myChips={500} onPick={onPick} onAllin={vi.fn()} />)
    fireEvent.click(pickBtn('最小'))
    expect(onPick).toHaveBeenCalledWith(70)
    fireEvent.click(pickBtn('½ 池')) // 候选 0 → 夹到最小 70
    expect(onPick).toHaveBeenCalledWith(70)
  })

  it('短码：候选贴住余量（全下走动作）', () => {
    const onPick = vi.fn()
    render(<QuickBet pot={100} currentBet={0} min={70} myChips={30} onPick={onPick} onAllin={vi.fn()} />)
    fireEvent.click(pickBtn('池'))
    expect(onPick).toHaveBeenCalledWith(30)
  })
})

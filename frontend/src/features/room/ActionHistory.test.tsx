// @vitest-environment happy-dom
// 动作历史：只展示最近 3 条公开过程，按手分组；私看/发牌等非公开事件不进历史。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { ExperienceEvent, SeatState } from '../../api/types'
import { ActionHistory } from './ActionHistory'

afterEach(cleanup)

const seats: SeatState[] = [0, 1, 2, 3].map((seat) => ({
  seat,
  nick: ['你', '樱', '墨', '空'][seat],
  chips: 500,
  points: 0,
  bet: 0,
  folded: false,
  acted: false,
  isDealer: false,
  holeCount: 2,
  ready: false,
  rebuys: 0,
}))

let seq = 0
const ev = (kind: ExperienceEvent['kind'], seat: number | null, payload?: Record<string, unknown>, handSeq = 2): ExperienceEvent => ({
  eventId: `e-${++seq}`,
  handSeq,
  phase: 'flop',
  kind,
  seat,
  occurredAt: 0,
  payload,
})

describe('ActionHistory 最近动作', () => {
  it('只保留最近 3 条公开动作，并显示真实动作名与投入', () => {
    render(
      <ActionHistory
        handSeq={2}
        seats={seats}
        events={[
          ev('flop', null),
          ev('blind_posted', 1, { amount: 2 }),
          ev('acted', 1, { type: 'call', amount: 2 }),
          ev('acted', 2, { type: 'raise', amount: 6 }),
          ev('acted', 3, { type: 'fold', amount: 0 }),
          ev('acted', 0, { type: 'check', amount: 0 }),
        ]}
      />,
    )
    // 最近三条：2 号加注、3 号弃牌、本人过牌；更早的 call / 盲注 / 开局不再显示
    expect(screen.queryByText(/跟注 2/)).toBeNull()
    expect(screen.queryByText(/盲注/)).toBeNull()
    const items = screen.getAllByTestId('history-item').map((n) => n.textContent)
    expect(items).toEqual(['墨 加注 6', '空 弃牌', '你 过牌'])
  })

  it('按手分组：跨手时显示两个手次标题', () => {
    render(
      <ActionHistory
        handSeq={2}
        seats={seats}
        events={[
          ev('acted', 1, { type: 'fold', amount: 0 }, 1),
          ev('acted', 2, { type: 'check', amount: 0 }, 2),
          ev('acted', 0, { type: 'fold', amount: 0 }, 2),
        ]}
      />,
    )
    expect(screen.getByText('第 1 手')).toBeTruthy()
    expect(screen.getByText('第 2 手（当前）')).toBeTruthy()
    expect(screen.getAllByTestId('history-item')).toHaveLength(3)
  })

  it('非公开事件（dealt / 私看揭示）不进入历史；空历史显示说明', () => {
    render(
      <ActionHistory
        handSeq={2}
        seats={seats}
        events={[ev('dealt', 0), ev('revealed', 0, { scope: 'private' })]}
      />,
    )
    expect(screen.queryAllByTestId('history-item')).toHaveLength(0)
    expect(screen.getByText('本手暂无公开动作。')).toBeTruthy()
  })
})

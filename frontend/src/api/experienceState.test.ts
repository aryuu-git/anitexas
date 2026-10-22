// 体验视图模型表驱动（docs/experience-handoff/02-state-contract.md §5）：
// screen / actionMode 优先级、阶段进度、结算摘要与「只消费服务端合法动作」。
import { describe, it, expect } from 'vitest'
import { createRoomState, type RoomState } from './roomState'
import { deriveExperienceState, summarizeResult } from './experienceState'
import type { HandResult, SeatState } from './types'

function seat(over: Partial<SeatState> & { seat: number }): SeatState {
  return {
    nick: `座位${over.seat}`,
    chips: 100,
    points: 0,
    bet: 0,
    folded: false,
    acted: false,
    isDealer: false,
    holeCount: 2,
    ready: false,
    rebuys: 0,
    ...over,
  }
}

function state(over: Partial<RoomState> = {}): RoomState {
  return {
    ...createRoomState(),
    seats: [seat({ seat: 0, nick: '你' }), seat({ seat: 1, nick: '樱' })],
    mySeat: 0,
    live: true,
    protocol: 2,
    roomStatus: 'waiting',
    ...over,
  }
}

const LIVE = { live: true, hasIdentity: true }

const result: HandResult = {
  handSeq: 3,
  endedAt: 1700000000000,
  endReason: 'showdown',
  seats: [],
  rows: [
    { seat: 0, chipsDelta: 120, points: { handScore: 30, bondBonus: 6, revealCost: 1 } },
    { seat: 1, chipsDelta: -120, points: { handScore: 10, bondBonus: 0, revealCost: 0 } },
  ],
  potWins: { 0: 60, 1: 60 },
  showdown: [],
}

describe('deriveExperienceState · screen 优先级', () => {
  it('未连接且无身份 → join；有身份 → syncing 并锁操作', () => {
    expect(deriveExperienceState(state(), { live: false, hasIdentity: false }).screen).toBe('join')
    const syncing = deriveExperienceState(state(), { live: false, hasIdentity: true })
    expect(syncing.screen).toBe('syncing')
    expect(syncing.blockedReason).toBe('正在同步牌桌')
  })

  it('已连接、等待首手 → waitingRoom；进入对局 → table', () => {
    expect(deriveExperienceState(state(), LIVE).screen).toBe('waitingRoom')
    expect(deriveExperienceState(state({ phase: 'preflop', handSeq: 1 }), LIVE).screen).toBe('table')
  })

  it('房间关闭/座位回收优先于连接状态', () => {
    const closed = deriveExperienceState(state({ roomStatus: 'closed' }), LIVE)
    expect(closed.screen).toBe('closed')
    expect(closed.blockedReason).toBe('房间已关闭')

    const removed = deriveExperienceState(
      state({ viewerStatus: 'removed', removalReason: 'rebuy_limit' }),
      LIVE,
    )
    expect(removed.screen).toBe('removed')
    expect(removed.blockedReason).toContain('重买次数已用尽')
    expect(removed.removalNotice).toContain('可返回首页重新加入')
  })
})

describe('deriveExperienceState · actionMode 优先级', () => {
  it('准备室：未准备 → ready；已准备 → waitingNextHand', () => {
    expect(deriveExperienceState(state(), LIVE).actionMode).toBe('ready')
    const ready = deriveExperienceState(
      state({ seats: [seat({ seat: 0, nick: '你', ready: true }), seat({ seat: 1 })] }),
      LIVE,
    )
    expect(ready.actionMode).toBe('waitingNextHand')
    expect(ready.myReady).toBe(true)
    expect(ready.readyProgress).toBe('还没有其他真人，准备后自动补齐机器人')
  })

  it('本地命令确认/核对优先于其它动作模式', () => {
    const confirming = deriveExperienceState(
      state({ phase: 'preflop', handSeq: 1, turnSeat: 0, legalActions: ['check'] }),
      { ...LIVE, pending: { type: 'check', verifying: false } },
    )
    expect(confirming.actionMode).toBe('confirming')
    expect(confirming.blockedReason).toBe('操作确认中')

    const verifying = deriveExperienceState(
      state({ phase: 'preflop', handSeq: 1, turnSeat: 0, legalActions: ['check'] }),
      { ...LIVE, pending: { type: 'check', verifying: true } },
    )
    expect(verifying.actionMode).toBe('verifying')
    expect(verifying.blockedReason).toBe('正在核对操作结果')
  })

  it('未参与本手 → waitingNextHand；弃牌 → folded；全下 → allIn', () => {
    const watching = state({ phase: 'flop', handSeq: 1, participation: 'waiting_next_hand' })
    expect(deriveExperienceState(watching, LIVE).actionMode).toBe('waitingNextHand')
    expect(deriveExperienceState(watching, LIVE).blockedReason).toBe('本手未参与，等待下一手')

    const folded = state({
      phase: 'flop',
      handSeq: 1,
      participation: 'in_hand',
      seats: [seat({ seat: 0, nick: '你', folded: true }), seat({ seat: 1 })],
    })
    expect(deriveExperienceState(folded, LIVE).actionMode).toBe('folded')

    const allIn = state({
      phase: 'flop',
      handSeq: 1,
      participation: 'in_hand',
      seats: [seat({ seat: 0, nick: '你', allIn: true }), seat({ seat: 1 })],
    })
    expect(deriveExperienceState(allIn, LIVE).actionMode).toBe('allIn')
  })

  it('本人回合只透传服务端 legalActions；非本人回合指出等待者', () => {
    const mine = deriveExperienceState(
      state({ phase: 'preflop', handSeq: 1, participation: 'in_hand', turnSeat: 0, legalActions: ['fold', 'call'] }),
      LIVE,
    )
    expect(mine.actionMode).toBe('myTurn')
    expect(mine.actions).toEqual(['fold', 'call'])
    expect(mine.blockedReason).toBeNull()

    const other = deriveExperienceState(
      state({ phase: 'preflop', handSeq: 1, participation: 'in_hand', turnSeat: 1 }),
      LIVE,
    )
    expect(other.actionMode).toBe('waitingTurn')
    expect(other.blockedReason).toBe('等待 樱 行动')
  })

  it('结算阶段统一为 settled，不残留可操作态', () => {
    expect(deriveExperienceState(state({ phase: 'settled', handSeq: 1, lastResult: result }), LIVE).actionMode).toBe(
      'settled',
    )
  })
})

describe('deriveExperienceState · 阶段进度与文案', () => {
  it('下注街：当前街高亮，之前完成，之后待进行', () => {
    const view = deriveExperienceState(state({ phase: 'flop', handSeq: 2, community: [] }), LIVE)
    expect(view.phaseSteps.map((s) => s.status)).toEqual(['done', 'current', 'pending', 'pending'])
    expect(view.statusTitle).toContain('翻牌')
  })

  it('弃牌提前结束：未到达的街标跳过，不用假进度', () => {
    const view = deriveExperienceState(
      state({
        phase: 'settled',
        handSeq: 2,
        community: [
          { id: 1, title: '', score: 0, bucket: 0, year: 0, monogram: '' },
          { id: 2, title: '', score: 0, bucket: 0, year: 0, monogram: '' },
          { id: 3, title: '', score: 0, bucket: 0, year: 0, monogram: '' },
        ],
        lastResult: { ...result, endReason: 'fold_win' },
      }),
      LIVE,
    )
    expect(view.phaseSteps.map((s) => s.status)).toEqual(['done', 'done', 'skipped', 'skipped'])
  })

  it('全下发牌：四轮直接完成并给出无下注说明', () => {
    const view = deriveExperienceState(state({ phase: 'preflop', handSeq: 1, runout: true }), LIVE)
    expect(view.phaseSteps.every((s) => s.status === 'done')).toBe(true)
    expect(view.statusDetail).toContain('全下发牌')
    expect(view.nextHint).toContain('等待发完公共牌')
  })

  it('等待/结算文案反映真实下一手策略', () => {
    const waiting = deriveExperienceState(state(), LIVE)
    expect(waiting.statusTitle).toBe('等待开局')
    expect(waiting.nextHint).toBe('全体真人准备后开始下一手')

    const auto = deriveExperienceState(
      state({ phase: 'settled', handSeq: 1, lastResult: result, nextHandPolicy: 'automatic', nextHandAt: 1 }),
      LIVE,
    )
    expect(auto.statusTitle).toBe('本手结束')
    expect(auto.nextHint).toBe('下一手将按排程自动开始')
  })
})

describe('summarizeResult · 本人优先', () => {
  it('本人净变化、积分变化与获奖座位', () => {
    const sum = summarizeResult(result, 0)!
    expect(sum.chipsDelta).toBe(120)
    expect(sum.pointsDelta).toBe(35)
    expect(sum.wonChips).toBe(60)
    expect(sum.winnerSeats.sort()).toEqual([0, 1])
  })

  it('无结算摘要返回 null', () => {
    expect(summarizeResult(null, 0)).toBeNull()
  })
})

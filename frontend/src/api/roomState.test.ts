// 桌面归约契约：聊天/固证生命周期、快照恢复、seq 基线过滤（丢弃 seq ≤ snapshot.seq 的在途事件）、
// 结算态跨快照保留（重连不清结算面板）、契约增量（seq/minRaise/turnMs/seed/box/pool/ready/rebuys/
// nextHand/readied）。
import { beforeEach, describe, it, expect } from 'vitest'
import { applyEvent, clearError, createRoomState } from './roomState'
import type { Envelope, HandResult, SeatState, SnapshotPayload, StateFrame } from './types'

let nextSeq = 1
const env = (t: string, p: unknown): Envelope => ({ t, seq: nextSeq++, p })

beforeEach(() => {
  nextSeq = 1
})

/** 快照夹具：缺省一个可跑通的开局快照 */
const snap = (over: Partial<SnapshotPayload> = {}): SnapshotPayload => ({
  roomCode: 'SAKURA',
  autoReveal: false,
  phase: 'preflop',
  handSeq: 3,
  seats: [],
  mySeat: 0,
  myCards: [],
  community: [],
  pot: 0,
  currentBet: 0,
  turnSeat: 0,
  deadline: null,
  smallBlind: 1,
  bigBlind: 2,
  revealRate: 0,
  reveals: [],
  seq: 0,
  minRaise: 2,
  turnMs: 30000,
  seed: null,
  box: [],
  pool: { strategy: 'stratified', theme: null, poolSize: 13, fallback: false },
  ...over,
})

const seat = (over: Partial<SeatState> = {}): SeatState => ({
  seat: 0,
  nick: '你',
  chips: 100,
  points: 0,
  bet: 0,
  folded: false,
  acted: false,
  isDealer: true,
  holeCount: 2,
  ready: false,
  rebuys: 0,
  ...over,
})

describe('roomState 聊天与固证', () => {
  it('said 追加聊天账本（seat/text/时刻）', () => {
    let s = createRoomState()
    s = applyEvent(s, env('said', { seat: 1, text: '你好' }))
    s = applyEvent(s, env('said', { seat: 0, text: '嗨' }))
    expect(s.chat.map((c) => `${c.seat}:${c.text}`)).toEqual(['1:你好', '0:嗨'])
  })

  it('聊天账本封顶 50 条，丢最旧', () => {
    let s = createRoomState()
    for (let i = 0; i < 55; i++) s = applyEvent(s, env('said', { seat: 0, text: `m${i}` }))
    expect(s.chat).toHaveLength(50)
    expect(s.chat[0].text).toBe('m5')
    expect(s.chat[49].text).toBe('m54')
  })

  it('seedCommit 存固证并重置上一手的 seedReveal；seedReveal 存种子', () => {
    let s = createRoomState()
    s = applyEvent(s, env('seedCommit', { sha256: 'aa11' }))
    expect(s.seedCommit).toBe('aa11')
    s = applyEvent(s, env('seedReveal', { seed: 'seed-1' }))
    expect(s.seedReveal).toBe('seed-1')
    // 新一手固证到达：上一手的揭示结论不残留
    s = applyEvent(s, env('seedCommit', { sha256: 'bb22' }))
    expect(s.seedCommit).toBe('bb22')
    expect(s.seedReveal).toBeNull()
  })

  it('快照恢复：聊天账本不丢，chatEnabled/seedCommit 随快照采纳', () => {
    let s = createRoomState()
    s = applyEvent(s, env('said', { seat: 2, text: '重连前的话' }))
    s = applyEvent(s, env('snapshot', snap({ chatEnabled: false, seedCommit: 'cc33' })))
    expect(s.chat.map((c) => c.text)).toEqual(['重连前的话'])
    expect(s.chatEnabled).toBe(false)
    expect(s.seedCommit).toBe('cc33')
  })
})

describe('roomState 时序与结算态', () => {
  it('seq 基线过滤：丢弃 seq ≤ snapshot.seq 的在途旧事件，snapshot 恒采纳', () => {
    let s = createRoomState()
    s = applyEvent(s, { t: 'snapshot', seq: 100, p: snap({ seq: 100 }) })
    expect(s.seq).toBe(100)
    // 在途旧事件（seq 落后于快照基线）直接丢弃：原样返回
    expect(applyEvent(s, { t: 'said', seq: 99, p: { seat: 1, text: '旧事件' } })).toBe(s)
    // 基线之后的新事件照常归约并推进基线
    s = applyEvent(s, { t: 'said', seq: 101, p: { seat: 1, text: '新事件' } })
    expect(s.chat.map((c) => c.text)).toEqual(['新事件'])
    expect(s.seq).toBe(101)
    // 快照不受基线限制；基线不回退
    s = applyEvent(s, { t: 'snapshot', seq: 5, p: snap({ seq: 5, handSeq: 4 }) })
    expect(s.handSeq).toBe(4)
    expect(s.seq).toBe(101)
  })

  it('同手快照保留结算态（重连不清结算面板）；换手快照才清', () => {
    let s = createRoomState()
    s = applyEvent(s, env('snapshot', snap({ handSeq: 3 })))
    s = applyEvent(
      s,
      env('showdown', { hands: [{ seat: 0, cards: [], groups: [], tier: 7, tiebreak: [7] }] }),
    )
    s = applyEvent(s, env('settled', { rows: [], potWins: { 0: 10 } }))
    expect(s.settled).toEqual({ rows: [], potWins: { 0: 10 } })
    // 重连（同手快照）：结算面板不被清掉
    s = applyEvent(s, env('snapshot', snap({ handSeq: 3, phase: 'settled' })))
    expect(s.settled).toEqual({ rows: [], potWins: { 0: 10 } })
    expect(s.showdown).toHaveLength(1)
    // 新一手快照：上一手结算态清空
    s = applyEvent(s, env('snapshot', snap({ handSeq: 4 })))
    expect(s.settled).toBeNull()
    expect(s.showdown).toBeNull()
    expect(s.nextHandAt).toBeNull()
  })

  it('acted / 换街下发 minRaise 时以服务端为准，缺省沿用上一值', () => {
    let s = createRoomState()
    s = applyEvent(s, env('snapshot', snap({ minRaise: 20, currentBet: 50, turnSeat: 0 })))
    s = applyEvent(
      s,
      env('acted', { seat: 1, type: 'raise', amount: 70, turnSeat: 0, deadline: null, minRaise: 30 }),
    )
    expect(s.minRaise).toBe(30)
    s = applyEvent(s, env('flop', { cards: [], turnSeat: 0, deadline: null }))
    expect(s.minRaise).toBe(30)
    s = applyEvent(s, env('turn', { cards: [], minRaise: 2 }))
    expect(s.minRaise).toBe(2)
  })
})

describe('roomState 契约增量', () => {
  it('快照采纳 seq/minRaise/turnMs/seed/box/pool 与座位 ready/rebuys', () => {
    let s = createRoomState()
    s = applyEvent(
      s,
      env('snapshot', snap({
        seq: 42,
        minRaise: 20,
        turnMs: 15000,
        seed: 'seed-x',
        box: [{ id: 1, title: '你的名字。', score: 8.4, bucket: 8.5, year: 2016 }],
        pool: {
          strategy: 'theme',
          theme: { kind: 'company', value: '京都动画' },
          poolSize: 13,
          fallback: true,
        },
        seats: [seat({ ready: true, rebuys: 2 })],
      })),
    )
    expect(s.seq).toBe(42)
    expect(s.minRaise).toBe(20)
    expect(s.turnMs).toBe(15000)
    expect(s.seedReveal).toBe('seed-x')
    expect(s.box).toEqual([{ id: 1, title: '你的名字。', score: 8.4, bucket: 8.5, year: 2016 }])
    expect(s.pool?.fallback).toBe(true)
    expect(s.seats[0]).toMatchObject({ ready: true, rebuys: 2 })
  })

  it('旧版快照缺新字段：座位 ready/rebuys 取默认，seed 沿用现值', () => {
    let s = createRoomState()
    s = applyEvent(s, env('seedReveal', { seed: 'seed-keep' }))
    s = applyEvent(
      s,
      env('snapshot', snap({
        handSeq: 3,
        seed: undefined,
        seats: [{ ...seat(), ready: undefined, rebuys: undefined } as unknown as SeatState],
      })),
    )
    expect(s.seedReveal).toBe('seed-keep')
    expect(s.seats[0].ready).toBe(false)
    expect(s.seats[0].rebuys).toBe(0)
  })

  it('readied 标记座位准备；nextHand 记下自动开局时刻', () => {
    let s = createRoomState()
    s = applyEvent(s, env('snapshot', snap({ seats: [seat({ seat: 0 }), seat({ seat: 1, isDealer: false })] })))
    s = applyEvent(s, env('readied', { seat: 1 }))
    expect(s.seats[0].ready).toBe(false)
    expect(s.seats[1].ready).toBe(true)
    s = applyEvent(s, env('nextHand', { startAt: 1234567 }))
    expect(s.nextHandAt).toBe(1234567)
  })

  it('clearError 清提示；无提示时原样返回', () => {
    let s = createRoomState()
    s = applyEvent(s, env('error', { code: 'illegal_raise', msg: '加注额不够' }))
    expect(s.lastError).toBe('加注额不够')
    s = clearError(s)
    expect(s.lastError).toBeNull()
    expect(clearError(s)).toBe(s)
  })
})

describe('roomState v2 权威状态帧', () => {
  const card = (id: number) => ({ id, title: `牌${id}`, score: 80, bucket: 3, year: 2015, monogram: '牌' })

  const handResult = (over: Partial<HandResult> = {}): HandResult => ({
    handSeq: 3,
    endedAt: 1700000000000,
    endReason: 'showdown',
    seats: [],
    rows: [{ seat: 0, chipsDelta: 20, points: { handScore: 5, bondBonus: 0, revealCost: 0 } }],
    potWins: { 0: 20 },
    showdown: [],
    ...over,
  })

  const frame = (over: Partial<StateFrame> = {}): Envelope =>
    env('state', {
      protocolVersion: 2,
      roomCode: 'SAKURA',
      roomInstanceId: 'inst-1',
      revision: 1,
      serverNow: 1000,
      reason: 'join',
      state: snap({ myCards: [card(1), card(2)], legalActions: ['fold', 'call'] }),
      events: [],
      receipts: [],
      ...over,
    })

  it('旧版协议帧不进入 v2，不置 live', () => {
    const s = applyEvent(createRoomState(), frame({ protocolVersion: 1 }))
    expect(s.live).toBe(false)
    expect(s.protocol).toBe(0)
  })

  it('首帧 revision=0 也落库并置 live；已 live 后同 revision 空帧原样返回', () => {
    let s = applyEvent(
      createRoomState(),
      frame({ revision: 0, state: snap({ myCards: [card(1), card(2)], legalActions: ['fold'] }) }),
    )
    expect(s.live).toBe(true)
    expect(s.revision).toBe(0)
    expect(s.myCards).toHaveLength(2)

    // 已 live：同 revision 且无回执/事件 → 不重建（原引用）
    expect(applyEvent(s, frame({ revision: 0, state: snap() }))).toBe(s)
  })

  it('低 revision 丢弃；相同 revision 只合并回执与事件', () => {
    let s = applyEvent(createRoomState(), frame({ revision: 2 }))
    expect(s.live).toBe(true)
    expect(s.revision).toBe(2)
    expect(s.myCards).toHaveLength(2)

    s = applyEvent(s, frame({ revision: 1, state: snap() }))
    expect(s.revision).toBe(2)
    expect(s.myCards).toHaveLength(2)

    s = applyEvent(
      s,
      frame({
        revision: 2,
        state: snap(),
        receipts: [{ requestId: 'r1', status: 'applied', appliedRevision: 2 }],
      }),
    )
    expect(s.revision).toBe(2)
    expect(s.myCards).toHaveLength(2) // 同 revision 不替换权威数据
    expect(s.receipts.r1.status).toBe('applied')
  })

  it('房间实例变化清空旧私牌、聊天与回执', () => {
    let s = applyEvent(
      createRoomState(),
      frame({ revision: 5, receipts: [{ requestId: 'old', status: 'applied' }] }),
    )
    s = applyEvent(s, env('said', { seat: 1, text: '你好' }))
    expect(s.receipts.old).toBeTruthy()
    expect(s.chat).toHaveLength(1)

    s = applyEvent(s, frame({ revision: 6, roomInstanceId: 'inst-2' }))
    expect(s.roomInstanceId).toBe('inst-2')
    expect(s.revision).toBe(6)
    expect(s.myCards).toHaveLength(2) // 新实例自己的底牌照常采纳
    expect(s.chat).toHaveLength(0)
    expect(s.receipts).toEqual({})
  })

  it('同一手连续结算帧复用 settled/showdown 引用，新一手才变化', () => {
    const result = handResult()
    const settledSnap = snap({ phase: 'settled', handSeq: 3, lastResult: result })
    let s = applyEvent(createRoomState(), frame({ revision: 1, state: settledSnap }))
    const settled = s.settled
    const showdown = s.showdown
    expect(settled).not.toBeNull()

    // 同一手再来一帧（内容等价但对象重建）：引用保持不变，防音效/特效重播
    s = applyEvent(
      s,
      frame({ revision: 2, state: { ...settledSnap, seats: [...settledSnap.seats] } }),
    )
    expect(s.settled).toBe(settled)
    expect(s.showdown).toBe(showdown)

    // 新一手：引用变化
    s = applyEvent(
      s,
      frame({
        revision: 3,
        state: snap({ phase: 'settled', handSeq: 4, lastResult: { ...result, handSeq: 4 } }),
      }),
    )
    expect(s.settled).not.toBe(settled)
  })

  it('lastResult 仅在 showdown/settled 投影为结算态（重连后可恢复）', () => {
    const result = handResult()
    const live = applyEvent(createRoomState(), frame({ state: snap({ phase: 'settled', lastResult: result }) }))
    expect(live.lastResult?.handSeq).toBe(3)
    expect(live.settled?.potWins).toEqual({ 0: 20 })

    const nextHand = applyEvent(live, frame({ revision: 2, state: snap({ phase: 'preflop', lastResult: result }) }))
    expect(nextHand.lastResult?.handSeq).toBe(3) // 上手摘要保留给回顾
    expect(nextHand.settled).toBeNull() // 新一手不残留结算面板
    expect(nextHand.showdown).toBeNull()
  })
})

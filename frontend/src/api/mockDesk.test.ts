// @vitest-environment happy-dom
// mock 桌面契约对齐（真源 backend/internal/model/ws.go）：快照契约增量、ready/readied 开局、
// 轮庄盲注与行动权、bot 全下推演到摊牌结算、破产重买对账快照、nextHand 排程与全员 ready 提前开局、
// 主题池过滤与回退。
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { startMockDesk } from './mockDesk'
import type { Envelope, NextHandPayload, ReadiedPayload, SettledPayload, SnapshotPayload } from './types'

const OPTS = {
  roomCode: 'SAKURA',
  nick: '你',
  autoReveal: false,
  smallBlind: 1,
  bigBlind: 2,
  revealRate: 0,
  chatEnabled: true,
}

let events: Envelope[] = []
const collect = (e: Envelope) => events.push(e)
const snaps = () => events.filter((e) => e.t === 'snapshot').map((e) => e.p as SnapshotPayload)
const lastSnap = () => snaps()[snaps().length - 1]

beforeEach(() => {
  vi.useFakeTimers()
  events = []
})
afterEach(() => vi.useRealTimers())

describe('mockDesk 契约增量', () => {
  it('快照带 seq/minRaise/turnMs/box/pool/seats.ready/rebuys；bot 落座广播 readied', async () => {
    const desk = startMockDesk(OPTS, collect)
    await vi.advanceTimersByTimeAsync(300)
    desk.close()
    const snap = lastSnap()
    expect(snap.seq).toBeGreaterThan(0)
    expect(snap.minRaise).toBe(2)
    expect(snap.turnMs).toBe(30000)
    expect(snap.seed).toBeNull()
    expect(snap.box).toHaveLength(13)
    expect(snap.pool).toEqual({ strategy: 'stratified', theme: null, poolSize: 13, fallback: false })
    expect(snap.seats.map((s) => [s.ready, s.rebuys])).toEqual([
      [false, 0],
      [false, 0],
      [false, 0],
      [false, 0],
    ])
    expect(events.filter((e) => e.t === 'readied').map((e) => (e.p as ReadiedPayload).seat)).toEqual([1, 2, 3])
  })

  it('主题池：命中即过滤盒名单；过窄回退全库（fallback）', async () => {
    const desk = startMockDesk(
      { ...OPTS, deckStrategy: 'theme', themeFilter: { kind: 'company', value: '京都动画' } },
      collect,
    )
    await vi.advanceTimersByTimeAsync(300)
    desk.close()
    expect(lastSnap().pool).toEqual({
      strategy: 'theme',
      theme: { kind: 'company', value: '京都动画' },
      poolSize: 2,
      fallback: false,
    })
    expect(lastSnap().box).toHaveLength(2)

    events = []
    const desk2 = startMockDesk(
      { ...OPTS, deckStrategy: 'theme', themeFilter: { kind: 'company', value: 'WHITE FOX' } },
      collect,
    )
    await vi.advanceTimersByTimeAsync(300)
    desk2.close()
    expect(lastSnap().pool?.fallback).toBe(true)
    expect(lastSnap().box).toHaveLength(13)
  })
})

describe('mockDesk 对局流程', () => {
  it('ready 开局：handSeq=1、轮庄盲注、发牌单一下发、行动权在大盲后', async () => {
    const desk = startMockDesk(OPTS, collect)
    await vi.advanceTimersByTimeAsync(300)
    desk.send({ t: 'ready', p: {} })
    await vi.advanceTimersByTimeAsync(500)
    desk.close()
    const snap = lastSnap()
    expect(snap.handSeq).toBe(1)
    expect(snap.phase).toBe('preflop')
    expect(snap.pot).toBe(3) // 小盲 1 + 大盲 2
    expect(snap.seats.find((s) => s.isDealer)?.seat).toBe(0) // 首手庄家 0
    expect(snap.seats.find((s) => s.seat === 1)?.bet).toBe(1) // 庄家+1 小盲
    expect(snap.seats.find((s) => s.seat === 2)?.bet).toBe(2) // 庄家+2 大盲
    expect(snap.turnSeat).toBe(3) // 大盲后第一个行动
    expect(snap.seedCommit).toBeTruthy()
    expect(snap.seed).toBeNull()
    // 发牌：自己拿牌对象，他人只到占位（D7）
    const dealtMe = events.find((e) => e.t === 'dealt' && (e.p as { seat: number }).seat === 0)
    expect((dealtMe?.p as { cards: unknown[] }).cards).toHaveLength(2)
    const dealtOther = events.find((e) => e.t === 'dealt' && (e.p as { seat: number }).seat === 1)
    expect((dealtOther?.p as { cards: unknown[] }).cards).toHaveLength(0)
  })

  it('全下推演到摊牌结算：bot 跟全下、破产重买对账、nextHand 排程', async () => {
    const desk = startMockDesk(OPTS, collect)
    await vi.advanceTimersByTimeAsync(300)
    desk.send({ t: 'ready', p: {} })
    await vi.advanceTimersByTimeAsync(900) // bot 3 跟注，轮到自己
    desk.send({ t: 'action', p: { type: 'allin' } })
    await vi.advanceTimersByTimeAsync(12000)
    desk.close()

    const acted = events.filter((e) => e.t === 'acted').map((e) => e.p as { seat: number; type: string })
    expect(acted.some((a) => a.seat === 0 && a.type === 'allin')).toBe(true)
    expect(acted.filter((a) => a.type === 'allin').length).toBeGreaterThanOrEqual(3) // 短码 bot 也全下
    expect(acted.some((a) => a.seat === 3 && a.type === 'call')).toBe(true) // 翻前跟注
    expect(events.some((e) => e.t === 'showdown')).toBe(true)
    const settled = events.find((e) => e.t === 'settled')!.p as SettledPayload
    // 摊牌夹具自己赢：满池 = 三家全下 3000 + 座位 3 翻前跟注 2
    expect(settled.potWins[0]).toBe(3002)
    // 破产重买：输光的 bot 就地重买计入 rebuys，对账快照带上
    const snap = lastSnap()
    expect(snap.seats.find((s) => s.seat === 1)).toMatchObject({ chips: 1000, rebuys: 1 })
    expect(snap.seats.find((s) => s.seat === 0)?.rebuys).toBe(0)
    // 下一手排程：8 秒后自动开局
    const nextHand = events.find((e) => e.t === 'nextHand')!.p as NextHandPayload
    expect(nextHand.startAt).toBeGreaterThan(Date.now())
  })

  it('settled 后全员 ready 提前开局（不等自动开局）', async () => {
    const desk = startMockDesk(OPTS, collect)
    await vi.advanceTimersByTimeAsync(300)
    desk.send({ t: 'ready', p: {} })
    await vi.advanceTimersByTimeAsync(900)
    desk.send({ t: 'action', p: { type: 'allin' } })
    await vi.advanceTimersByTimeAsync(12000)
    expect(lastSnap().phase).toBe('settled')
    desk.send({ t: 'ready', p: {} })
    await vi.advanceTimersByTimeAsync(800) // bot 200/400/600 陆续 ready，700 全员到齐即开
    desk.close()
    expect(lastSnap().handSeq).toBe(2)
    expect(events.filter((e) => e.t === 'readied').map((e) => (e.p as ReadiedPayload).seat)).toEqual(
      expect.arrayContaining([0, 1, 2, 3]),
    )
  })

  it('非法动作回 error（不吞不崩）', async () => {
    const desk = startMockDesk(OPTS, collect)
    await vi.advanceTimersByTimeAsync(300)
    desk.send({ t: 'ready', p: {} })
    await vi.advanceTimersByTimeAsync(900)
    // 轮到自己时最小目标 = currentBet(2) + minRaise(2) = 4，给 3 非法
    desk.send({ t: 'action', p: { type: 'raise', amount: 3 } })
    await vi.advanceTimersByTimeAsync(10)
    desk.close()
    const err = events.find((e) => e.t === 'error')!.p as { code: string }
    expect(err.code).toBe('illegal_raise')
  })
})

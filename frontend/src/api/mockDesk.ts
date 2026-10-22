/**
 * mock 桌面（内存假服务）：在后端联调前让全流程 UI 可走通——
 * 发牌 → 下注（bot 轮转，含弃牌/加注/全下）→ 揭示（含他人揭示）→ 摊牌 → 结算 → 下一手。
 *
 * 契约真源：backend/internal/model/ws.go（信封 {t, seq, p} 与全部载荷 JSON 字段名）。
 * 形态完全对齐 WS 协议：下行走 snapshot/dealt/flop/turn/river/acted/revealed/emoted/said/
 * seedCommit/seedReveal/showdown/settled/nextHand/readied/error，上行收
 * join/ready/action/reveal/emote/say/leave/ping/resync。隐藏纪律同样成立：
 * 未揭示牌对象不带 elements 字段（D7），盒名单只带 L1 字段。
 */
import { CHAT_MAX_LEN, DEFAULT_TURN_MS } from './types'
import type {
  ActionType,
  BoxCard,
  CardData,
  ClientMessage,
  CommandReceipt,
  DeckStrategy,
  EmoteKey,
  Envelope,
  ExperienceEvent,
  HandResult,
  PoolInfo,
  RevealScope,
  SeatState,
  SettleRow,
  SnapshotPayload,
  StateFrame,
  ThemeFilter,
} from './types'
import {
  BOX,
  FLOP,
  HOLE_CARDS,
  MIN_THEME_POOL,
  NICKS,
  RIVER,
  SHOWDOWN,
  TURN,
  matchTheme,
  withElements,
} from './mockCards'

/** 与 useRoomSocket 的发送面等价的假连接 */
export interface DeskTransport {
  send: (msg: ClientMessage) => void
  close: () => void
}

export interface MockDeskOptions {
  roomCode: string
  nick: string
  /** 开局自动展开要素（D14）：true = 牌面直接印要素 */
  autoReveal: boolean
  smallBlind: number
  bigBlind: number
  revealRate: number
  /** 房主是否开放聊天（roomConfig.chatEnabled，默认 true） */
  chatEnabled?: boolean
  /** 牌池策略（D11）：theme 时按 themeFilter 过滤盒名单 */
  deckStrategy?: DeckStrategy
  /** 主题过滤项（deckStrategy=theme 时携带） */
  themeFilter?: ThemeFilter | null
}

const SEAT_IDS = [0, 1, 2, 3]
const START_CHIPS = 1000
const TURN_MS = DEFAULT_TURN_MS
const BOT_STEP_MS = 900
/** 下一手自动开局延迟（与服务端 NEXT_HAND_DELAY_SECONDS=8 同口径） */
const NEXT_HAND_DELAY_MS = 8000
/** 重买上限（与服务端 MAX_REBUYS 同口径） */
const MAX_REBUYS = 3

/** mock 发牌种子与其固证（SHA-256(seed) hex；commit-reveal 固定夹具，验证必过） */
const MOCK_SEED = 'anitexas-mock-seed-2026'
const MOCK_SEED_COMMIT =
  'b43850884fa5bde6bd64cc2a35ee92ea4ae3d6fffaf3020f5d7e27d7b1d6ade2'

/** 定时器句柄（window 定时器恒为 number） */
type TimerId = number

/**
 * 启动 mock 桌面。桌内是四人局（自己 + 3 bot）：轮庄盲注、bot 会弃牌/加注/全下，
 * 河牌轮后摊牌结算，破产就地重买（达上限 bot 接管），随后排程下一手。
 */
export function startMockDesk(opts: MockDeskOptions, onEvent: (e: Envelope) => void): DeskTransport {
  let seq = 0
  const timers: TimerId[] = []
  let closed = false

  // ===== 对局态 =====
  let phase: 'waiting' | 'playing' | 'settled' = 'waiting'
  /** 手序号：每手 +1（snapshot.handSeq） */
  let handSeq = 0
  /** 街序号：0 等待/结算 → 1 preflop → 2 flop → 3 turn → 4 river */
  let street = 0
  let dealer = 0
  let turnSeat = -1
  let deadline: number | null = null
  let pot = 0
  let currentBet = 0
  /** 最小加注增量：raise 的 target 须 ≥ currentBet + minRaise（全下豁免） */
  let minRaise = opts.bigBlind
  let seedShown = false
  /** v2：房间实例与可见状态版本（每次可见事务 +1） */
  const instanceId = `mock-${opts.roomCode}-1`
  let revision = 0
  let nextHandAt: number | null = null
  let lastResult: HandResult | null = null
  let eventSeq = 0
  const chips = new Array<number>(SEAT_IDS.length).fill(START_CHIPS)
  /** 本轮已下注（换街清零） */
  const bets = new Array<number>(SEAT_IDS.length).fill(0)
  /** 本手总投入（结算盈亏） */
  const staked = new Array<number>(SEAT_IDS.length).fill(0)
  const folded = new Array<boolean>(SEAT_IDS.length).fill(false)
  const acted = new Array<boolean>(SEAT_IDS.length).fill(false)
  const ready = new Array<boolean>(SEAT_IDS.length).fill(false)
  const rebuys = new Array<number>(SEAT_IDS.length).fill(0)
  const nicks = [opts.nick, NICKS[1], NICKS[2], NICKS[3]]

  // 盒名单与牌池摘要（D11/D17）：主题池 = 过滤后再分层；过滤过窄回退全库
  const theme: ThemeFilter | null = opts.deckStrategy === 'theme' ? opts.themeFilter ?? null : null
  const themed = theme?.value ? BOX.filter((c) => matchTheme(c, theme)) : BOX
  const fallback = !!theme?.value && themed.length < MIN_THEME_POOL
  const box: BoxCard[] = fallback ? BOX : themed
  const pool: PoolInfo = {
    strategy: opts.deckStrategy ?? 'stratified',
    theme,
    poolSize: box.length,
    fallback,
  }

  const emit = (t: string, p: unknown) => {
    if (closed) return
    onEvent({ t, seq: ++seq, p })
  }

  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      if (!closed) fn()
    }, ms)
    timers.push(id)
  }

  /** autoReveal 时牌对象带要素（D14）；否则原样下发（未揭示牌无 elements 字段，D7） */
  const shown = (cards: CardData[]) => (opts.autoReveal ? cards.map(withElements) : cards)

  // ===== 快照构造 =====

  /** 服务端规则给出的本人合法动作（UI 唯一依据） */
  const myLegalActions = (): ActionType[] => {
    if (phase !== 'playing' || turnSeat !== 0 || folded[0]) return []
    const toCall = Math.max(0, currentBet - bets[0])
    const out: ActionType[] = ['fold']
    // 与服务端 legalActionsLocked 对齐：跟齐额超过剩余筹码时只列 allin，不列 call
    if (toCall === 0) out.push('check')
    else if (toCall <= chips[0]) out.push('call')
    if (chips[0] > toCall) out.push(currentBet > 0 ? 'raise' : 'bet')
    if (chips[0] > 0) out.push('allin')
    return out
  }

  const phaseValue = (): SnapshotPayload['phase'] =>
    phase === 'waiting'
      ? 'waiting'
      : phase === 'settled'
        ? 'settled'
        : (['preflop', 'flop', 'turn', 'river'] as const)[Math.max(0, street - 1)]

  /** 全量快照（v2 权威状态帧的 state 区；加入、重连、每次可见事务都用它） */
  const buildSnapshot = (withHoleCards = true): SnapshotPayload => {
    const seats: SeatState[] = SEAT_IDS.map((seat) => ({
      seat,
      nick: nicks[seat],
      chips: chips[seat],
      points: 0,
      bet: bets[seat],
      folded: folded[seat],
      acted: acted[seat],
      isDealer: seat === dealer,
      holeCount: street === 0 ? 0 : 2,
      ready: ready[seat],
      rebuys: rebuys[seat],
      occupantKind: seat === 0 ? 'human' : 'bot',
      connection: seat === 0 ? 'online' : 'not_applicable',
      inHand: street > 0 && !folded[seat],
      allIn: street > 0 && chips[seat] === 0 && !folded[seat],
      pendingLeave: false,
    }))
    const dealtCommunity = [FLOP, TURN, RIVER].slice(0, Math.max(0, street - 1)).flat()
    const toCall = Math.max(0, currentBet - bets[0])
    const minTarget = currentBet + (minRaise > 0 ? minRaise : opts.bigBlind)
    const canRaise = phase === 'playing' && bets[0] + chips[0] >= minTarget
    const legal = myLegalActions()
    return {
      roomCode: opts.roomCode,
      autoReveal: opts.autoReveal,
      phase: phaseValue(),
      handSeq,
      seats,
      mySeat: 0,
      myCards: street === 0 || !withHoleCards ? [] : shown(HOLE_CARDS[0]),
      community: shown(dealtCommunity),
      pot,
      currentBet,
      turnSeat,
      deadline,
      smallBlind: opts.smallBlind,
      bigBlind: opts.bigBlind,
      revealRate: opts.revealRate,
      reveals: [],
      chatEnabled: opts.chatEnabled !== false,
      seedCommit: handSeq > 0 ? MOCK_SEED_COMMIT : null,
      seq: seq + 1,
      minRaise,
      turnMs: TURN_MS,
      seed: seedShown ? MOCK_SEED : null,
      box,
      pool,
      // ===== v2 =====
      roomInstanceId: instanceId,
      revision,
      roomStatus: phase === 'playing' ? 'playing' : 'waiting',
      nextHandAt,
      nextHandPolicy: 'automatic',
      readiness: {
        eligibleSeats: [0],
        readySeats: ready[0] ? [0] : [],
        blockers: ready[0] ? [] : [{ seat: 0, reason: 'unready' }],
      },
      viewerStatus: 'seated',
      removalReason: null,
      // 与服务端 participationLocked 对齐：waiting 未开局；playing 弃牌者等下一手
      participation:
        phase === 'waiting' ? 'not_started' : folded[0] ? 'waiting_next_hand' : 'in_hand',
      legalActions: legal,
      callAmount: toCall,
      minRaiseTo: legal.includes('raise') || legal.includes('bet') ? (canRaise ? minTarget : null) : null,
      maxRaiseTo: bets[0] + chips[0],
      timeoutAction: turnSeat >= 0 ? (toCall > 0 ? 'fold' : 'check') : null,
      runout: false,
      lastResult,
      recentEvents: [],
    }
  }

  /** 旧版增量快照（兼容既有事件消费方；v2 客户端以 state 帧为准） */
  const snapshot = (withHoleCards = true) => emit('snapshot', buildSnapshot(withHoleCards))

  /** v2 权威状态帧：每次可见事务结束发一帧完整、按视角裁剪的状态 */
  const emitState = (reason: StateFrame['reason'], events: ExperienceEvent[] = []) => {
    revision++
    const evs = events.map((ev, i) => ({ ...ev, eventId: ev.eventId || `mock-${revision}-${i}-${++eventSeq}` }))
    // 命令回执随本次提交帧返回（只给命令所属玩家；mock 只有座位 0 是人类）
    const receipts = pendingReceipt ? [pendingReceipt] : []
    pendingReceipt = null
    const frame: StateFrame = {
      protocolVersion: 2,
      roomCode: opts.roomCode,
      roomInstanceId: instanceId,
      revision,
      serverNow: Date.now(),
      reason,
      state: buildSnapshot(true),
      events: evs,
      receipts,
    }
    emit('state', frame)
  }

  /** 待回执命令（applied 随下一次提交帧；rejected 用同 revision 帧回执） */
  let pendingReceipt: CommandReceipt | null = null

  /** 同一 revision 的状态帧只带回执（不改变权威数据，客户端只合并回执） */
  const emitReceiptFrame = (receipt: CommandReceipt) => {
    emit('state', {
      protocolVersion: 2,
      roomCode: opts.roomCode,
      roomInstanceId: instanceId,
      revision,
      serverNow: Date.now(),
      reason: 'mutation',
      state: buildSnapshot(true),
      events: [],
      receipts: [receipt],
    } satisfies StateFrame)
  }

  /** 命令被拒：回 rejected 回执（不产生版本变更） */
  const rejectPending = (code: string) => {
    if (!pendingReceipt) return
    const receipt: CommandReceipt = {
      ...pendingReceipt,
      status: 'rejected',
      appliedRevision: null,
      code,
    }
    pendingReceipt = null
    emitReceiptFrame(receipt)
  }

  /** 构造一条过程事件（只用于历史/音效，不参与权威归约） */
  const ev = (
    kind: ExperienceEvent['kind'],
    seat: number | null,
    payload?: Record<string, unknown>,
  ): ExperienceEvent => ({
    eventId: '',
    handSeq,
    phase: phaseValue(),
    kind,
    seat,
    occurredAt: Date.now(),
    payload,
  })

  // ===== 流程推进 =====

  /** from 之后第一个可行动座位（未弃牌、有筹码、本轮未行动）；无则 -1 */
  const nextActor = (from: number): number => {
    for (let i = 1; i <= SEAT_IDS.length; i++) {
      const s = (from + i) % SEAT_IDS.length
      if (!folded[s] && chips[s] > 0 && !acted[s]) return s
    }
    return -1
  }

  /** 开一手：轮庄盲注、发快照、发牌（自己拿牌对象，他人拿占位），随后进入翻牌前行动 */
  const startHand = () => {
    phase = 'playing'
    handSeq++
    street = 1
    seedShown = false
    pot = 0
    currentBet = opts.bigBlind
    minRaise = opts.bigBlind
    nextHandAt = null
    // lastResult 保留到下一手结算（与后端同口径）：桌面「上手结果」回顾的依据
    dealer = (handSeq - 1) % SEAT_IDS.length // 轮庄：每手换庄
    for (const s of SEAT_IDS) {
      bets[s] = 0
      staked[s] = 0
      folded[s] = false
      acted[s] = false
      ready[s] = false // ready 每手重置
    }
    // 盲注：庄家+1 小盲、庄家+2 大盲
    const sb = (dealer + 1) % SEAT_IDS.length
    const bb = (dealer + 2) % SEAT_IDS.length
    for (const [seat, amount] of [
      [sb, opts.smallBlind],
      [bb, opts.bigBlind],
    ] as const) {
      const paid = Math.min(amount, chips[seat])
      chips[seat] -= paid
      bets[seat] += paid
      staked[seat] += paid
      pot += paid
    }
    // 翻牌前首个行动者：大盲之后（先定行动权，快照才带得上 turnSeat/deadline）
    turnSeat = nextActor(bb)
    deadline = turnSeat < 0 ? null : Date.now() + TURN_MS
    // 底牌由随后的 dealt 事件单一下发（快照先留空，防重复）
    snapshot(false)
    // v2：开局即发完整权威帧（底牌、盲注、行动权、截止时间同一逻辑提交）
    emitState('mutation', [ev('blind_posted', bb, { amount: opts.bigBlind })])
    // 开局固证（commit-reveal）：先承诺种子哈希，摊牌才揭种子
    emit('seedCommit', { sha256: MOCK_SEED_COMMIT })
    // 发牌：自己拿到牌对象，他人只到「已发 2 张」占位（D7）；
    // autoReveal 时牌对象直接带要素（D14，原明示体验）
    later(() => emit('dealt', { seat: 0, cards: shown(HOLE_CARDS[0]) }), 300)
    for (const seat of [1, 2, 3]) {
      later(() => emit('dealt', { seat, cards: [] }), 300 + 180 * seat)
    }
    const firstActor = turnSeat
    if (firstActor > 0) later(() => botAct(firstActor), BOT_STEP_MS)
    else if (firstActor < 0) later(nextStreet, BOT_STEP_MS)
  }

  /** bot 行动策略（确定性，便于演示与回归）：短码全下、偶发弃牌/最小加注，其余跟注/过牌 */
  const botAct = (seat: number) => {
    if (phase !== 'playing' || turnSeat !== seat) return
    const toCall = Math.max(0, currentBet - bets[seat])
    if (chips[seat] <= toCall || chips[seat] <= opts.bigBlind * 2) {
      commitAction(seat, 'allin')
    } else if (toCall > 0 && seat === 2 && handSeq % 2 === 0) {
      commitAction(seat, 'fold')
    } else if (toCall === 0 && seat === 1 && handSeq % 3 === 0 && street === 1) {
      commitAction(seat, currentBet > 0 ? 'raise' : 'bet', currentBet + minRaise)
    } else {
      commitAction(seat, toCall > 0 ? 'call' : 'check')
    }
  }

  /** 落一个动作并交棒/进街（acted 事件带服务端权威 turnSeat/deadline/minRaise） */
  const commitAction = (seat: number, type: ActionType, amount = 0) => {
    const toCall = Math.max(0, currentBet - bets[seat])
    let paid = 0
    switch (type) {
      case 'fold':
        folded[seat] = true
        break
      case 'check':
        break
      case 'call':
        paid = Math.min(toCall, chips[seat])
        break
      case 'bet':
      case 'raise': {
        // amount = 「加到」的目标；不足最小加注时贴到最小加注（真人路径已先校验）
        const target = Math.max(amount, currentBet + minRaise)
        paid = Math.min(Math.max(0, target - bets[seat]), chips[seat])
        break
      }
      case 'allin':
        paid = chips[seat]
        break
    }
    chips[seat] -= paid
    bets[seat] += paid
    staked[seat] += paid
    pot += paid
    if (bets[seat] > currentBet) {
      // 加注抬高最小加注增量（target ≥ currentBet + minRaise）
      minRaise = Math.max(minRaise, bets[seat] - currentBet)
      currentBet = bets[seat]
    }
    acted[seat] = true

    const alive = SEAT_IDS.filter((s) => !folded[s])
    const actor = alive.length <= 1 ? -1 : nextActor(seat)
    if (actor < 0) {
      turnSeat = -1
      deadline = null
      emit('acted', { seat, type, amount: paid, minRaise, turnSeat: -1, deadline: null })
      emitState('mutation', [ev('acted', seat, { type, amount: paid, target: bets[seat] })])
      // 本轮无后续行动者：只剩一人直接收池，否则进下一街
      later(alive.length <= 1 ? runShowdown : nextStreet, BOT_STEP_MS)
      return
    }
    turnSeat = actor
    deadline = Date.now() + TURN_MS
    emit('acted', { seat, type, amount: paid, minRaise, turnSeat: actor, deadline })
    emitState('mutation', [ev('acted', seat, { type, amount: paid, target: bets[seat] })])
    if (actor !== 0) later(() => botAct(actor), BOT_STEP_MS)
  }

  /** 换街：清本轮注、发公共牌、开新一轮行动 */
  const nextStreet = () => {
    if (phase !== 'playing') return
    if (street >= 4) {
      runShowdown()
      return
    }
    street++
    currentBet = 0
    minRaise = opts.bigBlind
    for (const s of SEAT_IDS) {
      bets[s] = 0
      acted[s] = false
    }
    const cards = street === 2 ? FLOP : street === 3 ? TURN : RIVER
    const name = street === 2 ? 'flop' : street === 3 ? 'turn' : 'river'
    turnSeat = nextActor(dealer)
    deadline = turnSeat < 0 ? null : Date.now() + TURN_MS
    emit(name, { cards: shown(cards), turnSeat, deadline, minRaise })
    // 与后端事件名一致：换街事件本身就是 flop / turn / river
    emitState('mutation', [ev(name, null)])
    const firstActor = turnSeat
    if (firstActor > 0) later(() => botAct(firstActor), BOT_STEP_MS)
    else if (firstActor < 0) later(nextStreet, BOT_STEP_MS) // 全下桌：无行动者，直接发下一街
    // 他人揭示：翻牌后 bot 偶尔当众亮一只底牌（public 才带要素）
    if (street === 2 && handSeq % 2 === 0) later(botReveal, BOT_STEP_MS)
  }

  /** 他人揭示演示：bot 当众翻一只底牌（对手底牌不可私看，D2） */
  const botReveal = () => {
    const seat = 1
    if (phase !== 'playing' || folded[seat]) return
    const card = HOLE_CARDS[seat][0]
    emit('revealed', {
      seat,
      cardId: card.id,
      scope: 'public',
      // v1 成本策略 ZeroPolicy：恒 0，账照记（D4）
      cost: 0,
      elements: withElements(card).elements,
    })
  }

  /** 摊牌结算：揭种子 → 摊牌（弃牌收池无对比）→ 结算 → 破产重买 → 排程下一手 */
  const runShowdown = () => {
    phase = 'settled'
    turnSeat = -1
    deadline = null
    later(() => {
      // 揭种子（commit-reveal 后半）：本地哈希比对固证即可验证发牌
      seedShown = true
      emit('seedReveal', { seed: MOCK_SEED })
      const alive = SEAT_IDS.filter((s) => !folded[s])
      const hands = SHOWDOWN.filter((h) => alive.includes(h.seat))
      if (hands.length > 1) emit('showdown', { hands: hands })
      later(() => {
        const winner = hands.length > 1 ? hands[0].seat : alive[0]
        chips[winner] += pot
        const rows: SettleRow[] = SEAT_IDS.map((seat) => ({
          seat,
          chipsDelta: (seat === winner ? pot : 0) - staked[seat],
          points:
            seat === winner
              ? { handScore: 42, bondBonus: 12, revealCost: 0 }
              : { handScore: 12, bondBonus: 4, revealCost: 0 },
        }))
        emit('settled', { potWins: { [winner]: pot }, rows })
        // v2：冻结结算摘要（昵称/座位在结算时定格，下一手换人不影响上手获奖名单）
        lastResult = {
          handSeq,
          endedAt: Date.now(),
          endReason: hands.length > 1 ? 'showdown' : 'fold_win',
          seats: SEAT_IDS.map((seat) => ({
            seat,
            nick: nicks[seat],
            occupantKind: seat === 0 ? 'human' : 'bot',
          })),
          rows,
          potWins: { [winner]: pot },
          showdown: hands.length > 1 ? hands : [],
        }
        // 对账：筹码结构变化（破产重买）后广播全量快照
        rebuyBusted()
        snapshot(true)
        emitState('mutation', [
          ev('showdown', null),
          ev('settled', winner, { pot: pot, endReason: lastResult.endReason }),
        ])
        scheduleNextHand()
      }, 1200)
    }, 800)
  }

  /** 破产重买：就地重买计入 rebuys；达上限自动离席（bot 接管；真人由客户端回大厅） */
  const rebuyBusted = () => {
    for (const s of SEAT_IDS) {
      if (chips[s] > 0) continue
      if (rebuys[s] < MAX_REBUYS) {
        chips[s] = START_CHIPS
        rebuys[s]++
      } else if (s !== 0) {
        chips[s] = START_CHIPS
        rebuys[s] = 0
        nicks[s] = '补位 bot'
      }
    }
  }

  /** 下一手排程：nextHand 广播 + 到点自动开局（active ≥ 2）；全员 ready 可提前 */
  const scheduleNextHand = () => {
    nextHandAt = Date.now() + NEXT_HAND_DELAY_MS
    emit('nextHand', { startAt: nextHandAt })
    emitState('mutation', [ev('next_hand_scheduled', null, { startAt: nextHandAt })])
    later(() => {
      if (phase === 'settled') startHand()
    }, NEXT_HAND_DELAY_MS)
  }

  // ===== 上行处理 =====

  /** ready：waiting/settled 收下并广播 readied；全员 ready 提前开局（局中忽略） */
  const onReady = () => {
    if (phase === 'playing') {
      rejectPending('not_waiting')
      return
    }
    ready[0] = true
    emit('readied', { seat: 0 })
    emitState('mutation', [ev('readied', 0)])
    if (phase === 'waiting' && ready.every(Boolean)) {
      startHand()
      return
    }
    if (phase !== 'settled') return
    // 「立即开始」：bot 随即准备，凑满全员 ready 提前开局
    for (const seat of [1, 2, 3]) {
      later(() => {
        if (phase !== 'settled') return
        ready[seat] = true
        emit('readied', { seat })
        emitState('mutation', [ev('readied', seat)])
      }, 200 * seat)
    }
    later(() => {
      if (phase === 'settled' && ready.every(Boolean)) startHand()
    }, 700)
  }

  const onAction = (type: ActionType, amount: number) => {
    if (phase !== 'playing') {
      rejectPending('not_playing')
      return
    }
    if (turnSeat !== 0) {
      rejectPending('not_your_turn')
      emit('error', { code: 'not_your_turn', msg: '还没轮到你' })
      return
    }
    const toCall = Math.max(0, currentBet - bets[0])
    if (type === 'check' && toCall > 0) {
      rejectPending('illegal_check')
      emit('error', { code: 'illegal_check', msg: `需跟注 ${toCall} 才能过牌` })
      return
    }
    if (type === 'bet' || type === 'raise') {
      // amount = 「加到」的目标：≥ currentBet + minRaise（全下豁免）
      const minTarget = currentBet + minRaise
      if (amount < minTarget && amount < chips[0]) {
        rejectPending('illegal_raise')
        emit('error', { code: 'illegal_raise', msg: `目标需至少加到 ${minTarget}（全下豁免）` })
        return
      }
    }
    commitAction(0, type, amount)
  }

  const onReveal = (cardId: number, scope: RevealScope) => {
    const mine = HOLE_CARDS[0].some((c) => c.id === cardId)
    const isCommunity = [...FLOP, ...TURN, ...RIVER].some((c) => c.id === cardId)
    if (!mine && !isCommunity) {
      // 对手底牌不可揭示（D2）
      emit('error', { code: 'reveal_forbidden', msg: '对手底牌不可揭示，摊牌才亮（D2）' })
      return
    }
    // 公共牌只能当众；自己的牌可私看（private）也可「亮一只」当众（public）
    const effScope: RevealScope = isCommunity ? 'public' : scope
    const all = [...HOLE_CARDS[0], ...FLOP, ...TURN, ...RIVER]
    const card = all.find((c) => c.id === cardId)
    if (!card) return
    emit('revealed', {
      seat: 0,
      cardId,
      scope: effScope,
      // v1 成本策略 ZeroPolicy：恒 0，账照记（D4）
      cost: 0,
      elements: withElements(card).elements,
    })
    if (isCommunity && scope !== 'public') {
      emit('error', { code: 'reveal_scope_fixed', msg: '公共牌只能当众翻开，已按 public 执行' })
    }
  }

  // 表情冷却账本（10 秒/座位，与服务端同规则）
  const emoteAt: Record<number, number> = {}
  const EMOTE_KEYS: EmoteKey[] = ['clap', 'smile', 'wow', 'think', 'cry', 'angry', 'sweat', 'love']
  const EMOTE_COOLDOWN_MS = 10000

  const onEmote = (key: string) => {
    const now = Date.now()
    if (!EMOTE_KEYS.includes(key as EmoteKey)) {
      emit('error', { code: 'emote_failed', msg: '表情键不在白名单' })
      return
    }
    if (now - (emoteAt[0] ?? 0) < EMOTE_COOLDOWN_MS) {
      emit('error', { code: 'emote_failed', msg: '表情冷却中，请稍候' })
      return
    }
    emoteAt[0] = now
    emit('emoted', { seat: 0, key })
  }

  // 聊天（say/said）：房主开关 + 长度校验（客户端另有节流，服务端同限兜底）
  const onSay = (text: string) => {
    if (opts.chatEnabled === false) {
      emit('error', { code: 'chat_disabled', msg: '房主已关闭聊天' })
      return
    }
    const body = text.trim()
    if (!body) return
    if (body.length > CHAT_MAX_LEN) {
      emit('error', { code: 'chat_too_long', msg: `消息长度上限 ${CHAT_MAX_LEN} 字` })
      return
    }
    emit('said', { seat: 0, text: body })
    // 假陪聊：bot 应一句，演示对话流
    later(() => emit('said', { seat: 1, text: '收到，这手我跟。' }), 1200)
  }

  /** 带 requestId 的命令：先登记 applied 回执，由本次提交帧带回；未产生变更则回 rejected */
  const withReceipt = (requestId: string | undefined, fn: () => void) => {
    if (!requestId) {
      fn()
      return
    }
    pendingReceipt = { requestId, status: 'applied', appliedRevision: revision + 1, code: null }
    fn()
    rejectPending('not_applicable')
  }

  const handle = (msg: ClientMessage) => {
    switch (msg.t) {
      case 'ready':
        withReceipt(msg.p.requestId, onReady)
        return
      case 'action':
        withReceipt(msg.p.requestId, () => onAction(msg.p.type, msg.p.amount ?? 0))
        return
      case 'reveal':
        onReveal(msg.p.cardId, msg.p.scope)
        return
      case 'emote':
        onEmote(msg.p.key)
        return
      case 'say':
        onSay(msg.p.text)
        return
      case 'resync':
        snapshot(true)
        emitState('resync')
        return
      case 'leave':
        close()
        return
      default:
        return // join / ping：mock 直接忽略（快照在 ready 前已发）
    }
  }

  function close() {
    closed = true
    for (const t of timers) window.clearTimeout(t)
  }

  // 进桌即得全量快照（对应服务端「加入时下发」）；bot 落座即已准备
  later(() => {
    snapshot(true)
    for (const seat of [1, 2, 3]) {
      ready[seat] = true
      emit('readied', { seat })
    }
    // v2：进桌后的首个权威帧（含 bot 已准备状态），客户端据此离开「同步中」
    emitState('join')
  }, 250)

  return { send: handle, close }
}

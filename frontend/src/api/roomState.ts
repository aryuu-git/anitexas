/**
 * 对局桌面状态归约：把 WS 下行事件（architecture.md §5）归约成渲染态。
 *
 * 纯函数、无副作用；RoomPage 只负责把信封喂进来。
 * 隐藏数据纪律（D7）：未揭示牌对象没有 elements 字段，这里不做任何臆造/补默认值。
 */
import type {
  BoxCard,
  CardData,
  EmoteKey,
  Envelope,
  Phase,
  PoolInfo,
  RevealRecord,
  SeatState,
  SettledPayload,
  ShowdownHand,
} from './types'
import { DEFAULT_TURN_MS } from './types'

/** 表情气泡展示态（seat → 最近一次表情） */
export interface EmoteTick {
  key: EmoteKey
  /** 上屏时刻（epoch ms，气泡 4s 后自隐） */
  at: number
}

/** 聊天消息展示态（房内滚动账本，客户端本地保留） */
export interface ChatTick {
  seat: number
  text: string
  /** 上屏时刻（epoch ms） */
  at: number
}

/** 聊天账本上限（防无界增长；超出丢最旧） */
const CHAT_LOG_LIMIT = 50

/** 桌面渲染态 */
export interface RoomState {
  roomCode: string
  /** 开局自动展开要素（D14） */
  autoReveal: boolean
  phase: Phase
  handSeq: number
  seats: SeatState[]
  mySeat: number
  myCards: CardData[]
  community: CardData[]
  pot: number
  currentBet: number
  turnSeat: number
  /** 行动倒计时截止时刻（epoch ms；null=无倒计时） */
  deadline: number | null
  smallBlind: number
  bigBlind: number
  revealRate: number
  reveals: RevealRecord[]
  /** 座位表情气泡（seat → 最近一次） */
  emotes: Record<number, EmoteTick>
  /** 聊天账本（客户端本地保留，快照替换不丢） */
  chat: ChatTick[]
  /** 房主是否开放聊天（roomConfig.chatEnabled） */
  chatEnabled: boolean
  /** 本手发牌固证（SHA-256(seed) hex；null = 未收到） */
  seedCommit: string | null
  /** 摊牌揭示的种子（null = 未到摊牌） */
  seedReveal: string | null
  showdown: ShowdownHand[] | null
  settled: SettledPayload | null
  /** 最近一条非法动作回执（展示 5s 后由 UI 自动清） */
  lastError: string | null
  /** 事件序号基线：丢弃 seq ≤ 基线的在途旧事件（snapshot 全量采纳并推进基线） */
  seq: number
  /** 当前最小加注增量：raise 的 target 须 ≥ currentBet + minRaise（全下豁免） */
  minRaise: number
  /** 本桌行动时限（毫秒，snapshot.turnMs） */
  turnMs: number
  /** 本手盒名单（D17 公开名单，要素仍隐藏） */
  box: BoxCard[]
  /** 本桌牌池摘要（null = 未收到快照） */
  pool: PoolInfo | null
  /** 下一手自动开局时刻（epoch ms，nextHand 排程；null = 未排程） */
  nextHandAt: number | null
}

/** 初始态（连接建立前的空桌） */
export function createRoomState(): RoomState {
  return {
    roomCode: '',
    autoReveal: false,
    phase: 'waiting',
    handSeq: 0,
    seats: [],
    mySeat: -1,
    myCards: [],
    community: [],
    pot: 0,
    currentBet: 0,
    turnSeat: -1,
    deadline: null,
    smallBlind: 1,
    bigBlind: 2,
    revealRate: 0,
    reveals: [],
    emotes: {},
    chat: [],
    chatEnabled: true,
    seedCommit: null,
    seedReveal: null,
    showdown: null,
    settled: null,
    lastError: null,
    seq: 0,
    minRaise: 0,
    turnMs: DEFAULT_TURN_MS,
    box: [],
    pool: null,
    nextHandAt: null,
  }
}

/** 德州固定两张底牌：他人只收「已发 N 张」占位（D7，不下发牌对象） */
const HOLE_CARDS_PER_SEAT = 2

/**
 * 事件归约入口。乱序旧事件按 seq 基线过滤（snapshot 例外：全量真源，始终采纳并推进基线）；
 * 服务端扩展字段（turnSeat/deadline/minRaise）存在时以服务端为权威，缺省按座位轮转推算。
 */
export function applyEvent(state: RoomState, env: Envelope): RoomState {
  // 丢弃 seq ≤ 基线的在途旧事件（含快照后才补到的乱序事件，消 R4 时序伪影）
  if (env.t !== 'snapshot' && typeof env.seq === 'number' && env.seq <= state.seq) return state
  const next = reduceEvent(state, env)
  if (env.t === 'snapshot' || typeof env.seq !== 'number') return next
  return { ...next, seq: Math.max(next.seq, env.seq) }
}

/** 归约一步（seq 过滤与基线推进由 applyEvent 统一处理） */
function reduceEvent(state: RoomState, env: Envelope): RoomState {
  switch (env.t) {
    case 'snapshot': {
      const p = env.p as SnapshotLike
      // 快照是全量真源，直接替换渲染态；聊天账本是本地展示历史，不随快照清空。
      // 同一手的快照不清结算态（重连不关结算面板）；换手快照按新一手清空（防上一手残留）。
      const sameHand = state.handSeq > 0 && p.handSeq === state.handSeq
      return {
        roomCode: p.roomCode,
        autoReveal: p.autoReveal,
        phase: p.phase,
        handSeq: p.handSeq,
        seats: (p.seats ?? []).map((s) => ({ ...s, ready: s.ready ?? false, rebuys: s.rebuys ?? 0 })),
        mySeat: p.mySeat,
        myCards: p.myCards ?? [],
        community: p.community ?? [],
        pot: p.pot,
        currentBet: p.currentBet,
        turnSeat: p.turnSeat,
        deadline: p.deadline ?? null,
        smallBlind: p.smallBlind,
        bigBlind: p.bigBlind,
        revealRate: p.revealRate,
        reveals: p.reveals ?? [],
        emotes: {},
        chat: state.chat,
        chatEnabled: p.chatEnabled ?? true,
        seedCommit: p.seedCommit ?? null,
        // seed 是「当前手 seed（摊牌后可见）」，缺省沿用现值（旧版服务端兼容）
        seedReveal: p.seed !== undefined ? p.seed : state.seedReveal,
        showdown: sameHand ? state.showdown : null,
        settled: sameHand ? state.settled : null,
        lastError: null,
        seq: Math.max(state.seq, p.seq ?? 0),
        minRaise: p.minRaise ?? state.minRaise,
        turnMs: p.turnMs ?? DEFAULT_TURN_MS,
        box: p.box ?? [],
        pool: p.pool ?? null,
        nextHandAt: sameHand ? state.nextHandAt : null,
      }
    }
    case 'dealt': {
      const p = env.p as { seat: number; cards: CardData[] }
      if (p.seat === state.mySeat && p.cards.length > 0) {
        // 按 id 去重合并：快照已含底牌时重发 dealt 不重复追加（A4.3 快照恢复场景）
        const known = new Set(state.myCards.map((c) => c.id))
        return { ...state, myCards: [...state.myCards, ...p.cards.filter((c) => !known.has(c.id))] }
      }
      // 他人底牌只到「已发 2 张」占位
      return {
        ...state,
        seats: state.seats.map((s) =>
          s.seat === p.seat ? { ...s, holeCount: HOLE_CARDS_PER_SEAT } : s,
        ),
      }
    }
    case 'flop':
    case 'turn':
    case 'river': {
      const p = env.p as {
        cards: CardData[]
        turnSeat?: number
        deadline?: number | null
        minRaise?: number
      }
      return {
        ...state,
        phase: env.t as Phase, // flop|turn|river 与 Phase 同名
        community: [...state.community, ...p.cards],
        pot: state.pot, // 底池在 acted 里累计
        turnSeat: p.turnSeat ?? state.turnSeat,
        deadline: p.deadline !== undefined ? p.deadline : state.deadline,
        minRaise: p.minRaise ?? state.minRaise,
      }
    }
    case 'acted': {
      const p = env.p as {
        seat: number
        type: string
        amount: number
        turnSeat?: number
        deadline?: number | null
        minRaise?: number
      }
      const seats = state.seats.map((s) => {
        if (s.seat !== p.seat) return s
        if (p.type === 'fold') return { ...s, folded: true, acted: true }
        return {
          ...s,
          chips: Math.max(0, s.chips - p.amount),
          bet: s.bet + p.amount,
          acted: true,
        }
      })
      return {
        ...state,
        seats,
        pot: state.pot + p.amount,
        currentBet: Math.max(state.currentBet, seats.find((s) => s.seat === p.seat)?.bet ?? 0),
        turnSeat: p.turnSeat ?? nextTurn(seats, p.seat),
        deadline: p.deadline !== undefined ? p.deadline : state.deadline,
        minRaise: p.minRaise ?? state.minRaise,
      }
    }
    case 'revealed': {
      const p = env.p as {
        seat: number
        cardId: number
        scope: 'private' | 'public'
        cost: number
        elements: CardData['elements']
      }
      const reveals = [
        ...state.reveals.filter((r) => !(r.seat === p.seat && r.cardId === p.cardId)),
        { seat: p.seat, cardId: p.cardId, scope: p.scope, cost: p.cost },
      ]
      // 揭示后的要素回填到对应牌对象（此后 elements 字段才出现）
      return {
        ...state,
        reveals,
        myCards: state.myCards.map((c) =>
          c.id === p.cardId ? { ...c, elements: p.elements ?? [] } : c,
        ),
        community: state.community.map((c) =>
          c.id === p.cardId ? { ...c, elements: p.elements ?? [] } : c,
        ),
      }
    }
    case 'emoted': {
      const p = env.p as { seat: number; key: EmoteKey }
      return {
        ...state,
        emotes: { ...state.emotes, [p.seat]: { key: p.key, at: Date.now() } },
      }
    }
    case 'said': {
      const p = env.p as { seat: number; text: string }
      const chat = [...state.chat, { seat: p.seat, text: p.text, at: Date.now() }]
      return { ...state, chat: chat.slice(-CHAT_LOG_LIMIT) }
    }
    case 'seedCommit': {
      // 新一手固证到达即重置上一手的揭示种子（验证状态跨手不残留）
      const p = env.p as { sha256: string }
      return { ...state, seedCommit: p.sha256, seedReveal: null }
    }
    case 'seedReveal': {
      const p = env.p as { seed: string }
      return { ...state, seedReveal: p.seed }
    }
    case 'showdown': {
      const p = env.p as { hands: ShowdownHand[] }
      return { ...state, phase: 'showdown', showdown: p.hands, turnSeat: -1, deadline: null }
    }
    case 'settled': {
      const p = env.p as SettledPayload
      return { ...state, phase: 'settled', settled: p, turnSeat: -1, deadline: null }
    }
    case 'readied': {
      // 准备广播：waiting 态座位标记展示（每手由服务端重置）
      const p = env.p as { seat: number }
      return {
        ...state,
        seats: state.seats.map((s) => (s.seat === p.seat ? { ...s, ready: true } : s)),
      }
    }
    case 'nextHand': {
      // 下一手自动开局时刻（全员 ready 可提前）
      const p = env.p as { startAt: number }
      return { ...state, nextHandAt: p.startAt }
    }
    case 'error': {
      const p = env.p as { code: string; msg: string }
      return { ...state, lastError: p.msg }
    }
    default:
      return state
  }
}

/** snapshot 载荷直换成渲染态（快照是全量真源，不做增量合并） */
interface SnapshotLike {
  roomCode: string
  autoReveal: boolean
  phase: Phase
  handSeq: number
  seats: SeatState[]
  mySeat: number
  myCards: CardData[]
  community: CardData[]
  pot: number
  currentBet: number
  turnSeat: number
  deadline: number | null
  smallBlind: number
  bigBlind: number
  revealRate: number
  reveals: RevealRecord[]
  chatEnabled?: boolean
  seedCommit?: string | null
  /** 快照基线序号（缺省不推进基线，旧版服务端兼容） */
  seq?: number
  minRaise?: number
  turnMs?: number
  /** 当前手 seed（摊牌后可见；undefined = 载荷未带，沿用现值） */
  seed?: string | null
  box?: BoxCard[]
  pool?: PoolInfo | null
}

/**
 * 座位轮转推算（服务端未下发 turnSeat 时的回退）：
 * 从当前行动者之后找下一个未弃牌、有筹码的座位。
 */
function nextTurn(seats: SeatState[], from: number): number {
  if (seats.length === 0) return -1
  const ordered = [...seats].sort((a, b) => a.seat - b.seat)
  for (let i = 1; i <= ordered.length; i++) {
    const s = ordered[(ordered.findIndex((x) => x.seat === from) + i) % ordered.length]
    if (!s.folded && s.chips > 0) return s.seat
  }
  return -1
}

/** 清空 lastError 提示（展示寿命到点由 UI 自动清，见 hooks/useAutoExpire；无提示时原样返回） */
export function clearError(state: RoomState): RoomState {
  return state.lastError === null ? state : { ...state, lastError: null }
}

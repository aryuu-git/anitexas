/**
 * 体验视图模型（docs/experience-handoff/02-state-contract.md §5）。
 *
 * 纯函数：输入权威状态、连接/身份会话与本地待确认命令，输出页面只消费的字段。
 * 控件不得自行从 seats 长度、chips=0 或昵称前缀推断准备度、全下或机器人。
 */
import type { ActionType, HandResult, Phase, SeatState } from './types'
import type { RoomState } from './roomState'

export type Screen = 'join' | 'syncing' | 'waitingRoom' | 'table' | 'removed' | 'closed'

export type ActionMode =
  | 'none'
  | 'ready'
  | 'confirming'
  | 'verifying'
  | 'myTurn'
  | 'waitingTurn'
  | 'folded'
  | 'allIn'
  | 'waitingNextHand'
  | 'settled'

export type StepStatus = 'done' | 'current' | 'pending' | 'skipped'

export interface PhaseStep {
  key: Phase
  label: string
  detail: string
  status: StepStatus
}

export interface ResultSummary {
  handSeq: number
  endReason: 'showdown' | 'fold_win'
  chipsDelta: number
  pointsDelta: number
  wonChips: number
  /** 实际获奖座位（potWins 合计，不把排序首位强行标唯一赢家） */
  winnerSeats: number[]
}

export interface ExperienceView {
  screen: Screen
  phaseSteps: PhaseStep[]
  statusTitle: string
  statusDetail: string
  nextHint: string
  actionMode: ActionMode
  /** 服务端合法动作（控件唯一依据） */
  actions: ActionType[]
  blockedReason: string | null
  /** 阻塞开局的真人昵称 */
  waitingNames: string[]
  resultSummary: ResultSummary | null
  /** 本人是否已准备（准备室按钮态） */
  myReady: boolean
  /** 准备室文案：真人已准备 X/Y */
  readyProgress: string
  /** 本人是否参与本手 */
  inHand: boolean
  /** 淘汰/离席说明 */
  removalNotice: string | null
}

/** 派生输入：连接是否已收到权威帧、是否已有房间身份 */
export interface ExperienceSession {
  live: boolean
  hasIdentity: boolean
  /** 本地下注/准备命令确认态 */
  pending?: { type: ActionType | 'ready' | 'leave'; verifying: boolean } | null
}

const BETTING_PHASES: Phase[] = ['preflop', 'flop', 'turn', 'river']

const PHASE_META: Record<'preflop' | 'flop' | 'turn' | 'river', { label: string; detail: string; hint: string }> = {
  preflop: {
    label: '第 1 轮 · 底牌下注',
    detail: '你有 2 张底牌，公共牌尚未翻开',
    hint: '本轮结束后翻开 3 张公共牌',
  },
  flop: {
    label: '第 2 轮 · 翻牌',
    detail: '已翻开 3/5 张公共牌',
    hint: '本轮结束后翻开第 4 张',
  },
  turn: {
    label: '第 3 轮 · 转牌',
    detail: '已翻开 4/5 张公共牌',
    hint: '本轮结束后翻开最后一张',
  },
  river: {
    label: '第 4 轮 · 河牌',
    detail: '5 张公共牌已全部翻开',
    hint: '本轮结束后比较牌型',
  },
}

/** 阶段顺序索引（waiting/showdown/settled 不在下注链上） */
function phaseIndex(phase: Phase): number {
  const i = BETTING_PHASES.indexOf(phase)
  return i < 0 ? -1 : i
}

/** 本手实际到达的最高街（fold_win 提前结束时用于标「跳过」） */
function reachedIndex(state: RoomState): number {
  const idx = phaseIndex(state.phase)
  if (idx >= 0) return idx
  if (state.phase === 'showdown' || state.phase === 'settled') {
    // 主动摊牌/结算：以公共牌张数判断实际走过的街
    return Math.max(0, Math.min(3, state.community.length >= 5 ? 3 : state.community.length >= 4 ? 2 : state.community.length >= 3 ? 1 : 0))
  }
  return -1
}

function buildPhaseSteps(state: RoomState): PhaseStep[] {
  const keys = BETTING_PHASES as ('preflop' | 'flop' | 'turn' | 'river')[]
  const current = phaseIndex(state.phase)
  const reached = reachedIndex(state)
  const terminal = state.phase === 'showdown' || state.phase === 'settled'
  const noBetting = terminal && state.lastResult?.endReason === 'fold_win'
  return keys.map((key, i) => {
    const meta = PHASE_META[key]
    let status: StepStatus = 'pending'
    if (state.phase === 'waiting') status = 'pending'
    else if (noBetting) status = i <= reached ? 'done' : 'skipped'
    else if (terminal) status = 'done'
    else if (state.runout) status = 'done' // 全下直发：不再有下注轮，四轮连续发完
    else if (i < current) status = 'done'
    else if (i === current) status = 'current'
    else status = 'pending'
    return { key, label: meta.label, detail: meta.detail, status }
  })
}

/** 结算摘要：本人净变化优先，获奖按 potWins 合计 */
export function summarizeResult(result: HandResult | null, mySeat: number): ResultSummary | null {
  if (!result) return null
  const row = result.rows.find((r) => r.seat === mySeat)
  const winnerSeats = Object.entries(result.potWins ?? {})
    .filter(([, v]) => Number(v) > 0)
    .map(([k]) => Number(k))
  return {
    handSeq: result.handSeq,
    endReason: result.endReason,
    chipsDelta: row?.chipsDelta ?? 0,
    pointsDelta: row ? row.points.handScore + row.points.bondBonus - row.points.revealCost : 0,
    wonChips: row ? result.potWins?.[mySeat] ?? 0 : 0,
    winnerSeats,
  }
}

function seatOf(state: RoomState, seat: number): SeatState | undefined {
  return state.seats.find((s) => s.seat === seat)
}

function isMyTurn(state: RoomState): boolean {
  return BETTING_PHASES.includes(state.phase) && state.mySeat >= 0 && state.turnSeat === state.mySeat
}

/**
 * 主派生函数。判定优先级（文档 §5）：
 * closed/removed → 未同步 → 准备室 → settled → 不参与本手 → folded → allIn → 本人行动 → 等待别人。
 */
export function deriveExperienceState(state: RoomState, session: ExperienceSession): ExperienceView {
  const me = seatOf(state, state.mySeat)
  const myReady = me?.ready ?? false
  const participationInHand = state.participation === 'in_hand'
  const legal = state.legalActions
  const readyInfo = readinessText(state)
  const phaseSteps = buildPhaseSteps(state)

  let screen: Screen = 'table'
  if (state.roomStatus === 'closed' || state.viewerStatus === 'removed') {
    screen = state.roomStatus === 'closed' ? 'closed' : 'removed'
  } else if (!session.live) {
    screen = session.hasIdentity ? 'syncing' : 'join'
  } else if (state.phase === 'waiting' && state.handSeq === 0) {
    screen = 'waitingRoom'
  }

  // 阶段文案
  let statusTitle = ''
  let statusDetail = ''
  let nextHint = ''
  if (state.phase === 'waiting') {
    statusTitle = state.handSeq === 0 ? '等待开局' : '本手结束'
    statusDetail =
      state.handSeq === 0
        ? '真人准备后自动补齐机器人并发牌'
        : state.lastResult?.endReason === 'fold_win'
          ? '其他玩家弃牌，本手提前结束'
          : '牌型比较完成，等待下一手'
    nextHint =
      state.nextHandPolicy === 'automatic' && state.nextHandAt != null
        ? '下一手将按排程自动开始'
        : '全体真人准备后开始下一手'
  } else if (state.phase === 'showdown') {
    statusTitle = '正在比较牌型'
    statusDetail = '系统选择最佳五张'
    nextHint = '等待结算结果'
  } else if (state.phase === 'settled') {
    statusTitle = '本手结束'
    statusDetail = state.lastResult?.endReason === 'fold_win' ? '其他玩家弃牌，提前收池' : '摊牌与账本已结算'
    nextHint =
      state.nextHandPolicy === 'automatic' && state.nextHandAt != null
        ? '下一手将按排程自动开始'
        : '全体真人准备后开始下一手'
  } else {
    const meta = PHASE_META[state.phase as 'preflop' | 'flop' | 'turn' | 'river']
    statusTitle = `${meta.label} · 第 ${state.handSeq} 手`
    statusDetail = state.runout ? '全下发牌：本手不再有下注轮' : meta.detail
    nextHint = state.runout ? '等待发完公共牌并结算' : meta.hint
  }

  // 动作模式
  let actionMode: ActionMode = 'none'
  let blockedReason: string | null = null
  if (screen === 'closed') {
    blockedReason = '房间已关闭'
  } else if (screen === 'removed') {
    blockedReason = removalText(state.removalReason)
  } else if (!session.live) {
    blockedReason = session.hasIdentity ? '正在同步牌桌' : '尚未加入房间'
  } else if (session.pending) {
    actionMode = session.pending.verifying ? 'verifying' : 'confirming'
    blockedReason = session.pending.verifying ? '正在核对操作结果' : '操作确认中'
  } else if (screen === 'waitingRoom') {
    actionMode = myReady ? 'waitingNextHand' : 'ready'
    blockedReason = myReady ? '已准备，等待其他真人' : null
  } else if (state.phase === 'settled' || state.phase === 'waiting' || state.phase === 'showdown') {
    actionMode = 'settled'
  } else if (!participationInHand) {
    actionMode = 'waitingNextHand'
    blockedReason = '本手未参与，等待下一手'
  } else if (me?.folded) {
    actionMode = 'folded'
    blockedReason = '你已弃牌，等待本手结算'
  } else if (me?.allIn) {
    actionMode = 'allIn'
    blockedReason = '你已全下，无需再下注'
  } else if (isMyTurn(state) && legal.length > 0) {
    actionMode = 'myTurn'
  } else {
    actionMode = 'waitingTurn'
    blockedReason = waitingReason(state, legal.length)
  }

  const resultSummary = summarizeResult(state.lastResult, state.mySeat)
  const waitingNames = state.readiness.blockers
    .map((b) => seatOf(state, b.seat))
    .filter((s): s is SeatState => !!s)
    .map((s) => s.nick)

  return {
    screen,
    phaseSteps,
    statusTitle,
    statusDetail,
    nextHint,
    actionMode,
    actions: legal,
    blockedReason,
    waitingNames,
    resultSummary,
    myReady,
    readyProgress: readyInfo,
    inHand: participationInHand,
    removalNotice:
      state.viewerStatus === 'removed' ? `${removalText(state.removalReason)}，可返回首页重新加入。` : null,
  }
}

function waitingReason(state: RoomState, legalCount: number): string | null {
  if (legalCount > 0) return null
  if (state.runout) return '全下发牌中，等待公共牌发完'
  if (state.turnSeat < 0) {
    return state.phase === 'showdown' || state.phase === 'settled' ? '等待结算' : '等待服务端推进牌局'
  }
  const nick = seatOf(state, state.turnSeat)?.nick
  return nick ? `等待 ${nick} 行动` : '等待其他玩家'
}

function readinessText(state: RoomState): string {
  const eligible = state.readiness.eligibleSeats.length
  const ready = state.readiness.readySeats.length
  if (eligible === 0) return '还没有其他真人，准备后自动补齐机器人'
  return `真人已准备 ${ready}/${eligible}`
}

export function removalText(reason: string | null | undefined): string {
  switch (reason) {
    case 'rebuy_limit':
      return '重买次数已用尽，已自动离席'
    case 'expired':
      return '长时间未操作，座位已回收'
    case 'left':
      return '你已离开本桌'
    default:
      return '已离开本桌'
  }
}

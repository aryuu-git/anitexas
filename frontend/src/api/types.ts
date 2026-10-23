/**
 * WS 协议类型（与 architecture.md §5 协议草案逐字对齐，与后端 model 对齐）。
 *
 * 信封：{ t: 类型, seq: 递增序号, p: 载荷 }。seq 供客户端丢弃乱序旧事件。
 * 隐藏字段规则（D7 安全基线）：牌对象 elements 字段仅在揭示后出现——
 * hidden 模式下未揭示牌对象**没有 elements 字段**，前端不得臆造默认值。
 */

// ===== 领域模型（与 backend/internal/engine 对齐）=====

/** 要素：Class 1监督 2公司 3标签 4年份 5原作类型 */
export interface Element {
  class: number
  value: string
}

/** 要素类名（1–5，与规则书 §3 一致） */
export const ELEMENT_CLASS_NAMES: Record<number, string> = {
  1: '监督',
  2: '公司',
  3: '标签',
  4: '年份',
  5: '原作类型',
}

/** 牌面对象（L1 恒公开；elements 仅揭示后出现） */
export interface CardData {
  id: number
  title: string
  score: number
  bucket: number
  year: number
  /** 作品首字（生成封面用，D10） */
  monogram: string
  /** 仅在揭示后出现；未揭示牌对象没有此字段（D7） */
  elements?: Element[]
}

/** 牌型级数语义：10 黄金世代 9 命运共同体 8 四大名作 7 合奏 6 年代物语
 *  5 三部曲物语 4 三连星 3 四手联弹 2 二重唱 1 独奏 */
export const TIER_NAMES: Record<number, string> = {
  1: '独奏',
  2: '二重唱',
  3: '四手联弹',
  4: '三连星',
  5: '三部曲物语',
  6: '年代物语',
  7: '合奏',
  8: '四大名作',
  9: '命运共同体',
  10: '黄金世代',
}

/** 揭示范围：private 仅自己 / public 全桌广播（§1.3） */
export type RevealScope = 'private' | 'public'

/** 下注动作类型（§5 上行 action） */
export type ActionType = 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'allin'

/** 表情键（服务端白名单 8 选 1，10 秒/座位冷却） */
export type EmoteKey = 'clap' | 'smile' | 'wow' | 'think' | 'cry' | 'angry' | 'sweat' | 'love'

/** 表情键 → 气泡字形 */
export const EMOTE_GLYPHS: Record<EmoteKey, string> = {
  clap: '👏',
  smile: '😄',
  wow: '😮',
  think: '🤔',
  cry: '😭',
  angry: '😤',
  sweat: '😅',
  love: '💗',
}

/** 表情键展示序（气泡栏） */
export const EMOTE_KEYS: EmoteKey[] = ['clap', 'smile', 'wow', 'think', 'cry', 'angry', 'sweat', 'love']

/** 对局阶段（state.go 生命周期） */
export type Phase = 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'settled'

/** 行动时限兜底（毫秒）：snapshot.turnMs 缺省时按 30s 计（旧版服务端兼容） */
export const DEFAULT_TURN_MS = 30000

// ===== 聊天（say/said，与 emote/emoted 同构）=====

/** 聊天消息上限（客户端截断，服务端同限校验） */
export const CHAT_MAX_LEN = 120

/** 客户端发送节流窗口（ms，简单防刷屏） */
export const CHAT_THROTTLE_MS = 1500

// ===== 可验证发牌（commit-reveal）=====

/** 固证哈希编码：seed UTF-8 字节的 SHA-256，hex 小写 */
export type SeedCommitHex = string

// ===== 主题牌池（D11：主题池 = 过滤后再分层）=====

/** 牌池策略：stratified 分层随机（默认）/ theme 主题池 */
export type DeckStrategy = 'stratified' | 'theme'

/** 主题过滤维：公司 / 年代 / 标签（对应要素类 2 / 4 / 3） */
export type ThemeKind = 'company' | 'year' | 'tag'

/** 主题过滤项（deckStrategy=theme 时必填） */
export interface ThemeFilter {
  kind: ThemeKind
  value: string
}

/** 主题维选项（建房表单展示序） */
export const THEME_KIND_OPTIONS: { kind: ThemeKind; label: string }[] = [
  { kind: 'company', label: '公司' },
  { kind: 'year', label: '年代' },
  { kind: 'tag', label: '标签' },
]

// ===== 下行载荷（§5 server → client）=====

/** 座位占用类型（v2：不由昵称前缀猜机器人） */
export type OccupantKind = 'empty' | 'human' | 'bot'
/** 连接状态（v2：bot/空座为 not_applicable） */
export type Connection = 'online' | 'offline' | 'not_applicable'

/** 座位公开状态 */
export interface SeatState {
  seat: number
  nick: string
  chips: number
  points: number
  /** 本轮已下注 */
  bet: number
  folded: boolean
  /** 是否已动作（本轮） */
  acted: boolean
  isDealer: boolean
  /** 底牌张数占位（他人只收「已发 N 张」） */
  holeCount: number
  /** 已准备（waiting 态各座位显示标记；每手重置） */
  ready: boolean
  /** 重买次数（破产就地重买累计，达 MAX_REBUYS 自动离席） */
  rebuys: number
  /** ===== v2 扩展 ===== */
  occupantKind?: OccupantKind
  connection?: Connection
  /** 本手是否已发到底牌（参与本手） */
  inHand?: boolean
  /** 本手已全下（不由 chips=0 推算） */
  allIn?: boolean
  /** 局内已请求离座、本手结束后生效 */
  pendingLeave?: boolean
}

/** 盒名单条目（D17：本手发牌盒公开名单；仅 L1 字段，不带 elements） */
export interface BoxCard {
  id: number
  title: string
  score: number
  bucket: number
  year: number
}

/** 牌池摘要（D11/D17）：策略 + 可选主题过滤 + 池大小 + 是否回退全库 */
export interface PoolInfo {
  strategy: DeckStrategy
  /** deckStrategy=theme 时的过滤项 */
  theme?: ThemeFilter | null
  poolSize: number
  /** 主题过滤过窄已回退全库（前端须房内显著提示） */
  fallback: boolean
}

/** snapshot：房间全量状态（加入、断线重连、快照修复时下发） */
export interface SnapshotPayload {
  roomCode: string
  /** 开局自动展开要素（D14）：true = 开局所有牌直接已揭示 */
  autoReveal: boolean
  phase: Phase
  handSeq: number
  seats: SeatState[]
  /** 自己的座位号 */
  mySeat: number
  /** 自己的底牌（含/不含 elements 由揭示状态决定） */
  myCards: CardData[]
  community: CardData[]
  pot: number
  currentBet: number
  /** 当前行动座位（-1 表示等待中） */
  turnSeat: number
  /** 行动倒计时截止时刻（epoch ms，null=无倒计时） */
  deadline: number | null
  /** 小盲/大盲 */
  smallBlind: number
  bigBlind: number
  /** 揭示费率（v1 = 0，D4） */
  revealRate: number
  /** 已揭示记录（供结算明细） */
  reveals: RevealRecord[]
  /** 房主是否开放聊天（roomConfig.chatEnabled；false 时输入框置灰） */
  chatEnabled?: boolean
  /** 本手发牌固证（seedCommit 的重复下发，快照恢复后仍可验证） */
  seedCommit?: SeedCommitHex | null
  /** 快照生成时最后事件序号基线：客户端丢弃 seq ≤ 该值的在途旧事件（消 R4 时序伪影） */
  seq: number
  /** 当前最小加注增量：raise 的 target 须 ≥ currentBet + minRaise（全下豁免） */
  minRaise: number
  /** 本桌行动时限（毫秒）：倒计时总长，替代前端硬编码 30s */
  turnMs: number
  /** 当前手 seed（摊牌后可见，之前 null）；与 seedCommit 并存，断线后仍可验证 */
  seed: string | null
  /** D17 本手盒名单（公开名单，要素仍隐藏，不带 elements） */
  box: BoxCard[]
  /** 本桌牌池摘要 */
  pool: PoolInfo
  /** ===== v2 权威状态扩展（protocolVersion=2）===== */
  /** 房间实例标识：重建同码房间也不同 */
  roomInstanceId?: string
  /** 房间可见状态版本（同一提交的多个接收者共享） */
  revision?: number
  /** 房间生命周期状态 */
  roomStatus?: RoomStatus
  /** 下一手自动开局时刻（epoch ms；null = 未排程） */
  nextHandAt?: number | null
  /** 服务端实际生效策略 */
  nextHandPolicy?: 'manual' | 'automatic'
  /** 阻塞本次开局的真人准备情况（服务端计算） */
  readiness?: Readiness
  /** 接收者状态：seated | removed */
  viewerStatus?: ViewerStatus
  /** 离席原因（未离席为 null） */
  removalReason?: RemovalReason | null
  /** 接收者参局状态 */
  participation?: Participation
  /** 服务端按规则给出的合法动作（非本人行动时为空） */
  legalActions?: ActionType[]
  /** 跟齐所需增量（可大于剩余筹码） */
  callAmount?: number
  /** 合法最小加注目标（不可加注为 null） */
  minRaiseTo?: number | null
  /** 本轮已下注 + 剩余筹码 */
  maxRaiseTo?: number
  /** 倒计时归零后的自动动作 */
  timeoutAction?: 'check' | 'fold' | null
  /** 本手已进入全下直发 */
  runout?: boolean
  /** 最近一手服务端结算摘要 */
  lastResult?: HandResult | null
  /** 按视角过滤的有限过程历史 */
  recentEvents?: ExperienceEvent[]

  /** ===== 第二轮房间策略（服务端派生）===== */
  roomKind?: RoomKind
  botPolicy?: BotPolicy
  targetHumanCount?: number
  hostSeat?: number
  isHost?: boolean
  canStart?: boolean
  startBlockedReason?: string
  humanCount?: number
  botCount?: number
}

/** ===== v2 状态帧与命令确认 ===== */

export type RoomStatus = 'waiting' | 'playing' | 'closed'
export type ViewerStatus = 'seated' | 'removed'
export type RemovalReason = 'left' | 'rebuy_limit' | 'expired'
export type Participation = 'in_hand' | 'waiting_next_hand' | 'not_started'
export type StateReason = 'join' | 'resync' | 'mutation'
export type NextHandPolicy = 'manual' | 'automatic'
export type RoomKind = 'friend' | 'practice'
export type BotPolicy = 'off' | 'fill'

/** 开局准备度（排除 bot/空座/明确离席者） */
export interface Readiness {
  eligibleSeats: number[]
  readySeats: number[]
  blockers: { seat: number; reason: 'unready' | 'offline' }[]
}

/** v2 过程事件：只用于文字历史、音效与动画，不参与权威归约 */
export interface ExperienceEvent {
  eventId: string
  handSeq: number
  phase: Phase
  kind: ExperienceEventKind
  seat: number | null
  occurredAt: number
  payload?: Record<string, unknown>
}

export type ExperienceEventKind =
  | 'blind_posted'
  | 'acted'
  | 'flop'
  | 'turn'
  | 'river'
  | 'showdown'
  | 'settled'
  | 'readied'
  | 'seat_changed'
  | 'rebuy'
  | 'next_hand_scheduled'
  | 'next_hand_cancelled'
  | 'revealed'
  | 'dealt'
  | 'seed_commit'
  | 'seed_reveal'
  | 'error'

/** 命令回执（只发给命令所属玩家） */
export interface CommandReceipt {
  requestId: string
  status: 'applied' | 'rejected' | 'unknown'
  appliedRevision?: number | null
  code?: string | null
}

/** 结算时冻结的参与者身份 */
export interface ResultSeat {
  seat: number
  nick: string
  occupantKind: OccupantKind
}

/** 最近一手的冻结结算摘要 */
export interface HandResult {
  handSeq: number
  endedAt: number
  endReason: 'showdown' | 'fold_win'
  seats: ResultSeat[]
  rows: SettleRow[]
  potWins: Record<number, number>
  showdown: ShowdownHand[]
}

/** v2 权威状态帧（WS 下行 t='state' 的载荷） */
export interface StateFrame {
  protocolVersion: number
  roomCode: string
  roomInstanceId: string
  revision: number
  serverNow: number
  reason: StateReason
  state: SnapshotPayload
  events: ExperienceEvent[]
  receipts: CommandReceipt[]
}

/** dealt：发牌（底牌只发给本人，他人只收到占位） */
export interface DealtPayload {
  seat: number
  cards: CardData[]
}

/** flop / turn / river：公共牌亮出 */
export interface CommunityPayload {
  cards: CardData[]
  /** 可选扩展：服务端权威下发「下一位行动者 / 倒计时截止时刻」；
   *  缺省时客户端按座位轮转自行推算（协议载荷最小集不变） */
  turnSeat?: number
  deadline?: number | null
  /** 换街后的最小加注增量（服务端权威，缺省沿用上一值） */
  minRaise?: number
}

/** acted：玩家动作回放 */
export interface ActedPayload {
  seat: number
  type: ActionType
  /** 动作支付的筹码增量（fold/check = 0；allin = 全部余量） */
  amount: number
  /** 可选扩展：同上，服务端权威覆盖客户端轮转推算 */
  turnSeat?: number
  deadline?: number | null
  /** 动作后的最小加注增量（服务端权威，缺省沿用上一值） */
  minRaise?: number
}

/** 揭示记录 */
export interface RevealRecord {
  seat: number
  cardId: number
  scope: RevealScope
  cost: number
}

/** revealed：揭示广播（含成本，供扣分记账展示） */
export interface RevealedPayload extends RevealRecord {
  /** 揭示出来的要素（此时才可见） */
  elements: Element[]
}

/** emoted：表情气泡广播 */
export interface EmotedPayload {
  seat: number
  key: EmoteKey
}

/** said：聊天广播（与 emoted 同构，seat 换成文本） */
export interface SaidPayload {
  seat: number
  text: string
}

/** seedCommit：开局发牌固证（种子承诺 = SHA-256(seed) hex 小写） */
export interface SeedCommitPayload {
  sha256: SeedCommitHex
}

/** seedReveal：摊牌揭种子（本地算 SHA-256 与固证比对即可验证发牌未被篡改） */
export interface SeedRevealPayload {
  seed: string
}

/** showdown：摊牌（此时一切解密） */
export interface ShowdownHand {
  seat: number
  cards: CardData[]
  /** 成组划分：每组是 cards 下标集合；散牌不在任何组 */
  groups: number[][]
  tier: number
  tiebreak: number[]
}

export interface ShowdownPayload {
  hands: ShowdownHand[]
}

/** settled：结算（积分明细含揭示成本行） */
export interface PointsDetail {
  /** 牌型积分 */
  handScore: number
  /** 羁绊加成 */
  bondBonus: number
  /** Σ揭示成本 */
  revealCost: number
}

export interface SettleRow {
  seat: number
  /** 筹码盈亏 */
  chipsDelta: number
  /** 积分明细（A5.4：含「揭示成本」行） */
  points: PointsDetail
}

export interface SettledPayload {
  rows: SettleRow[]
  /** 主/边池赢家：seat → 赢得筹码 */
  potWins: Record<number, number>
}

/** nextHand：下一手自动开局时刻（settled 后房间排程；全员 ready 可提前） */
export interface NextHandPayload {
  /** 自动开局时刻（epoch ms，与 snapshot.deadline 同口径） */
  startAt: number
}

/** readied：玩家准备广播（每手重置；waiting 态座位标记展示） */
export interface ReadiedPayload {
  seat: number
}

/** error：非法动作回执（不得回显隐藏数据，D7） */
export interface ErrorPayload {
  /** 错误码：含 rebuy_exhausted（重买次数用尽）、ticket_in_use（ticket 被活跃连接占用）等 */
  code: string
  msg: string
}

// ===== 上行载荷（§5 client → server）=====

/** v2 命令公共元数据：确认、去重与版本核对（全部可选，缺省走 v1 宽松语义） */
export interface CommandMeta {
  protocolVersion?: number
  roomInstanceId?: string
  requestId?: string
  expectedHandSeq?: number
  expectedRevision?: number
}

export type ClientMessage =
  | {
      t: 'join'
      p: {
        roomCode: string
        nick: string
        ticket: string
        protocolVersion?: number
        roomInstanceId?: string
      }
    }
  | { t: 'ready'; p: CommandMeta }
  | { t: 'cancelReady'; p: CommandMeta }
  | { t: 'start'; p: { targetHumanCount?: number } & CommandMeta }
  | { t: 'addBot'; p: { seat?: number } & CommandMeta }
  | { t: 'removeBot'; p: { seat: number } & CommandMeta }
  | { t: 'setTarget'; p: { targetHumanCount: number } & CommandMeta }
  | { t: 'nextHandPolicy'; p: { policy: NextHandPolicy } & CommandMeta }
  | { t: 'action'; p: { type: ActionType; amount?: number } & CommandMeta }
  | { t: 'reveal'; p: { cardId: number; scope: RevealScope } & CommandMeta }
  /** 快捷表情（服务端 10 秒/座位冷却，超限回 error{code:"emote_failed"}） */
  | { t: 'emote'; p: { key: EmoteKey } }
  /** 聊天上行（text ≤ CHAT_MAX_LEN；客户端节流 CHAT_THROTTLE_MS，服务端同限校验） */
  | { t: 'say'; p: { text: string } }
  | { t: 'leave'; p: CommandMeta }
  | { t: 'ping'; p: Record<string, never> }
  /** 断线重连后请求快照修复（可携带待核对 requestId） */
  | { t: 'resync'; p: { requestId?: string } }

// ===== 信封 =====

export interface Envelope<T = unknown> {
  t: string
  seq: number
  p: T
}

/** 下行消息类型联合（便于 useRoomSocket 分发） */
export type ServerEvent =
  | Envelope<StateFrame>
  | Envelope<SnapshotPayload>
  | Envelope<DealtPayload>
  | Envelope<CommunityPayload>
  | Envelope<ActedPayload>
  | Envelope<RevealedPayload>
  | Envelope<EmotedPayload>
  | Envelope<SaidPayload>
  | Envelope<SeedCommitPayload>
  | Envelope<SeedRevealPayload>
  | Envelope<ShowdownPayload>
  | Envelope<SettledPayload>
  | Envelope<NextHandPayload>
  | Envelope<ReadiedPayload>
  | Envelope<ErrorPayload>

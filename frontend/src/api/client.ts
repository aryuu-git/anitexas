/**
 * REST 管理面客户端（architecture.md §4.4；契约与 backend/internal/api 定稿一致）：
 *   POST /api/rooms              建房（body=房间配置）→ 201 {code,host,autoReveal,seats,smallBlind,bigBlind,revealRate,players}
 *   GET  /api/rooms              房间列表 → {rooms:[同上]}
 *   POST /api/rooms/{code}/join  入座（body={nick}）→ {ticket,seat,code,...}；ticket 一次性，喂 WS join
 *   GET  /api/cards/{id}         牌面 L1（永不含 elements，D7）
 *   GET  /api/health             健康检查 → {status:"ok"}
 * 全部 JSON；错误统一回 {code,msg}。
 */
import type { BotPolicy, NextHandPolicy, Phase, RoomKind, ThemeFilter } from './types'

/** 建房配置（可选项与后端 room.config JSON 对齐） */
export interface CreateRoomRequest {
  nick?: string
  /** 建房幂等键：响应丢失重试不会重复建房 */
  createRequestId?: string
  /** 开局自动展开要素（D14） */
  autoReveal?: boolean
  seats?: number
  smallBlind?: number
  bigBlind?: number
  chips?: number
  revealRate?: number
  deckStrategy?: string
  deckSize?: number
  /** 作品标注数（评分人数）下限：仅 >= 此值的作品入牌池；0/省略 = 不过滤 */
  minVotes?: number
  /** 主题过滤（deckStrategy=theme 时必填）：{kind: company|year|tag, value} */
  themeFilter?: ThemeFilter
  /** 房主是否开放聊天（默认 true） */
  chatEnabled?: boolean
  /** 房间类型：朋友房（默认）/ 练习房 */
  roomKind?: RoomKind
  /** 机器人策略：朋友房 off（默认）/ 练习房 fill */
  botPolicy?: BotPolicy
  /** 期望参局人数（2..seats）；不足时房主须明确调整或添加机器人 */
  targetHumanCount?: number
  /** 下一手策略：朋友房 manual（默认）/ 练习房可 automatic */
  nextHandPolicy?: NextHandPolicy
}

/** 房间概要（列表/建房/预览回执同构） */
export interface RoomSummary {
  code: string
  host: string
  /** 开局自动展开要素（D14） */
  autoReveal: boolean
  seats: number
  smallBlind: number
  bigBlind: number
  revealRate: number
  players: number
  /** ===== v2 预览扩展 ===== */
  /** 房间生命周期状态（waiting | playing | closed） */
  status?: 'waiting' | 'playing' | 'closed'
  phase?: Phase
  handSeq?: number
  humanCount?: number
  botCount?: number
  joinable?: boolean
  roomKind?: RoomKind
  botPolicy?: BotPolicy
  targetHumanCount?: number
  nextHandPolicy?: NextHandPolicy
  hostSeat?: number
}

/** 入座回执：ticket 一次性；resumeToken 用于刷新/重连恢复身份 */
export interface JoinResponse {
  ticket: string
  seat: number
  /** 房间概要（同建房回执） */
  room: RoomSummary
  participantId?: string
  resumeToken?: string
  roomInstanceId?: string
}

/** 入座请求（v2：凭据恢复 + 幂等 + 原子复核） */
export interface JoinRoomRequest {
  nick: string
  resumeToken?: string
  joinRequestId?: string
  roomInstanceId?: string
}

/** 牌面 L1（GET /api/cards/{id}；永不含 elements） */
export interface CardL1 {
  id: number
  title: string
  score: number
  bucket: number
  year: number
  monogram: string
}

/** 服务端错误体 */
export interface ApiErrorBody {
  code: string
  msg: string
}

/** REST 错误：携带服务端 {code,msg}，调用方按 code 分支 */
export class ApiClientError extends Error {
  readonly code: string

  constructor(body: ApiErrorBody) {
    super(body.msg)
    this.name = 'ApiClientError'
    this.code = body.code
  }
}

/** 部署基路径（vite base）：dev 为 '/'，子路径部署（/anitexas/）时自动带前缀 */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

/** 统一请求壳：非 2xx 解析 {code,msg} 抛 ApiClientError；path 以 /api 开头，自动挂到 BASE 下 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const err = (body ?? { code: 'http_error', msg: `HTTP ${res.status}` }) as Partial<ApiErrorBody>
    throw new ApiClientError({ code: err.code ?? 'http_error', msg: err.msg ?? `HTTP ${res.status}` })
  }
  return body as T
}

/** 建房：返回房间概要（含房间码） */
export function createRoom(req: CreateRoomRequest): Promise<RoomSummary> {
  return request<RoomSummary>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

/** 房间列表 */
export async function listRooms(): Promise<RoomSummary[]> {
  const body = await request<{ rooms: RoomSummary[] }>('/api/rooms')
  return body.rooms
}

/** 房间预览（GET /api/rooms/{code}）：无副作用，不占座、不发凭据 */
export function previewRoom(code: string): Promise<RoomSummary> {
  return request<RoomSummary>(`/api/rooms/${encodeURIComponent(code)}`)
}

/** 入座：拿一次性 ticket（WS join 握手用）；resumeToken 可恢复原身份 */
export function joinRoom(code: string, req: string | JoinRoomRequest): Promise<JoinResponse> {
  const body = typeof req === 'string' ? { nick: req } : req
  return request<JoinResponse>(`/api/rooms/${encodeURIComponent(code)}/join`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** 牌面 L1 信息（不含隐藏要素，D7） */
export function getCard(id: number): Promise<CardL1> {
  return request<CardL1>(`/api/cards/${id}`)
}

/** 健康检查 */
export function health(): Promise<{ status: string }> {
  return request<{ status: string }>('/api/health')
}

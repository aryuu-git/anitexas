import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ApiClientError,
  createRoom,
  joinRoom,
  listRooms,
  type RoomSummary,
} from '../api/client'
import type { DeckStrategy, ThemeFilter } from '../api/types'
import { loadNick, nickLength, saveNick, validateNick, NICK_MAX_CHARS } from '../api/nickname'
import { saveIdentity } from '../api/identity'
import { DeckStrategyField } from '../components/DeckStrategyField'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icons'
import { Panel, SectionHead } from '../components/ui/Panel'
import { JoinFlow } from '../features/lobby/JoinFlow'

/**
 * 大厅页（体验重构 T5）：昵称共用 + 内联建房/加入 + 统一加入预览 + 房间列表。
 *
 * - 昵称 trim 后 1–12 个 Unicode 字符，偏好存 localStorage；房间身份凭据不在这里。
 * - 建房配置 = 预设（新手体验/动画挑战）+ 高级设置；预设只改座位/盲注/展开方式。
 * - 加入先 GET 摘要再明确「入座」，成功后保存恢复凭据并带 ticket 进入准备室。
 * - 列表只做手动刷新与窗口焦点刷新，刷新失败保留上次成功结果。
 */

/** 离线演示开关：'1' 时大厅与对局桌都走 mock */
const USE_MOCK = import.meta.env.VITE_USE_MOCK === '1'

/** 建房配置（透传给对局桌，与 room.config JSON 对齐） */
export interface RoomConfig {
  nick: string
  /** 开局自动展开要素（D14）：true = 开局所有牌直接已揭示 */
  autoReveal: boolean
  smallBlind: number
  bigBlind: number
  seats: number
  revealRate: number
  /** 作品标注数（评分人数）下限：仅 >= 此值的作品入牌池；0 = 不过滤 */
  minVotes: number
  /** 牌池策略（D11）：分层随机（默认）/ 主题池 */
  deckStrategy: DeckStrategy
  /** 主题过滤（deckStrategy=theme 时生效） */
  themeFilter: ThemeFilter
  /** 房主是否开放聊天（默认 true） */
  chatEnabled: boolean
}

/** 路由 state：房间配置 + 入座回执（ticket 喂 WS join 握手） */
export interface RoomNavState extends RoomConfig {
  ticket?: string
  seat?: number
}

/** 建房预设：只控制座位、盲注与展开方式，其余高级项保留当前值 */
interface RoomPreset {
  key: 'beginner' | 'challenge'
  name: string
  desc: string
  smallBlind: number
  bigBlind: number
  seats: number
  autoReveal: boolean
}

const ROOM_PRESETS: RoomPreset[] = [
  {
    key: 'beginner',
    name: '新手体验',
    desc: '4 座 / 1·2 / 自动展开',
    smallBlind: 1,
    bigBlind: 2,
    seats: 4,
    autoReveal: true,
  },
  {
    key: 'challenge',
    name: '动画挑战',
    desc: '6 座 / 5·10 / 手动展开',
    smallBlind: 5,
    bigBlind: 10,
    seats: 6,
    autoReveal: false,
  },
]

/** mock 模式的固定房表（离线演示） */
const MOCK_ROOMS: RoomSummary[] = [
  {
    code: 'SAKURA',
    host: '墨镜',
    autoReveal: false,
    smallBlind: 1,
    bigBlind: 2,
    seats: 6,
    players: 3,
    revealRate: 0,
    status: 'waiting',
    phase: 'waiting',
    handSeq: 0,
    humanCount: 2,
    botCount: 1,
    joinable: true,
  },
  {
    code: 'KOHAKU',
    host: '樱',
    autoReveal: true,
    smallBlind: 5,
    bigBlind: 10,
    seats: 4,
    players: 4,
    revealRate: 0,
    status: 'playing',
    phase: 'flop',
    handSeq: 3,
    humanCount: 2,
    botCount: 2,
    joinable: true,
  },
]

/** 房间列表三态：加载中 / 就绪（可为空）/ 失败（独立错误通道） */
type RoomsStatus = 'loading' | 'ready' | 'error'

/** 建房提交阶段：创建 → 入座（两步文案对应真实请求） */
type SubmitPhase = 'idle' | 'creating' | 'joining'

/** 幂等请求键（crypto.randomUUID 不可用时退化为时间戳 + 计数） */
let requestSeq = 0
function newRequestId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `${prefix}-${Date.now()}-${++requestSeq}`
}

export function LobbyPage() {
  const navigate = useNavigate()
  // ===== 昵称（建房与加入共用） =====
  const [nick, setNick] = useState(loadNick)
  const [nickError, setNickError] = useState<string | null>(null)
  const nickRef = useRef<HTMLInputElement>(null)

  // ===== 建房表单 =====
  const [createOpen, setCreateOpen] = useState(false)
  const [seats, setSeats] = useState(4)
  const [autoReveal, setAutoReveal] = useState(true)
  const [smallBlind, setSmallBlind] = useState(1)
  const [bigBlind, setBigBlind] = useState(2)
  // 默认只收标注数（评分人数）≥2000 的作品：认得出作品的人不用花钱（核心玩法前提）
  const [minVotes, setMinVotes] = useState(2000)
  const [deckStrategy, setDeckStrategy] = useState<DeckStrategy>('stratified')
  const [themeFilter, setThemeFilter] = useState<ThemeFilter>({ kind: 'company', value: '' })
  const [chatEnabled, setChatEnabled] = useState(true)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [submitPhase, setSubmitPhase] = useState<SubmitPhase>('idle')
  const [formError, setFormError] = useState<string | null>(null)
  const createRequestRef = useRef<string | null>(null)

  // ===== 加入 =====
  const [joinCode, setJoinCode] = useState('')
  /** 已打开的预览码（null = 仍显示房间码输入） */
  const [previewCode, setPreviewCode] = useState<string | null>(null)
  const [joinFieldError, setJoinFieldError] = useState<string | null>(null)
  const joinRequestRef = useRef<string | null>(null)

  // ===== 帮助 =====
  const [helpOpen, setHelpOpen] = useState(false)

  // ===== 房间列表 =====
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const roomsRef = useRef<RoomSummary[]>([])
  const [roomsStatus, setRoomsStatus] = useState<RoomsStatus>('loading')
  const [listError, setListError] = useState<string | null>(null)
  /** 刷新失败但保留上次成功列表 */
  const [listStale, setListStale] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const config: RoomConfig = {
    nick: nick.trim() || '牌手',
    autoReveal,
    smallBlind,
    bigBlind,
    seats,
    revealRate: 0,
    minVotes,
    deckStrategy,
    themeFilter,
    chatEnabled,
  }

  /** 当前预设：任一受控字段变化即显示「自定义」 */
  const activePreset = ROOM_PRESETS.find(
    (p) => p.seats === seats && p.smallBlind === smallBlind && p.bigBlind === bigBlind && p.autoReveal === autoReveal,
  )
  const presetName = activePreset?.name ?? '自定义'

  const loadRooms = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    if (USE_MOCK) {
      roomsRef.current = MOCK_ROOMS
      setRooms(MOCK_ROOMS)
      setRoomsStatus('ready')
      return
    }
    if (mode === 'refresh') setRefreshing(true)
    else if (roomsRef.current.length === 0) setRoomsStatus('loading')
    setListStale(false)
    try {
      const rs = await listRooms()
      roomsRef.current = rs
      setRooms(rs)
      setListError(null)
      setRoomsStatus('ready')
    } catch (e) {
      const msg = e instanceof ApiClientError ? e.message : '房间列表加载失败（后端未就绪？）'
      setListError(msg)
      if (roomsRef.current.length > 0) {
        // 保留上次成功结果，只提示更新失败
        setRoomsStatus('ready')
        setListStale(true)
      } else {
        setRoomsStatus('error')
      }
    } finally {
      setRefreshing(false)
    }
  }, [])

  // 列表初载 + 页面重新获得焦点刷新（不做高频轮询）
  useEffect(() => {
    void loadRooms('initial')
  }, [loadRooms])
  useEffect(() => {
    if (USE_MOCK) return
    const onFocus = () => void loadRooms('refresh')
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadRooms])

  /** 昵称校验：无效时聚焦昵称字段并在字段下提示 */
  const requireNick = (): boolean => {
    const err = validateNick(nick)
    setNickError(err)
    if (err) {
      nickRef.current?.focus()
      return false
    }
    return true
  }

  /** 入桌跳转（ticket 来自 REST join 回执，喂 WS join 握手） */
  const enterRoom = (code: string, cfg: RoomConfig, ticket?: string, seat?: number) => {
    // 预热对局桌 lazy chunk（与 App 的 React.lazy 同模块）：避免导航后才二次拉 chunk 的「载入中…」停顿。
    void import('./RoomPage')
    navigate(`/room/${code}`, { state: { ...cfg, ticket, seat } satisfies RoomNavState })
  }

  /** 快速建局：套用预设，其余高级项（牌池/聊天/标注数）保持当前值 */
  const applyPreset = (preset: RoomPreset) => {
    setSeats(preset.seats)
    setSmallBlind(preset.smallBlind)
    setBigBlind(preset.bigBlind)
    setAutoReveal(preset.autoReveal)
  }

  /** 建房：createRoom（幂等）→ 原地入座；入座失败也进入房间页重新入座，不再重复建房 */
  const onCreate = async (e: FormEvent) => {
    e.preventDefault()
    setFormError(null)
    if (!requireNick()) return
    saveNick(nick)
    if (USE_MOCK) {
      enterRoom(Math.random().toString(36).slice(2, 8).toUpperCase(), config)
      return
    }
    const createRequestId = (createRequestRef.current ??= newRequestId('create'))
    const joinRequestId = (joinRequestRef.current ??= newRequestId('join'))
    setSubmitPhase('creating')
    try {
      const room = await createRoom({
        nick: config.nick,
        createRequestId,
        autoReveal: config.autoReveal,
        seats: config.seats,
        smallBlind: config.smallBlind,
        bigBlind: config.bigBlind,
        revealRate: config.revealRate,
        minVotes: config.minVotes,
        deckStrategy: config.deckStrategy,
        // 主题过滤仅主题池时携带（分层随机不带，避免服务端误配）
        ...(config.deckStrategy === 'theme' ? { themeFilter: config.themeFilter } : {}),
        chatEnabled: config.chatEnabled,
      })
      // 房间已创建：后续只允许入座，不再 POST create
      createRequestRef.current = null
      setSubmitPhase('joining')
      try {
        const joined = await joinRoom(room.code, { nick: config.nick, joinRequestId })
        saveIdentity(room.code, joined)
        enterRoom(joined.room.code, config, joined.ticket, joined.seat)
      } catch (err) {
        // 已建房但入座失败：进入房间页，由统一加入流程重新入座
        setFormError(err instanceof ApiClientError ? err.message : '房间已创建，但入座失败，请重试')
        enterRoom(room.code, config)
      }
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : '建房失败，请检查后端是否可用')
    } finally {
      setSubmitPhase('idle')
    }
  }

  /** 打开加入预览：先展示房间摘要（不占座）；昵称在「入座」时校验 */
  const openPreview = (code: string) => {
    setFormError(null)
    setJoinFieldError(null)
    setPreviewCode(code)
  }

  const onJoinSubmit = (e: FormEvent) => {
    e.preventDefault()
    const code = normalizeCode(joinCode)
    if (!code) {
      setJoinFieldError('请输入房间码')
      return
    }
    openPreview(code)
  }

  /** 列表行「查看」：与输入房间码共用同一预览流程 */
  const onInspectRoom = (room: RoomSummary) => {
    setJoinCode(room.code)
    openPreview(room.code)
  }

  const onJoined = (joined: { room: RoomSummary; ticket: string; seat: number }) => {
    saveNick(nick)
    enterRoom(joined.room.code, config, joined.ticket, joined.seat)
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 pb-20 md:px-6">
      {/* Hero：品牌基准线 + 简化扇面装饰 */}
      <header className="flex items-end justify-between gap-10 pb-8 pt-12 md:pt-16">
        <div>
          <div className="text-kicker text-gold-foil">A N I T E X A S</div>
          <h1 className="mt-3 font-serif text-display text-gold-light">动画德州</h1>
          <div className="mt-4 h-px w-[140px] bg-gold-fade" />
          <p className="mt-5 max-w-[560px] text-body-lg text-muted">
            用动画作品凑羁绊，在四轮下注中争夺底池。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => setHelpOpen((v) => !v)} aria-expanded={helpOpen}>
            怎么玩
          </Button>
          <div className="relative hidden h-[150px] w-[250px] flex-none lg:block" aria-hidden="true">
            <FanCard char="紫" left={0} rotate={-9} />
            <FanCard char="凉" left={74} rotate={0} />
            <FanCard char="命" left={148} rotate={9} />
          </div>
        </div>
      </header>

      {helpOpen && (
        <Panel className="mb-5">
          <SectionHead kicker="HOW" title="怎么玩" />
          <div className="grid gap-4 text-body-lg text-gold-light/90 md:grid-cols-3">
            <p>每人 2 张底牌，桌面 5 张公共牌，从 7 张里选 5 张凑出牌型与要素羁绊。</p>
            <p>四轮下注：翻牌前、翻牌、转牌、河牌。每轮可弃牌、过牌、跟注、下注或加注。</p>
            <p>筹码决定底池归属，积分按牌型与羁绊分别结算；要素揭示只影响信息差。</p>
          </div>
        </Panel>
      )}

      {/* 昵称：建房与加入共用 */}
      <Panel className="mb-5">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <label className="flex w-full max-w-[360px] flex-col gap-2">
            <span className="text-tiny tracking-[.25em] text-gold-foil">你的昵称</span>
            <input
              ref={nickRef}
              value={nick}
              onChange={(e) => {
                setNick(e.target.value)
                if (nickError) setNickError(null)
              }}
              placeholder="怎么称呼你"
              aria-label="你的昵称"
              aria-invalid={!!nickError || undefined}
              aria-describedby={nickError ? 'nick-error' : undefined}
              className={`w-full rounded-tile border bg-ink-deep/40 px-3.5 py-2.5 text-body-lg text-gold-light outline-none placeholder:text-muted/50 focus:border-gold/60 ${
                nickError ? 'border-danger/60' : 'border-gold/20'
              }`}
            />
          </label>
          <span className="pb-3 text-body text-muted">
            昵称供建房和加入共用 · {nickLength(nick)}/{NICK_MAX_CHARS}
          </span>
        </div>
        {nickError && (
          <p id="nick-error" role="alert" data-testid="nick-error" className="mt-2 text-body text-danger">
            {nickError}
          </p>
        )}
      </Panel>

      {formError && (
        <div
          data-testid="form-error"
          role="alert"
          className="mb-5 rounded-tile border border-danger/40 bg-danger/10 px-4 py-2.5 text-body text-danger"
        >
          {formError}
        </div>
      )}

      <div className="mb-5 grid items-start gap-5 lg:grid-cols-2">
        {/* 创建房间：未展开时只显示入口 */}
        <Panel accent>
          {!createOpen ? (
            <div className="flex flex-col gap-4">
              <SectionHead kicker="CREATE" title="创建房间" desc="一个人也能玩，空位有机器人。" />
              <Button variant="gold" size="lg" icon="spark" onClick={() => setCreateOpen(true)}>
                选择规则并建房
              </Button>
            </div>
          ) : (
            <form onSubmit={onCreate} className="flex flex-col gap-5">
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon="chevronLeft"
                  onClick={() => setCreateOpen(false)}
                >
                  返回
                </Button>
                <h2 className="font-serif text-sec-title text-gold-light">创建房间</h2>
              </div>

              {/* 预设卡：受控字段变化即显示「自定义」 */}
              <div role="radiogroup" aria-label="建房预设" className="grid gap-2.5 sm:grid-cols-2">
                {ROOM_PRESETS.map((preset) => {
                  const active = activePreset?.key === preset.key
                  return (
                    <button
                      key={preset.key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      data-testid={`preset-${preset.key}`}
                      onClick={() => applyPreset(preset)}
                      className={`flex flex-col gap-1 rounded-tile border px-4 py-3 text-left transition-[transform,border-color,background-color,box-shadow] duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 ${
                        active
                          ? 'border-gold-foil/60 bg-gold-foil/10 shadow-mcard'
                          : 'border-gold/15 bg-ink-deep/40 hover:border-gold/40'
                      }`}
                    >
                      <span className="font-serif text-card-name text-gold-light">{preset.name}</span>
                      <span className="text-body text-muted">{preset.desc}</span>
                    </button>
                  )
                })}
              </div>
              {!activePreset && (
                <p data-testid="preset-custom" className="text-body text-gold-foil">
                  自定义：已微调预设受控项（座位 / 盲注 / 展开方式）
                </p>
              )}

              <div className="flex flex-wrap items-end gap-5">
                <Field label="座位数">
                  <NumberInput value={seats} min={2} max={9} onChange={setSeats} ariaLabel="座位数" />
                </Field>
                <div className="pb-2.5 text-body text-muted">要素查看：免费</div>
              </div>

              {/* 高级设置：牌池/聊天/微调（默认收起） */}
              <div className="flex flex-col gap-4">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon={advancedOpen ? 'chevronLeft' : 'chevronRight'}
                  aria-expanded={advancedOpen}
                  aria-controls="advanced-settings"
                  data-testid="advanced-toggle"
                  onClick={() => setAdvancedOpen((v) => !v)}
                >
                  高级设置
                </Button>
                {advancedOpen && (
                  <div
                    id="advanced-settings"
                    className="flex flex-col gap-5 rounded-tile border border-gold/15 bg-ink-deep/25 p-4"
                  >
                    <Field label="小盲 / 大盲">
                      <div className="flex items-center gap-2">
                        <NumberInput value={smallBlind} min={1} onChange={setSmallBlind} ariaLabel="小盲" />
                        <span className="text-muted">/</span>
                        <NumberInput value={bigBlind} min={2} onChange={setBigBlind} ariaLabel="大盲" />
                      </div>
                    </Field>

                    <Field label="最低标注数">
                      <NumberInput value={minVotes} min={0} onChange={setMinVotes} ariaLabel="最低标注数" />
                      <p className="mt-1.5 text-body text-muted">
                        只收标注数（评分人数）≥ 此值的作品；默认 2000，0 = 不过滤
                      </p>
                    </Field>

                    <FieldGroup label="牌池策略">
                      <DeckStrategyField
                        strategy={deckStrategy}
                        themeFilter={themeFilter}
                        onStrategyChange={setDeckStrategy}
                        onThemeFilterChange={setThemeFilter}
                      />
                    </FieldGroup>

                    <FieldGroup label="要素展开方式">
                      <SwitchCard
                        checked={autoReveal}
                        onChange={setAutoReveal}
                        title="开局自动展开要素"
                        desc={autoReveal ? '所有牌开局即揭示' : '要素点击展开，攒信息差'}
                      />
                    </FieldGroup>

                    <FieldGroup label="牌桌聊天">
                      <SwitchCard
                        checked={chatEnabled}
                        onChange={setChatEnabled}
                        title="开放牌桌聊天"
                        desc={chatEnabled ? '房内可自由发言（客户端限长限速）' : '关闭后本桌聊天输入框置灰'}
                      />
                    </FieldGroup>
                  </div>
                )}
              </div>

              {/* 创建摘要 */}
              <div className="rounded-tile border border-gold/15 bg-ink-deep/40 px-4 py-3 text-body text-muted">
                <div>
                  即将创建：{presetName} · {seats} 人桌 · 空位机器人补齐 · 所有真人准备后开始
                </div>
                {deckStrategy === 'theme' && themeFilter.value.trim() !== '' && (
                  <div className="mt-1 text-gold-light/80">
                    牌池：{themeKindLabel(themeFilter.kind)}「{themeFilter.value.trim()}」
                  </div>
                )}
              </div>

              <Button
                type="submit"
                variant="gold"
                size="lg"
                icon="spark"
                loading={submitPhase !== 'idle'}
                disabled={submitPhase !== 'idle'}
              >
                {submitPhase === 'creating'
                  ? '正在创建房间…'
                  : submitPhase === 'joining'
                    ? '房间已创建，正在入座…'
                    : '创建并进入准备室'}
              </Button>
            </form>
          )}
        </Panel>

        {/* 加入朋友的房间：输入码 → 摘要 → 入座 */}
        <Panel accent>
          <SectionHead kicker="JOIN" title="加入朋友的房间" />
          {previewCode ? (
            <JoinFlow
              code={previewCode}
              nick={nick}
              onJoined={onJoined}
              onCancel={() => setPreviewCode(null)}
              onNickInvalid={(msg) => {
                setNickError(msg)
                nickRef.current?.focus()
              }}
            />
          ) : (
            <form onSubmit={onJoinSubmit} className="flex flex-col gap-4">
              <Field label="房间码">
                <input
                  value={joinCode}
                  onChange={(e) => {
                    setJoinCode(e.target.value.toUpperCase())
                    if (joinFieldError) setJoinFieldError(null)
                  }}
                  placeholder="输入房间码"
                  aria-label="房间码"
                  aria-invalid={!!joinFieldError || undefined}
                  className={`w-full rounded-tile border bg-ink-deep/40 px-3.5 py-2.5 font-serif text-tier-name tracking-[.3em] text-gold-light outline-none placeholder:tracking-normal placeholder:text-muted/50 focus:border-gold/60 ${
                    joinFieldError ? 'border-danger/60' : 'border-gold/20'
                  }`}
                />
              </Field>
              {joinFieldError && (
                <p role="alert" className="text-body text-danger">
                  {joinFieldError}
                </p>
              )}
              <Button
                type="submit"
                variant="outline"
                icon="arrow"
                disabled={normalizeCode(joinCode).length === 0}
              >
                查看并加入
              </Button>
            </form>
          )}
        </Panel>
      </div>

      {/* 开放房间：手动刷新 + 焦点刷新；失败保留上次结果 */}
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SectionHead kicker="TABLES" title="开放房间" desc="点击查看房间摘要，再确认入座。" />
          <Button
            variant="ghost"
            size="sm"
            icon="arrow"
            loading={refreshing}
            data-testid="rooms-refresh"
            onClick={() => void loadRooms('refresh')}
          >
            刷新
          </Button>
        </div>

        {listStale && listError && (
          <div
            data-testid="room-list-stale"
            role="status"
            className="mb-3 rounded-tile border border-gold/25 bg-gold/10 px-4 py-2.5 text-body text-gold-light"
          >
            更新失败：{listError}。以下为上次成功结果。
          </div>
        )}

        {roomsStatus === 'loading' && (
          <div data-testid="rooms-loading" className="flex flex-col gap-2.5" role="status">
            <div className="text-body text-muted">加载中…</div>
            <div className="h-[64px] animate-pulse rounded-tile border border-gold/10 bg-ink-deep/40" />
            <div className="h-[64px] animate-pulse rounded-tile border border-gold/10 bg-ink-deep/40" />
          </div>
        )}

        {roomsStatus === 'error' && (
          <div className="flex flex-col gap-3">
            <div
              data-testid="room-list-error"
              role="alert"
              className="rounded-tile border border-danger/40 bg-danger/10 px-4 py-2.5 text-body text-danger"
            >
              {listError}
            </div>
            <div>
              <Button variant="outline" onClick={() => void loadRooms('initial')}>
                重新加载
              </Button>
            </div>
          </div>
        )}

        {roomsStatus === 'ready' &&
          (rooms.length === 0 ? (
            <div
              data-testid="rooms-empty"
              className="rounded-tile border border-gold/15 bg-ink-deep/40 px-4 py-8 text-center text-body text-muted"
            >
              还没有开放房间，创建一桌吧
            </div>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {rooms.map((room) => (
                <li key={room.code}>
                  <RoomRow room={room} onInspect={() => void onInspectRoom(room)} />
                </li>
              ))}
            </ul>
          ))}
      </Panel>
    </div>
  )
}

/** 房间码规范化：去空格、大写（格式校验交给服务端预览） */
function normalizeCode(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase()
}

/** 主题过滤维度文案 */
function themeKindLabel(kind: ThemeFilter['kind']): string {
  switch (kind) {
    case 'company':
      return '公司'
    case 'year':
      return '年代'
    case 'tag':
      return '标签'
    default:
      return '主题'
  }
}

/** hero 扇面牌（rules.html .fc 同款视觉） */
function FanCard({ char, left, rotate }: { char: string; left: number; rotate: number }) {
  return (
    <div
      className="absolute top-2.5 flex h-[138px] w-[100px] items-center justify-center rounded-card border border-gold-foil/45 bg-card-body font-serif text-4xl text-gold-light/85 shadow-fan"
      style={{ left, transform: `rotate(${rotate}deg)` }}
    >
      {char}
    </div>
  )
}

/** 表单字段容器（标签小字距 + 控件） */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-tiny tracking-[.25em] text-gold-foil">{label}</span>
      {children}
    </label>
  )
}

/**
 * 复合控件字段组（switch / radio / 按钮组）：不用 <label> 包裹——
 * button 是 labelable 元素，label 会抢占其可及名（应保留控件自身文案名）。
 */
function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-2">
      <span className="text-tiny tracking-[.25em] text-gold-foil">{label}</span>
      {children}
    </div>
  )
}

/** 数字输入（盲注/座位/标注数通用） */
function NumberInput({
  value,
  min,
  max,
  onChange,
  ariaLabel,
}: {
  value: number
  min: number
  max?: number
  onChange: (v: number) => void
  ariaLabel: string
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      aria-label={ariaLabel}
      onChange={(e) => onChange(Math.max(min, max ? Math.min(max, Number(e.target.value)) : Number(e.target.value)))}
      className="w-20 rounded-tile border border-gold/20 bg-ink-deep/40 px-3 py-2.5 text-right font-serif text-body-lg text-gold-light outline-none focus:border-gold/60"
    />
  )
}

/**
 * 开关卡片（role=switch 语义保留；switch 无法套 ui/Button，五态样式在此单点维护）。
 * 展开方式 / 牌桌聊天共用，消除两份 className 复制。
 */
function SwitchCard({
  checked,
  onChange,
  title,
  desc,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  desc: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`flex w-full items-center gap-3.5 rounded-tile border px-4 py-3 text-left transition-[transform,border-color,background-color,box-shadow,opacity] duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70
        ${checked
          ? 'border-gold-foil/60 bg-gold-foil/10 shadow-mcard'
          : 'border-gold/15 bg-ink-deep/40 hover:border-gold/40'}`}
    >
      <span
        aria-hidden="true"
        className={`relative h-6 w-11 flex-none rounded-chip border transition-colors duration-fast
          ${checked ? 'border-gold-foil/60 bg-gold-foil/25' : 'border-gold/25 bg-ink-deep/60'}`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-[18px] w-[18px] rounded-chip bg-gold-light transition-transform duration-fast
            ${checked ? 'translate-x-[22px]' : 'translate-x-0'}`}
        />
      </span>
      <span>
        <span className="block font-serif text-card-name text-gold-light">{title}</span>
        <span className="block text-body text-muted">{desc}</span>
      </span>
    </button>
  )
}

/** 房间状态文案（列表行） */
function roomStatusText(room: RoomSummary): string {
  const playing = room.status === 'playing' || (room.phase != null && room.phase !== 'waiting')
  if (!playing) return '等待准备'
  return `第 ${room.handSeq ?? 1} 手进行中`
}

/** 人数文案：等待中按真人/座位，进行中按真人 + 机器人 */
function roomPeopleText(room: RoomSummary): string {
  const playing = room.status === 'playing' || (room.phase != null && room.phase !== 'waiting')
  if (!playing) return `${room.humanCount ?? room.players} 位真人 / ${room.seats} 座 · 机器人补位`
  return `${room.humanCount ?? 0} 真人 + ${room.botCount ?? 0} 机器人`
}

/**
 * 房间列表行：整行信息 + 明确的「查看」按钮。
 * 查看只打开预览摘要，不直接占座。
 */
function RoomRow({ room, onInspect }: { room: RoomSummary; onInspect: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-tile border border-gold/15 bg-ink-deep/45 px-4 py-3">
      <Icon name="cards" className="text-gold-foil" />
      <div className="min-w-[180px] flex-1">
        <div className="font-serif text-card-name text-gold-light">
          {room.host} 的桌
          <span className="ml-2 text-body tracking-[.2em] text-gold-foil">{room.code}</span>
        </div>
        <div className="text-body text-muted">
          {roomStatusText(room)} · {roomPeopleText(room)}
        </div>
        <div className="text-body text-muted">
          盲注 {room.smallBlind}/{room.bigBlind} · {room.autoReveal ? '要素自动展开' : '手动展开要素'}
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onInspect} aria-label={`查看 ${room.code}`}>
        查看
      </Button>
    </div>
  )
}

/** 路由 lazy chunk 默认导出（App.tsx React.lazy 消费） */
export default LobbyPage

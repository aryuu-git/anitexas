import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ApiClientError,
  createRoom,
  joinRoom,
  listRooms,
  type RoomSummary,
} from '../api/client'
import type {
  BotPolicy,
  DeckStrategy,
  NextHandPolicy,
  RoomKind,
  ThemeFilter,
} from '../api/types'
import { loadNick, nickLength, saveNick, validateNick, NICK_MAX_CHARS } from '../api/nickname'
import { saveIdentity } from '../api/identity'
import { DeckStrategyField } from '../components/DeckStrategyField'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icons'
import { Panel, SectionHead } from '../components/ui/Panel'
import { JoinFlow } from '../features/lobby/JoinFlow'

/**
 * 大厅：先选“和朋友玩 / 机器人练习”，再建房；有邀请码可直接加入。
 * 朋友房默认机器人关闭、房主手动开始；练习房机器人补齐，续局方式可明示选择。
 */

/** 离线演示开关：'1' 时大厅与对局桌都走 mock */
const USE_MOCK = import.meta.env.VITE_USE_MOCK === '1'

/** 未提交的建房草稿（返回首页/准备室后保留，避免重新填写） */
const DRAFT_KEY = 'anitexas.lobby-draft-v1'
interface LobbyDraft {
  createKind: RoomKind | null
  seats: number
  targetHumanCount: number
  nextHandPolicy: NextHandPolicy
  advancedOpen: boolean
}
function loadDraft(): Partial<LobbyDraft> {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY)
    if (!raw) return {}
    const d = JSON.parse(raw) as Partial<LobbyDraft>
    return d && typeof d === 'object' ? d : {}
  } catch {
    return {}
  }
}

/** 建房配置（透传给对局桌，与 room.config JSON 对齐） */
export interface RoomConfig {
  nick: string
  autoReveal: boolean
  smallBlind: number
  bigBlind: number
  seats: number
  revealRate: number
  minVotes: number
  deckStrategy: DeckStrategy
  themeFilter: ThemeFilter
  chatEnabled: boolean
  roomKind: RoomKind
  botPolicy: BotPolicy
  targetHumanCount: number
  nextHandPolicy: NextHandPolicy
}

/** 路由 state：房间配置 + 入座回执（ticket 喂 WS join 握手） */
export interface RoomNavState extends RoomConfig {
  ticket?: string
  seat?: number
}

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

  // ===== 建房表单（草稿恢复：离开首页后保留未提交的房型/人数/续局） =====
  const draft = useRef(loadDraft()).current
  const [createKind, setCreateKind] = useState<RoomKind | null>(
    draft.createKind === 'friend' || draft.createKind === 'practice' ? draft.createKind : null,
  )
  const [seats, setSeats] = useState(() =>
    Math.min(9, Math.max(2, Number.isFinite(draft.seats) ? (draft.seats as number) : 4)),
  )
  const [targetHumanCount, setTargetHumanCount] = useState(() =>
    Math.min(9, Math.max(2, Number.isFinite(draft.targetHumanCount) ? (draft.targetHumanCount as number) : 2)),
  )
  const [nextHandPolicy, setNextHandPolicy] = useState<NextHandPolicy>(
    draft.nextHandPolicy === 'automatic' ? 'automatic' : 'manual',
  )
  // 默认隐藏要素：牌面更紧凑，也保留“认作品/揭示”的信息差玩法。
  const [autoReveal, setAutoReveal] = useState(false)
  const [smallBlind, setSmallBlind] = useState(1)
  const [bigBlind, setBigBlind] = useState(2)
  const [minVotes, setMinVotes] = useState(2000)
  const [deckStrategy, setDeckStrategy] = useState<DeckStrategy>('stratified')
  const [themeFilter, setThemeFilter] = useState<ThemeFilter>({ kind: 'company', value: '' })
  const [chatEnabled, setChatEnabled] = useState(true)
  const [advancedOpen, setAdvancedOpen] = useState(draft.advancedOpen === true)
  const [submitPhase, setSubmitPhase] = useState<SubmitPhase>('idle')
  const [formError, setFormError] = useState<string | null>(null)
  const createRequestRef = useRef<string | null>(null)

  // ===== 加入 =====
  const [joinCode, setJoinCode] = useState('')
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
  const [listStale, setListStale] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const roomKind: RoomKind = createKind ?? 'friend'
  const botPolicy: BotPolicy = roomKind === 'practice' ? 'fill' : 'off'
  const resolvedNextHand: NextHandPolicy = roomKind === 'practice' ? nextHandPolicy : 'manual'
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
    roomKind,
    botPolicy,
    targetHumanCount: Math.min(Math.max(2, targetHumanCount), seats),
    nextHandPolicy: resolvedNextHand,
  }
  const practiceBots = Math.max(0, seats - 1)

  const loadRooms = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    if (USE_MOCK) {
      roomsRef.current = []
      setRooms([])
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
      const msg = e instanceof ApiClientError ? e.message : '房间列表加载失败'
      setListError(msg)
      if (roomsRef.current.length > 0) {
        setRoomsStatus('ready')
        setListStale(true)
      } else {
        setRoomsStatus('error')
      }
    } finally {
      setRefreshing(false)
    }
  }, [])

  // 建房草稿落盘：只保存用户可理解的少量字段，不保存凭据。
  useEffect(() => {
    try {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ createKind, seats, targetHumanCount, nextHandPolicy, advancedOpen }),
      )
    } catch {
      // 隐私模式/配额不足时忽略，不影响建房
    }
  }, [createKind, seats, targetHumanCount, nextHandPolicy, advancedOpen])

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
    void import('./RoomPage')
    navigate(`/room/${code}`, { state: { ...cfg, ticket, seat } satisfies RoomNavState })
  }

  /** 选择玩法：朋友房机器人关闭；练习房机器人补齐且可选手动/自动续局。 */
  const openCreate = (kind: RoomKind) => {
    setCreateKind(kind)
    setFormError(null)
    setNextHandPolicy('manual')
    setTargetHumanCount((n) => Math.min(Math.max(2, n), seats))
  }

  /** 建房：createRoom（幂等）→ 原地入座；入座失败也进入房间页重新入座。 */
  const onCreate = async (e: FormEvent) => {
    e.preventDefault()
    setFormError(null)
    if (!requireNick()) return
    saveNick(nick)
    if (!createKind) return
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
        ...(config.deckStrategy === 'theme' ? { themeFilter: config.themeFilter } : {}),
        chatEnabled: config.chatEnabled,
        roomKind: config.roomKind,
        botPolicy: config.botPolicy,
        targetHumanCount: config.targetHumanCount,
        nextHandPolicy: config.nextHandPolicy,
      })
      createRequestRef.current = null
      setSubmitPhase('joining')
      try {
        const joined = await joinRoom(room.code, { nick: config.nick, joinRequestId })
        saveIdentity(room.code, joined)
        enterRoom(joined.room.code, config, joined.ticket, joined.seat)
      } catch (err) {
        setFormError(err instanceof ApiClientError ? err.message : '房间已创建，但入座失败，请重试')
        enterRoom(room.code, config)
      }
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : '建房失败，请重试')
    } finally {
      setSubmitPhase('idle')
    }
  }

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

  const onInspectRoom = (room: RoomSummary) => {
    setJoinCode(room.code)
    openPreview(room.code)
  }

  const onJoined = (joined: { room: RoomSummary; ticket: string; seat: number }) => {
    saveNick(nick)
    enterRoom(joined.room.code, config, joined.ticket, joined.seat)
  }

  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 pb-20 md:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-6 pt-8 md:pt-10">
        <div>
          <h1 className="font-serif text-display text-gold-light">动画德州</h1>
          <p className="mt-2 max-w-[560px] text-body-lg text-muted">
            和朋友凑一桌，用动画作品凑羁绊。
          </p>
        </div>
        <Button variant="outline" onClick={() => setHelpOpen((v) => !v)} aria-expanded={helpOpen}>
          怎么玩
        </Button>
      </header>

      {helpOpen && (
        <Panel className="mb-5">
          <SectionHead kicker="HOW" title="怎么玩" />
          <div className="grid gap-3 text-body-lg text-gold-light/90 md:grid-cols-3">
            <p>每人 2 张底牌，桌面 5 张公共牌，选 5 张凑牌型与要素羁绊。</p>
            <p>四轮下注：底牌下注、翻牌、转牌、河牌。每轮可弃牌、过牌、跟注或加注。</p>
            <p>筹码决定底池归属；积分按牌型与羁绊结算，揭示要素只影响信息差。</p>
            <p>庄家按钮标为 D；庄家下一位是小盲，再下一位是大盲。</p>
          </div>
        </Panel>
      )}

      {/* 昵称：共享身份栏；已有昵称时保持紧凑 */}
      <div className="mb-5 flex flex-wrap items-end gap-x-4 gap-y-2 rounded-panel border border-gold/15 bg-panel px-4 py-3 shadow-panel">
        <label className="flex items-center gap-3">
          <span className="text-body text-muted">昵称</span>
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
            className={`w-[180px] rounded-tile border bg-ink-deep/40 px-3 py-2 text-body-lg text-gold-light outline-none placeholder:text-muted/50 focus:border-gold/60 ${
              nickError ? 'border-danger/60' : 'border-gold/20'
            }`}
          />
          <span className="text-body text-muted">
            {nickLength(nick)}/{NICK_MAX_CHARS}
          </span>
        </label>
        <span className="pb-1 text-body text-muted">建房和加入共用同一个昵称。</span>
      </div>
      {nickError && (
        <p id="nick-error" role="alert" data-testid="nick-error" className="mb-4 text-body text-danger">
          {nickError}
        </p>
      )}

      {formError && (
        <div
          data-testid="form-error"
          role="alert"
          className="mb-4 rounded-tile border border-danger/40 bg-danger/10 px-4 py-2.5 text-body text-danger"
        >
          {formError}
        </div>
      )}

      <div className="mb-5 grid items-start gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        {/* 主入口：和朋友玩 / 机器人练习 */}
        <Panel accent>
          {!createKind ? (
            <div className="flex flex-col gap-4">
              <SectionHead kicker="PLAY" title="开始一桌" desc="朋友房默认不补机器人，由房主手动开始。" />
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  data-testid="start-friend"
                  onClick={() => openCreate('friend')}
                  className="flex flex-col gap-1 rounded-tile border border-gold-foil/50 bg-gold-foil/10 px-4 py-4 text-left shadow-mcard transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70"
                >
                  <span className="font-serif text-tier-name text-gold-light">和朋友玩</span>
                  <span className="text-body text-muted">空座等朋友，所有人准备后由房主开始。</span>
                </button>
                <button
                  type="button"
                  data-testid="start-practice"
                  onClick={() => openCreate('practice')}
                  className="flex flex-col gap-1 rounded-tile border border-gold/20 bg-ink-deep/40 px-4 py-4 text-left transition hover:border-gold/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70"
                >
                  <span className="font-serif text-tier-name text-gold-light">机器人练习</span>
                  <span className="text-body text-muted">机器人补齐座位，可以自己练一手。</span>
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={onCreate} className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon="chevronLeft"
                  onClick={() => setCreateKind(null)}
                >
                  返回
                </Button>
                <h2 className="font-serif text-sec-title text-gold-light">
                  {roomKind === 'practice' ? '创建练习房' : '创建朋友房'}
                </h2>
                <span className="ml-auto text-body text-muted">
                  {roomKind === 'practice' ? '机器人默认补齐' : '机器人关闭'}
                </span>
              </div>

              <div className="flex flex-wrap items-end gap-5">
                <Field label="座位数">
                  <NumberInput
                    value={seats}
                    min={2}
                    max={9}
                    ariaLabel="座位数"
                    onChange={(v) => {
                      setSeats(v)
                      setTargetHumanCount((n) => Math.min(n, v))
                    }}
                  />
                </Field>
                <Field label="期望参局人数">
                  <NumberInput
                    value={Math.min(Math.max(2, targetHumanCount), seats)}
                    min={2}
                    max={seats}
                    ariaLabel="期望参局人数"
                    onChange={setTargetHumanCount}
                  />
                </Field>
                <div className="pb-2.5 text-body text-muted">
                  {roomKind === 'practice' ? `机器人 ${practiceBots} 位` : '机器人：关闭'}
                </div>
              </div>

              {roomKind === 'practice' && (
                <FieldGroup label="下一手">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant={nextHandPolicy === 'manual' ? 'outline' : 'ghost'}
                      size="sm"
                      aria-pressed={nextHandPolicy === 'manual'}
                      onClick={() => setNextHandPolicy('manual')}
                    >
                      手动开始
                    </Button>
                    <Button
                      type="button"
                      variant={nextHandPolicy === 'automatic' ? 'outline' : 'ghost'}
                      size="sm"
                      aria-pressed={nextHandPolicy === 'automatic'}
                      onClick={() => setNextHandPolicy('automatic')}
                    >
                      自动续局
                    </Button>
                  </div>
                </FieldGroup>
              )}

              <div className="flex flex-col gap-3">
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
                    className="flex flex-col gap-4 rounded-tile border border-gold/15 bg-ink-deep/25 p-4"
                  >
                    <Field label="小盲 / 大盲">
                      <div className="flex items-center gap-2">
                        <NumberInput value={smallBlind} min={1} onChange={setSmallBlind} ariaLabel="小盲" />
                        <span className="text-muted">/</span>
                        <NumberInput value={bigBlind} min={2} onChange={setBigBlind} ariaLabel="大盲" />
                      </div>
                    </Field>
                    <Field label="作品热度（评分人数下限）">
                      <NumberInput value={minVotes} min={0} onChange={setMinVotes} ariaLabel="最低标注数" />
                      <p className="mt-1 text-body text-muted">默认 2000；0 = 不过滤。</p>
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
                        desc={autoReveal ? '所有牌开局即揭示' : '要素点击展开'}
                      />
                    </FieldGroup>
                    <FieldGroup label="牌桌聊天">
                      <SwitchCard
                        checked={chatEnabled}
                        onChange={setChatEnabled}
                        title="开放牌桌聊天"
                        desc={chatEnabled ? '房内可自由发言' : '关闭聊天输入'}
                      />
                    </FieldGroup>
                  </div>
                )}
              </div>

              <div className="rounded-tile border border-gold/15 bg-ink-deep/40 px-4 py-3 text-body text-muted">
                <div data-testid="create-summary">
                  {roomKind === 'practice' ? '练习房' : '朋友房'} · {seats} 座 · 目标{' '}
                  {Math.min(Math.max(2, targetHumanCount), seats)} 人 ·{' '}
                  {roomKind === 'practice' ? `机器人 ${practiceBots} 位` : '机器人关闭'} ·{' '}
                  {resolvedNextHand === 'automatic' ? '自动续局' : '房主手动开始'}
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
                    : '创建房间'}
              </Button>
            </form>
          )}
        </Panel>

        {/* 加入朋友的房间：房间码直达 */}
        <Panel accent>
          <SectionHead kicker="JOIN" title="加入朋友的房间" desc="有邀请码或链接，直接加入。" />
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
          <SectionHead kicker="TABLES" title="开放房间" desc="点击查看摘要，再确认入座。" />
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

/** 表单字段容器 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-tiny tracking-[.18em] text-gold-foil">{label}</span>
      {children}
    </label>
  )
}

/** 复合控件字段组（switch / 按钮组不套 label） */
function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-2">
      <span className="text-tiny tracking-[.18em] text-gold-foil">{label}</span>
      {children}
    </div>
  )
}

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
      onChange={(e) => {
        const n = Number(e.target.value)
        onChange(Math.max(min, max != null ? Math.min(max, n) : n))
      }}
      className="w-20 rounded-tile border border-gold/20 bg-ink-deep/40 px-3 py-2.5 text-right font-serif text-body-lg text-gold-light outline-none focus:border-gold/60"
    />
  )
}

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
      className={`flex w-full items-center gap-3.5 rounded-tile border px-4 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70
        ${checked
          ? 'border-gold-foil/60 bg-gold-foil/10'
          : 'border-gold/15 bg-ink-deep/40 hover:border-gold/40'}`}
    >
      <span
        aria-hidden="true"
        className={`relative h-6 w-11 flex-none rounded-chip border ${
          checked ? 'border-gold-foil/60 bg-gold-foil/25' : 'border-gold/25 bg-ink-deep/60'
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-[18px] w-[18px] rounded-chip bg-gold-light transition-transform ${
            checked ? 'translate-x-[22px]' : 'translate-x-0'
          }`}
        />
      </span>
      <span>
        <span className="block font-serif text-card-name text-gold-light">{title}</span>
        <span className="block text-body text-muted">{desc}</span>
      </span>
    </button>
  )
}

function roomStatusText(room: RoomSummary): string {
  const playing = room.status === 'playing' || (room.phase != null && room.phase !== 'waiting')
  if (!playing) return '等待开始'
  return `第 ${room.handSeq ?? 1} 手进行中`
}

function roomPeopleText(room: RoomSummary): string {
  const humans = room.humanCount ?? room.players
  const bots = room.botCount ?? 0
  const target = room.targetHumanCount ?? room.seats
  return `真人 ${humans}/${target}${bots > 0 ? ` · 机器人 ${bots}` : ''}`
}

function RoomRow({ room, onInspect }: { room: RoomSummary; onInspect: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-tile border border-gold/15 bg-ink-deep/45 px-4 py-3">
      <Icon name="cards" className="text-gold-foil" />
      <div className="min-w-[180px] flex-1">
        <div className="font-serif text-card-name text-gold-light">
          {room.host} 的桌
          <span className="ml-2 text-body tracking-[.2em] text-gold-foil">{room.code}</span>
          <span className="ml-2 text-micro text-muted">
            {room.roomKind === 'practice' ? '练习房' : '朋友房'}
          </span>
        </div>
        <div className="text-body text-muted">
          {roomStatusText(room)} · {roomPeopleText(room)}
        </div>
        <div className="text-body text-muted">
          盲注 {room.smallBlind}/{room.bigBlind} · {room.autoReveal ? '要素自动展开' : '手动展开要素'}
          {room.nextHandPolicy === 'automatic' ? ' · 自动续局' : ' · 手动续局'}
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onInspect} aria-label={`查看 ${room.code}`}>
        查看
      </Button>
    </div>
  )
}

export default LobbyPage

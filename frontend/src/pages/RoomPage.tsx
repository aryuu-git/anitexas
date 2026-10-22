import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import type {
  ActionType,
  CardData,
  ClientMessage,
  EmoteKey,
  Envelope,
  Phase,
  RevealScope,
  SettledPayload,
} from '../api/types'
import { TIER_NAMES } from '../api/types'
import { ApiClientError, joinRoom } from '../api/client'
import { loadIdentity, saveIdentity } from '../api/identity'
import { loadNick, saveNick } from '../api/nickname'
import { applyEvent, clearError, createRoomState, type RoomState } from '../api/roomState'
import { deriveExperienceState } from '../api/experienceState'
import { startMockDesk, type DeskTransport } from '../api/mockDesk'
import { NOTICE_TTL_MS, PENDING_CONFIRM_MS, useAutoExpire } from '../hooks/useAutoExpire'
import { useCountdown } from '../hooks/useCountdown'
import { useRoomSocket, WS_MAX_RETRIES } from '../hooks/useRoomSocket'
import { useSound } from '../hooks/useSound'
import { JoinFlow } from '../features/lobby/JoinFlow'
import { ActionHistory } from '../features/room/ActionHistory'
import { PhaseProgress } from '../features/room/PhaseProgress'
import { RoomWaitingView } from '../features/room/RoomWaitingView'
import { ActionBar } from '../components/controls/ActionBar'
import { type ChatLine } from '../components/ChatPanel'
import { HoleCards } from '../components/HoleCards'
import { BoxDrawer } from '../components/table/BoxDrawer'
import { PokerTable } from '../components/table/PokerTable'
import { ResultPanel } from '../components/ResultPanel'
import { TableDock } from '../components/TableDock'
import { TierCelebration } from '../components/TierCelebration'
import { Button } from '../components/ui/Button'
import { Panel, SectionHead } from '../components/ui/Panel'
import type { RoomConfig, RoomNavState } from './LobbyPage'

/**
 * 对局桌（A5.5/A5.6）：座位环 + 公共牌 + 底池 + 下注条。
 * 信息层级：当前回合（下注条倒计时）> 牌面（牌阵）> 比分（座位/结算）。
 * 传输：真实模式 = REST join 拿一次性 ticket → WS /ws 握手（useRoomSocket）；
 * VITE_USE_MOCK=1 走 mock 桌面（内存假服务，离线演示）。
 */

/** 离线演示开关（与 LobbyPage 同源语义） */
const USE_MOCK = import.meta.env.VITE_USE_MOCK === '1'

/** 对局面 WS 地址：显式配置优先，缺省同源 <BASE>/ws
 * （dev 经 vite 代理 → 8081；子路径部署（/anitexas/）时为 /anitexas/ws，见 vite base） */
const WS_URL =
  import.meta.env.VITE_WS_URL ??
  `${typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'}://${
    typeof window !== 'undefined' ? window.location.host : 'localhost'
  }${import.meta.env.BASE_URL.replace(/\/$/, '')}/ws`

/** 未配置导航 state 时的默认建房配置（深链/刷新兜底） */
const DEFAULT_CONFIG: RoomConfig = {
  nick: '你',
  autoReveal: false,
  smallBlind: 1,
  bigBlind: 2,
  seats: 4,
  revealRate: 0,
  minVotes: 2000,
  deckStrategy: 'stratified',
  themeFilter: { kind: 'company', value: '' },
  chatEnabled: true,
}

/** 可下注的回合阶段 */
const BETTING_PHASES: Phase[] = ['preflop', 'flop', 'turn', 'river']

/** 待确认命令（v2 命令确认：只由本人回执或核对结束解除） */
interface PendingCommand {
  requestId: string
  type: ActionType | 'ready' | 'leave'
  verifying: boolean
}

// ===== 身份恢复（sessionStorage，按房间实例保存；不写 URL/日志） =====

/** 命令幂等键（crypto.randomUUID 不可用时退化为时间戳 + 计数） */
let requestSeq = 0
function newRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `req-${Date.now()}-${++requestSeq}`
}

/** 对局桌内容最大宽度（牌桌固定 1260，页面留出两侧留白） */
const CONTENT_MAX_W = 1320

export function RoomPage() {
  const { code = '' } = useParams()
  const nav = useLocation()
  const navigate = useNavigate()
  const navState = nav.state as RoomNavState | null
  // 昵称：大厅带入优先，深链时用本地偏好（首次进入需在加入卡片确认）
  const [nick, setNick] = useState(() => (navState?.nick ?? loadNick()) || '你')
  const [nickError, setNickError] = useState<string | null>(null)
  const nickRef = useRef<HTMLInputElement>(null)
  const config: RoomConfig = { ...DEFAULT_CONFIG, ...navState, nick }

  const [state, setState] = useState<RoomState>(createRoomState)
  /** 已发出、等待回执的命令（5s 未确认转 verifying 并 resync，不自动重发） */
  const [pending, setPending] = useState<PendingCommand | null>(null)

  // 桌感（D15）：音效 + 表情冷却 + 顶级牌型特效
  const sound = useSound()
  const playRef = useRef(sound.play)
  useEffect(() => {
    playRef.current = sound.play
  }, [sound.play])
  const [emoteCooldownUntil, setEmoteCooldownUntil] = useState(0)
  const [celebrated, setCelebrated] = useState(false)
  // 封面开关（临时）：桌面默认不展示封面区（渐变 + 首字），卡片更短；需要时再打开
  const [showCover, setShowCover] = useState(false)
  // 桌边浮窗（表情 + 聊天二合一）：浮层，不占牌桌布局宽度；默认收起保持桌面干净
  const [dockOpen, setDockOpen] = useState(false)
  // 聊天未读徽标：浮窗收起期间到达的消息计数，打开即清零（ref 供事件入口读取）
  const [chatUnread, setChatUnread] = useState(0)
  const dockOpenRef = useRef(dockOpen)
  useEffect(() => {
    dockOpenRef.current = dockOpen
    if (dockOpen) setChatUnread(0)
  }, [dockOpen])
  // 牌池抽屉（D17）：本手盒名单 + 牌池摘要
  const [poolOpen, setPoolOpen] = useState(false)
  // 结算面板可被 ESC 关掉（不发 ready）；新一手/新结算自动回来
  const [resultDismissed, setResultDismissed] = useState(false)
  // 上手结果回顾（只读；新一手开始时自动收起，保留入口）
  const [reviewOpen, setReviewOpen] = useState(false)

  // 入座 ticket：大厅 REST join 回执优先；深链/刷新时优先用恢复凭据自动入座，
  // 无有效凭据则先显示加入卡片（不假设昵称、不闪假桌面）。
  const [ticket, setTicket] = useState<string | null>(navState?.ticket ?? null)
  const [joinError, setJoinError] = useState<string | null>(null)
  /** need-join = 等待用户确认加入；joining = 正在用恢复凭据入座；joined = 已拿到 ticket */
  const [joinState, setJoinState] = useState<'need-join' | 'joining' | 'joined'>(() =>
    USE_MOCK || navState?.ticket ? 'joined' : loadIdentity(code) ? 'joining' : 'need-join',
  )
  const joinRequestIdRef = useRef(newRequestId())
  useEffect(() => {
    if (USE_MOCK || navState?.ticket || ticket || joinState !== 'joining') return
    const stored = loadIdentity(code)
    if (!stored) {
      setJoinState('need-join')
      return
    }
    let alive = true
    joinRoom(code, {
      nick,
      resumeToken: stored.resumeToken,
      roomInstanceId: stored.roomInstanceId,
      joinRequestId: joinRequestIdRef.current,
    })
      .then((r) => {
        if (!alive) return
        saveIdentity(code, r)
        setTicket(r.ticket)
        setJoinState('joined')
      })
      .catch((e: unknown) => {
        if (!alive) return
        setJoinError(
          e instanceof ApiClientError && e.code === 'nick_taken'
            ? '昵称已被占用，请换个昵称或使用原浏览器恢复身份'
            : e instanceof ApiClientError
              ? e.message
              : '入座失败（后端未就绪？可设 VITE_USE_MOCK=1 走演示桌）',
        )
        setJoinState('need-join')
      })
    return () => {
      alive = false
    }
  }, [code, joinState, navState?.ticket, nick, ticket])

  // 首次收到 live 权威帧即恢复成功：清掉此前恢复凭据失败的提示
  useEffect(() => {
    if (state.live) setJoinError(null)
  }, [state.live])

  // 事件入口：信封归约（useRoomSocket 与 mock 桌面共用同一入口）+ 轻音效
  // pending 只由本人回执或 5s 核对结束解除，别人的动作/快照不解除
  const onEvent = useCallback((e: Envelope) => {
    setState((s) => applyEvent(s, e))
    if (e.t === 'said' && !dockOpenRef.current) setChatUnread((u) => u + 1)
    if (e.t === 'dealt') playRef.current('deal')
    else if (e.t === 'acted') playRef.current('bet')
    else if (e.t === 'revealed') playRef.current('reveal')
    else if (e.t === 'showdown') playRef.current('showdown')
  }, [])

  /** 顶级牌型特效结束回调：稳定引用，避免每次事件重渲都重置 TierCelebration 的 2.8s 定时器 */
  const onCelebrationDone = useCallback(() => setCelebrated(true), [])

  // WS 握手：ticket 就绪才连（连接成功后自动发 join，重连亦然）
  const join = useMemo(
    () => (ticket ? { roomCode: code, nick: config.nick, ticket } : null),
    [code, config.nick, ticket],
  )
  const {
    send: wsSend,
    connected,
    live: socketLive,
    serverOffset,
    retries,
  } = useRoomSocket(USE_MOCK ? null : WS_URL, join, onEvent)

  // mock 桌面（离线演示）
  const deskRef = useRef<DeskTransport | null>(null)
  const mockOpts = useMemo(
    () => ({
      roomCode: code,
      nick: config.nick,
      autoReveal: config.autoReveal,
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      revealRate: config.revealRate,
      chatEnabled: config.chatEnabled,
      deckStrategy: config.deckStrategy,
      themeFilter: config.themeFilter,
    }),
    [
      code,
      config.nick,
      config.autoReveal,
      config.smallBlind,
      config.bigBlind,
      config.revealRate,
      config.chatEnabled,
      config.deckStrategy,
      config.themeFilter,
    ],
  )
  useEffect(() => {
    if (!USE_MOCK) return
    const desk = startMockDesk(mockOpts, onEvent)
    deskRef.current = desk
    return () => {
      desk.close()
      deskRef.current = null
    }
  }, [mockOpts, onEvent])

  const send = useCallback(
    (msg: ClientMessage) => {
      if (USE_MOCK) deskRef.current?.send(msg)
      else wsSend(msg)
    },
    [wsSend],
  )

  // ===== 连接态（断线体验）：live = 已收到权威状态帧；未同步时输入一律禁用 =====
  const live = state.live && (USE_MOCK || socketLive)
  const linkUp = live
  const offset = USE_MOCK ? 0 : serverOffset
  const connLabel = USE_MOCK
    ? state.live
      ? '本地演示桌（mock）'
      : '本地演示桌（mock）· 同步中'
    : connected
      ? state.live
        ? '已连接'
        : '同步中…'
      : retries >= WS_MAX_RETRIES
        ? '连接失败请刷新'
        : retries > 0
          ? `重连中(${retries})`
          : ticket
            ? '连接中…'
            : '入座中…'

  /** 命令公共元数据：实例 + 版本 + 手数（服务端据此拒绝过期操作） */
  const commandMeta = useCallback(
    (requestId: string) => ({
      protocolVersion: 2,
      requestId,
      roomInstanceId: state.roomInstanceId || undefined,
      expectedHandSeq: state.handSeq,
      expectedRevision: state.revision,
    }),
    [state.roomInstanceId, state.handSeq, state.revision],
  )

  /** 发出可确认命令：本地先挂 pending，由回执/核对结果解除 */
  const sendCommand = useCallback(
    (kind: 'ready' | 'action' | 'leave', payload: Record<string, unknown>) => {
      const requestId = newRequestId()
      setPending({
        requestId,
        type: kind === 'action' ? (payload.type as ActionType) : kind,
        verifying: false,
      })
      send({ t: kind, p: { ...payload, ...commandMeta(requestId) } } as ClientMessage)
      return requestId
    },
    [send, commandMeta],
  )

  /** ready：waiting 开局 / settled 提前开下一手（局中被服务端忽略） */
  const onReady = useCallback(() => {
    if (!live || pending) return
    sendCommand('ready', {})
  }, [live, pending, sendCommand])

  /** 离开：发 leave 后回大厅 */
  const onLeave = useCallback(() => {
    if (live) sendCommand('leave', {})
    navigate('/')
  }, [live, sendCommand, navigate])

  /** 回执到达：只解除对应 requestId 的 pending（别人的动作不影响自己的待确认） */
  useEffect(() => {
    if (!pending) return
    const receipt = state.receipts[pending.requestId]
    if (!receipt) return
    setPending(null)
    if (receipt.status === 'rejected') {
      setState((s) => ({ ...s, lastError: `操作未生效（${receipt.code ?? '已拒绝'}），已同步当前牌局` }))
    }
  }, [state.receipts, pending])

  // 5s 未确认：转 verifying 并 resync 查询（不自动重发旧命令）
  useEffect(() => {
    if (!pending || pending.verifying) return
    const timer = window.setTimeout(() => {
      setPending((p) => (p && p.requestId === pending.requestId ? { ...p, verifying: true } : p))
      send({ t: 'resync', p: { requestId: pending.requestId } })
    }, PENDING_CONFIRM_MS)
    return () => window.clearTimeout(timer)
  }, [pending, send])

  // 核对仍无回执：展示「结果未能确认」，清空本地提案，只按最新合法状态重新决策
  useEffect(() => {
    if (!pending?.verifying) return
    const timer = window.setTimeout(() => {
      setPending(null)
      setState((s) => ({ ...s, lastError: '结果未能确认，已同步当前牌局' }))
    }, PENDING_CONFIRM_MS)
    return () => window.clearTimeout(timer)
  }, [pending?.verifying, pending?.requestId])

  // 错误提示 5s 自动清除
  useAutoExpire(state.lastError, NOTICE_TTL_MS, () => setState(clearError))
  // ESC 关面板只影响当前这手；新手结算（handSeq + endedAt 变化）才重新弹出
  useEffect(() => {
    setResultDismissed(false)
  }, [state.lastResult?.handSeq, state.lastResult?.endedAt])
  // 新一手开始：收起上手回顾，入口仍常驻（回顾不改变参局状态）
  useEffect(() => setReviewOpen(false), [state.handSeq])

  // ===== 派生态 =====
  const me = state.seats.find((s) => s.seat === state.mySeat)
  const inBetting = BETTING_PHASES.includes(state.phase)
  /** 下一手自动开局倒计时（秒，按 serverNow 校正时差） */
  const nextHandRemaining = useCountdown(state.nextHandAt, offset)
  const isMyTurn = inBetting && state.turnSeat === state.mySeat && !(me?.folded ?? true)
  const canReveal = live && inBetting && !(me?.folded ?? true)
  // 当前行动者昵称（非本方回合时指明「轮到谁」，不让人猜）
  const turnNick = state.seats.find((s) => s.seat === state.turnSeat)?.nick ?? null
  const myShowdownHand = state.showdown?.find((h) => h.seat === state.mySeat) ?? null

  /** 本手结算（showdown/settled 才可交互）；开下一手后用 lastResult 做只读回顾 */
  const inResultPhase = state.phase === 'showdown' || state.phase === 'settled'
  const liveSettled = inResultPhase ? state.settled : null
  const reviewSettled =
    state.lastResult != null
      ? { rows: state.lastResult.rows, potWins: state.lastResult.potWins }
      : null
  const shownSettled = liveSettled ?? reviewSettled
  const reviewMode = liveSettled == null && reviewOpen
  const resultVisible = reviewOpen || (liveSettled != null && !resultDismissed)

  /** 体验视图模型：页面只消费它给出的 screen/actionMode/文案/合法动作 */
  const view = useMemo(
    () =>
      deriveExperienceState(state, {
        live,
        hasIdentity: !!ticket || USE_MOCK || joinState === 'joining',
        pending: pending ? { type: pending.type, verifying: pending.verifying } : null,
      }),
    [state, live, ticket, pending, joinState],
  )

  /** 摊牌后的牌型名（座位面板标签用；随 showdown 变化，稳定引用） */
  const tierNameOf = useCallback(
    (seat: number): string | undefined => {
      const hand = state.showdown?.find((h) => h.seat === seat)
      return hand ? TIER_NAMES[hand.tier] ?? `第 ${hand.tier} 级` : undefined
    },
    [state.showdown],
  )

  const onAction = useCallback(
    (type: ActionType, amount?: number) => {
      if (!live || pending || !view.actions.includes(type)) return
      sendCommand('action', { type, amount })
    },
    [live, pending, view.actions, sendCommand],
  )

  /** 揭示动作（稳定引用，配合 HandBoard/CardFace 的 React.memo） */
  const onReveal = useCallback(
    (card: CardData, scope: RevealScope) => {
      if (!live) return
      const requestId = newRequestId()
      send({ t: 'reveal', p: { cardId: card.id, scope, ...commandMeta(requestId) } })
    },
    [live, send, commandMeta],
  )

  /** 快捷表情（本地 10 秒冷却与服务端同规则；稳定引用） */
  const onEmote = useCallback(
    (key: EmoteKey) => {
      send({ t: 'emote', p: { key } })
      setEmoteCooldownUntil(Date.now() + 10000)
    },
    [send],
  )

  /** 聊天上行（长度/节流由 ChatPanel 客户端侧把关，服务端同限校验兜底） */
  const onSay = useCallback((text: string) => send({ t: 'say', p: { text } }), [send])

  /** 聊天展示行（座位昵称就地解析） */
  const chatLines: ChatLine[] = useMemo(
    () =>
      state.chat.map((m) => ({
        seat: m.seat,
        nick: state.seats.find((s) => s.seat === m.seat)?.nick ?? `座位 ${m.seat}`,
        text: m.text,
      })),
    [state.chat, state.seats],
  )

  // ===== 桌面音效触发（D15） =====
  // 轮到自己：行动权上升沿响一声
  const wasMyTurn = useRef(false)
  useEffect(() => {
    if (isMyTurn && !wasMyTurn.current) playRef.current('yourTurn')
    wasMyTurn.current = isMyTurn
  }, [isMyTurn])

  // 结算：自己筹码盈亏为正 → 赢局音
  const settledRef = useRef<SettledPayload | null>(null)
  useEffect(() => {
    if (!state.settled || state.settled === settledRef.current) return
    settledRef.current = state.settled
    const row = state.settled.rows.find((r) => r.seat === state.mySeat)
    if (row && row.chipsDelta > 0) playRef.current('win')
  }, [state.settled, state.mySeat])

  // 新一手的摊牌重置顶级特效标记
  useEffect(() => setCelebrated(false), [state.showdown])

  /** 顶级牌型（合奏及以上，tier ≥ 7）触发全桌特效 */
  const winnerTier = state.showdown?.[0]?.tier ?? 0

  /** 摊牌赢家座位（结算优先取主池赢家，其次摊牌首位） */
  const winnerSeat = useMemo(() => {
    const wins = state.settled?.potWins
    if (wins) {
      const keys = Object.keys(wins).map(Number).filter((n) => !Number.isNaN(n))
      if (keys.length) return keys[0]
    }
    return state.showdown?.[0]?.seat ?? null
  }, [state.settled, state.showdown])

  /** 座位 → 最近动作文案（弃牌/全下/跟注/过牌） */
  const lastActionOf = useCallback(
    (seat: number): string | undefined => {
      const s = state.seats.find((x) => x.seat === seat)
      if (!s) return undefined
      if (s.folded) return '弃牌'
      if (!s.acted) return undefined
      if (s.chips <= 0) return '全下'
      return s.bet > 0 ? '跟注' : '过牌'
    },
    [state.seats],
  )

  // ===== 深链/刷新：无有效身份先加入，绝不闪「第 0 手」假桌面 =====
  if (!USE_MOCK && !ticket && joinState === 'need-join') {
    return (
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[720px] flex-col gap-5 px-4 py-10 md:px-6">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="font-serif text-sec-title text-gold-light">
            房间 <span className="tracking-[.25em] text-gold-foil">{code.toUpperCase()}</span>
          </h1>
          <Button className="ml-auto" variant="ghost" size="sm" onClick={() => navigate('/')}>
            返回首页
          </Button>
        </header>

        {joinError && (
          <div
            role="status"
            data-testid="join-error"
            className="rounded-tile border border-gold/25 bg-gold/10 px-4 py-2.5 text-body text-gold-light"
          >
            {joinError}
          </div>
        )}

        <Panel accent>
          <SectionHead kicker="JOIN" title="加入房间" desc="先确认房间摘要，再明确入座。" />
          <label className="flex max-w-[360px] flex-col gap-2">
            <span className="text-tiny tracking-[.25em] text-gold-foil">你的昵称</span>
            <input
              ref={nickRef}
              value={nick}
              onChange={(e) => {
                setNick(e.target.value)
                if (nickError) setNickError(null)
              }}
              aria-label="你的昵称"
              aria-invalid={!!nickError || undefined}
              className={`w-full rounded-tile border bg-ink-deep/40 px-3.5 py-2.5 text-body-lg text-gold-light outline-none placeholder:text-muted/50 focus:border-gold/60 ${
                nickError ? 'border-danger/60' : 'border-gold/20'
              }`}
            />
          </label>
          {nickError && (
            <p role="alert" className="mt-2 text-body text-danger">
              {nickError}
            </p>
          )}
          <div className="mt-5">
            <JoinFlow
              code={code.toUpperCase()}
              nick={nick}
              onJoined={(r) => {
                saveNick(nick)
                setJoinError(null)
                setTicket(r.ticket)
                setJoinState('joined')
              }}
              onCancel={() => navigate('/')}
              onNickInvalid={(msg) => {
                setNickError(msg)
                nickRef.current?.focus()
              }}
            />
          </div>
        </Panel>
      </div>
    )
  }

  // ===== 已入座但尚未同步：只显示同步说明，不渲染假牌桌 =====
  if (!USE_MOCK && view.screen === 'syncing') {
    return (
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[720px] flex-col gap-5 px-4 py-10 md:px-6">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="font-serif text-sec-title text-gold-light">
            房间 <span className="tracking-[.25em] text-gold-foil">{code.toUpperCase()}</span>
          </h1>
          <Button className="ml-auto" variant="ghost" size="sm" onClick={() => navigate('/')}>
            返回首页
          </Button>
        </header>
        <Panel accent>
          <h2 className="font-serif text-tier-name text-gold-light">正在同步牌桌…</h2>
          <p className="mt-2 text-body text-muted" role="status">
            {connLabel}
          </p>
          <p className="mt-4 text-body text-muted">收到权威状态帧前不会显示牌面，也不接受任何操作。</p>
        </Panel>
      </div>
    )
  }

  // ===== 准备室：只展示摘要、邀请与权威座位名单 =====
  if (view.screen === 'waitingRoom') {
    return (
      <RoomWaitingView
        code={code}
        state={state}
        view={view}
        linkUp={live}
        pendingReady={pending?.type === 'ready'}
        connLabel={connLabel}
        onReady={onReady}
        onLeave={onLeave}
      />
    )
  }

  return (
    <div className="relative min-h-[100dvh] w-full overflow-x-hidden">
      <div
        className="mx-auto flex w-full flex-col gap-3 px-3 py-4 md:px-6"
        style={{ maxWidth: CONTENT_MAX_W }}
        data-testid="stage"
      >
      {/* 顶栏：房间信息 + 阶段（弱化层级） */}
      <header className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <h1 className="font-serif text-tier-name text-gold-light">
          房间 <span className="tracking-[.25em] text-gold-foil">{state.roomCode || code}</span>
        </h1>
        <span className="rounded-chip border border-gold/25 bg-gold/10 px-2.5 py-0.5 text-micro text-gold-light">
          {state.autoReveal ? '开局自动展开' : '手动揭示'}
        </span>
        <span className="rounded-chip border border-gold/15 px-2.5 py-0.5 text-micro text-muted">
          {phaseLabel(state.phase)} 第 {state.handSeq} 手
        </span>
        <span className="ml-auto text-micro text-muted" role="status" data-testid="conn-status">
          {connLabel}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={sound.muted}
          onClick={sound.toggleMuted}
          title="音效"
        >
          音效 {sound.muted ? '关' : '开'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={showCover}
          onClick={() => setShowCover((v) => !v)}
          title="封面"
        >
          封面 {showCover ? '开' : '关'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={poolOpen}
          onClick={() => setPoolOpen((v) => !v)}
          title="牌池与盒名单"
        >
          牌池
        </Button>
        {state.lastResult && !resultVisible && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="review-result"
            onClick={() => (liveSettled ? setResultDismissed(false) : setReviewOpen(true))}
          >
            {liveSettled ? '查看本手结果' : '上手结果'}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={dockOpen}
          onClick={() => setDockOpen((v) => !v)}
          title="表情与聊天"
          aria-label={chatUnread > 0 ? `表情与聊天，${chatUnread} 条新消息` : '表情与聊天'}
        >
          聊天
          {chatUnread > 0 && (
            <span
              className="ml-1 rounded-chip bg-gold-foil px-1.5 text-micro text-ink-deep"
              data-testid="chat-unread"
            >
              {chatUnread}
            </span>
          )}
        </Button>
        <Button variant="ghost" size="sm" onClick={onLeave}>
          离开
        </Button>
      </header>

      {/* 入座失败回执（REST join） */}
      {joinError && (
        <div className="mt-4 rounded-tile border border-danger/40 bg-danger/10 px-4 py-2.5 text-body text-danger">
          {joinError}
        </div>
      )}

      {/* 非法动作回执（error 不得回显隐藏数据，D7）；5s 自动清除 */}
      {state.lastError && (
        <div
          role="alert"
          data-testid="error-bar"
          className="mt-4 rounded-tile border border-danger/40 bg-danger/10 px-4 py-2.5 text-body text-danger"
        >
          {state.lastError}
        </div>
      )}

      {/* 阶段进度：提前结束的轮次标「跳过」，全下直发标「全下发牌」 */}
      <PhaseProgress steps={view.phaseSteps} handSeq={state.handSeq} runout={state.runout} />

      {/* 进度说明 + 最近动作（桌面并排，窄屏堆叠） */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div
          className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-panel border border-gold/15 bg-panel px-5 py-3 shadow-panel"
          data-testid="game-status"
          role="status"
        >
          <span className="font-serif text-body-lg text-gold-light">{view.statusTitle}</span>
          <span className="text-body text-muted">{view.statusDetail}</span>
          <span className="ml-auto text-body text-gold-light/80">{view.nextHint}</span>
        </div>
        <ActionHistory events={state.recentEvents} seats={state.seats} handSeq={state.handSeq} />
      </div>

      {/* 牌桌区：固定设计尺寸；窄屏只横向滚动牌桌，不缩放整页 */}
      <div className="overflow-x-auto">
        <div className="mx-auto w-[1260px]">
        <PokerTable
          seats={state.seats}
          mySeat={state.mySeat}
          turnSeat={state.turnSeat}
          emotes={state.emotes}
          tierNameOf={tierNameOf}
          pot={state.pot}
          currentBet={state.currentBet}
          seedCommit={state.seedCommit}
          seedReveal={state.seedReveal}
          community={state.community}
          autoReveal={state.autoReveal}
          canReveal={canReveal}
          revealRate={state.revealRate}
          onReveal={onReveal}
          myShowdownHand={myShowdownHand}
          showCover={showCover}
          revealCount={state.reveals.length}
          winnerSeat={winnerSeat}
          lastActionOf={lastActionOf}
          deadline={state.deadline}
          turnMs={state.turnMs}
        />
        </div>
      </div>

      {/* 自己的底牌：底部中央放大展示（私看揭示 / 亮一只） */}
      <div className="flex min-h-[150px] justify-center">
        <HoleCards
          myCards={state.myCards}
          autoReveal={state.autoReveal}
          canReveal={canReveal}
          revealRate={state.revealRate}
          onReveal={onReveal}
          myShowdownHand={myShowdownHand}
          showCover={showCover}
        />
      </div>

      {/* 操作区：本人回合按 legalActions 渲染；窄屏吸底并适配安全区 */}
      <div className="sticky bottom-0 z-20 -mx-3 mt-1 bg-ink/95 px-3 pb-[env(safe-area-inset-bottom)] pt-2 md:static md:mx-0 md:bg-transparent md:px-0 md:pb-0">
        {state.phase === 'waiting' ? (
          <div className="flex items-center gap-5 rounded-panel border border-gold/15 bg-panel px-6 py-4 shadow-panel">
            <div className="font-serif text-tier-name text-gold-light">
              {view.myReady ? '已准备，等待其他真人' : '等待全员准备'}
            </div>
            <span className="text-body text-muted">{view.readyProgress}</span>
            <Button
              className="ml-auto"
              variant="gold"
              icon="spark"
              disabled={!linkUp || view.myReady}
              loading={pending?.type === 'ready'}
              onClick={onReady}
            >
              准备开局
            </Button>
          </div>
        ) : inBetting ? (
          <ActionBar
            pot={state.pot}
            actions={view.actions}
            callAmount={state.callAmount}
            currentBet={state.currentBet}
            bigBlind={state.bigBlind}
            minRaiseTo={state.minRaiseTo}
            maxRaiseTo={state.maxRaiseTo}
            myChips={me?.chips ?? 0}
            isMyTurn={view.actionMode === 'myTurn' || view.actionMode === 'confirming' || view.actionMode === 'verifying'}
            turnNick={turnNick}
            pendingType={
              pending && pending.type !== 'ready' && pending.type !== 'leave' ? pending.type : null
            }
            pendingVerifying={view.actionMode === 'verifying'}
            deadline={view.actionMode === 'myTurn' ? state.deadline : null}
            turnMs={state.turnMs}
            serverOffset={offset}
            statusText={view.blockedReason}
            disabled={!linkUp}
            shortcutsLocked={resultVisible}
            resetKey={`${state.handSeq}:${state.phase}`}
            onAction={onAction}
          />
        ) : state.phase === 'showdown' || state.phase === 'settled' ? (
          <div className="flex items-center gap-5 rounded-panel border border-gold/15 bg-panel px-6 py-4 shadow-panel">
            <div className="font-serif text-tier-name text-gold-light">
              下一手 {state.nextHandAt != null ? `${nextHandRemaining} 秒后开始` : '待排程'}
            </div>
            <Button
              className="ml-auto"
              variant="gold"
              icon="spark"
              disabled={!linkUp || view.myReady}
              loading={pending?.type === 'ready'}
              onClick={onReady}
            >
              {view.myReady ? '已准备，等待其他玩家' : '准备下一手'}
            </Button>
          </div>
        ) : null}
      </div>
      </div>

      {/* 桌边浮窗：表情 + 聊天二合一（overlay，不占布局）；断线时输入禁用 */}
      <TableDock
        open={dockOpen}
        onClose={() => setDockOpen(false)}
        messages={chatLines}
        chatEnabled={state.chatEnabled}
        onSay={onSay}
        cooldownUntil={emoteCooldownUntil}
        onEmote={onEmote}
        disabled={!linkUp}
      />

      {/* 牌池抽屉（D17）：盒名单 + 牌池摘要（fallback 显著提示） */}
      <BoxDrawer open={poolOpen} onClose={() => setPoolOpen(false)} box={state.box} pool={state.pool} />

      {/* 顶级牌型全桌特效（合奏及以上，D15）：随 showdown 出现，2.8s 自隐 */}
      {state.showdown && winnerTier >= 7 && !celebrated && (
        <TierCelebration
          tier={winnerTier}
          tierName={TIER_NAMES[winnerTier] ?? `第 ${winnerTier} 级`}
          onDone={onCelebrationDone}
        />
      )}

      {/* 结算：本人优先摘要 + 折叠明细（A5.4 / 产品设计 §7）；ESC 关闭不发 ready，
          回顾模式只读上一手 lastResult，不改变参局状态 */}
      {resultVisible && shownSettled && (
        <ResultPanel
          showdown={
            reviewMode
              ? state.lastResult?.showdown?.length
                ? state.lastResult.showdown
                : null
              : state.showdown
          }
          settled={shownSettled}
          seats={state.seats}
          mySeat={state.mySeat}
          endReason={state.lastResult?.endReason}
          myReady={view.myReady}
          pendingReady={pending?.type === 'ready'}
          nextHandAt={reviewMode ? null : state.nextHandAt}
          nextHandPolicy={state.nextHandPolicy}
          serverOffset={offset}
          review={reviewMode}
          onReady={reviewMode ? undefined : onReady}
          onLeave={reviewMode ? undefined : onLeave}
          onClose={() => {
            setResultDismissed(true)
            setReviewOpen(false)
          }}
          returnFocusSelector='[data-testid="review-result"]'
          showCover={showCover}
        />
      )}
    </div>
  )
}

/** 阶段中文标签 */
function phaseLabel(phase: Phase): string {
  switch (phase) {
    case 'waiting':
      return '等待中'
    case 'preflop':
      return '翻牌前'
    case 'flop':
      return '翻牌圈'
    case 'turn':
      return '转牌圈'
    case 'river':
      return '河牌圈'
    case 'showdown':
      return '摊牌'
    case 'settled':
      return '结算'
    default:
      return '进行中'
  }
}

/** 路由 lazy chunk 默认导出（App.tsx React.lazy 消费） */
export default RoomPage

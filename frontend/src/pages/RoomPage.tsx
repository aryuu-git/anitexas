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
import { applyEvent, clearError, createRoomState, type RoomState } from '../api/roomState'
import { startMockDesk, type DeskTransport } from '../api/mockDesk'
import { NOTICE_TTL_MS, PENDING_CONFIRM_MS, useAutoExpire } from '../hooks/useAutoExpire'
import { useCountdown } from '../hooks/useCountdown'
import { useRoomSocket, WS_MAX_RETRIES } from '../hooks/useRoomSocket'
import { useSound } from '../hooks/useSound'
import { useStageScale } from '../hooks/useStageScale'
import { ActionBar } from '../components/controls/ActionBar'
import { type ChatLine } from '../components/ChatPanel'
import { HoleCards } from '../components/HoleCards'
import { BoxDrawer } from '../components/table/BoxDrawer'
import { PokerTable } from '../components/table/PokerTable'
import { ResultPanel } from '../components/ResultPanel'
import { TableDock } from '../components/TableDock'
import { TierCelebration } from '../components/TierCelebration'
import { Button } from '../components/ui/Button'
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

/** 对局桌舞台设计尺寸（固定排版后等比缩放到视口，保证一页显示） */
const STAGE_W = 1300
const STAGE_H = 960

export function RoomPage() {
  const { code = '' } = useParams()
  const nav = useLocation()
  const navigate = useNavigate()
  const navState = nav.state as RoomNavState | null
  const config: RoomConfig = { ...DEFAULT_CONFIG, ...navState }

  const [state, setState] = useState<RoomState>(createRoomState)
  const [pendingType, setPendingType] = useState<ActionType | null>(null)

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
  // 舞台缩放：一页显示（窄屏/矮屏整体等比缩小；视口小于舞台时外层可滚动）
  const scale = useStageScale(STAGE_W, STAGE_H)
  // 移动端兜底：<768px 提示横屏/大屏
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768)
  useEffect(() => {
    const compute = () => setNarrow(window.innerWidth < 768)
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [])

  // 入座 ticket：大厅 REST join 回执优先；刷新/深链时本页补做 REST join（同昵称复用座位）
  const [ticket, setTicket] = useState<string | null>(navState?.ticket ?? null)
  const [joinError, setJoinError] = useState<string | null>(null)
  useEffect(() => {
    if (USE_MOCK || ticket) return
    let alive = true
    joinRoom(code, config.nick)
      .then((r) => {
        if (alive) setTicket(r.ticket)
      })
      .catch((e: unknown) => {
        if (alive) setJoinError(e instanceof ApiClientError ? e.message : '入座失败（后端未就绪？可设 VITE_USE_MOCK=1 走演示桌）')
      })
    return () => {
      alive = false
    }
  }, [code, config.nick, ticket])

  // 事件入口：信封归约（useRoomSocket 与 mock 桌面共用同一入口）+ 轻音效
  const onEvent = useCallback((e: Envelope) => {
    setState((s) => applyEvent(s, e))
    if (e.t === 'acted' || e.t === 'error' || e.t === 'snapshot') setPendingType(null)
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
  const { send: wsSend, connected, retries } = useRoomSocket(USE_MOCK ? null : WS_URL, join, onEvent)

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

  // ===== 连接态（断线体验）：明确文案；未连接时输入一律禁用 =====
  const linkUp = USE_MOCK || connected
  const connLabel = USE_MOCK
    ? '本地演示桌（mock）'
    : connected
      ? '已连接'
      : retries >= WS_MAX_RETRIES
        ? '连接失败请刷新'
        : retries > 0
          ? `重连中(${retries})`
          : ticket
            ? '连接中…'
            : '入座中…'

  /** ready：waiting 开局 / settled 提前开下一手（局中被服务端忽略） */
  const onReady = useCallback(() => send({ t: 'ready', p: {} }), [send])

  /** 离开：发 leave 后回大厅 */
  const onLeave = useCallback(() => {
    send({ t: 'leave', p: {} })
    navigate('/')
  }, [send, navigate])

  // pendingType 5s 未获服务端确认：自动解锁并提示「服务端未确认」
  useAutoExpire(pendingType, PENDING_CONFIRM_MS, () => {
    setPendingType(null)
    setState((s) => ({ ...s, lastError: '服务端未确认' }))
  })
  // 错误提示 5s 自动清除
  useAutoExpire(state.lastError, NOTICE_TTL_MS, () => setState(clearError))
  // ESC 关面板只影响当前这手；新结算/新一手自动放回
  useEffect(() => setResultDismissed(false), [state.settled])

  // ===== 派生态 =====
  const me = state.seats.find((s) => s.seat === state.mySeat)
  const toCall = Math.max(0, state.currentBet - (me?.bet ?? 0))
  const inBetting = BETTING_PHASES.includes(state.phase)
  /** 下一手自动开局倒计时（秒，nextHand.startAt） */
  const nextHandRemaining = useCountdown(state.nextHandAt)
  const isMyTurn = inBetting && state.turnSeat === state.mySeat && !(me?.folded ?? true)
  const canReveal = inBetting && !(me?.folded ?? true)
  // 当前行动者昵称（非本方回合时指明「轮到谁」，不让人猜）
  const turnNick = state.seats.find((s) => s.seat === state.turnSeat)?.nick ?? null
  const myShowdownHand = state.showdown?.find((h) => h.seat === state.mySeat) ?? null

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
      setPendingType(type)
      send({ t: 'action', p: { type, amount } })
    },
    [send],
  )

  /** 揭示动作（稳定引用，配合 HandBoard/CardFace 的 React.memo） */
  const onReveal = useCallback(
    (card: CardData, scope: RevealScope) => send({ t: 'reveal', p: { cardId: card.id, scope } }),
    [send],
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

  return (
    // 舞台 + 等比缩放：整页按设计尺寸排版后按视口缩放；视口小于舞台时外层可滚动（移动端兜底）
    <div className="relative flex h-[100dvh] w-full overflow-auto">
      {/* 窄屏提示条：<768px 建议横屏或大屏体验 */}
      {narrow && (
        <div className="fixed inset-x-0 top-0 z-modal border-b border-gold/25 bg-ink-deep/95 px-4 py-2 text-center text-micro text-gold-light">
          建议横屏或大屏体验
        </div>
      )}
      {/* 尺寸占位（= 舞台 × 缩放）：让滚动条按视觉尺寸出现 */}
      <div className="relative m-auto shrink-0" style={{ width: STAGE_W * scale, height: STAGE_H * scale }}>
      <div
        className="absolute left-0 top-0 flex flex-col justify-center"
        data-testid="stage"
        style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})`, transformOrigin: 'top left' }}
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

      {/* 牌桌区：桌心公告牌 + 四周座位（固定设计尺寸，随舞台等比缩放） */}
      <div className="mt-3 flex justify-center">
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

      {/* 自己的底牌：底部中央放大展示（私看揭示 / 亮一只） */}
      <div className="mt-3 flex min-h-[230px] justify-center">
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

      {/* 当前回合（信息层级最高）：下注条 / 准备开局 / 下一手倒计时 */}
      <div className="mt-3 min-h-[72px]">
        {state.phase === 'waiting' ? (
          <div className="flex items-center gap-5 rounded-panel border border-gold/15 bg-panel px-6 py-4 shadow-panel">
            <div className="font-serif text-tier-name text-gold-light">等待全员准备</div>
            <Button className="ml-auto" variant="gold" icon="spark" disabled={!linkUp} onClick={onReady}>
              准备开局
            </Button>
          </div>
        ) : inBetting ? (
          <ActionBar
            pot={state.pot}
            toCall={toCall}
            currentBet={state.currentBet}
            bigBlind={state.bigBlind}
            minRaise={state.minRaise}
            myChips={me?.chips ?? 0}
            isMyTurn={isMyTurn}
            turnNick={turnNick}
            pendingType={pendingType}
            deadline={isMyTurn ? state.deadline : null}
            turnMs={state.turnMs}
            disabled={!linkUp}
            resetKey={`${state.handSeq}:${state.phase}`}
            onAction={onAction}
          />
        ) : state.phase === 'showdown' || state.phase === 'settled' ? (
          <div className="flex items-center gap-5 rounded-panel border border-gold/15 bg-panel px-6 py-4 shadow-panel">
            <div className="font-serif text-tier-name text-gold-light">
              下一手 {state.nextHandAt != null ? `${nextHandRemaining} 秒后开始` : '待排程'}
            </div>
            <Button className="ml-auto" variant="gold" icon="spark" disabled={!linkUp} onClick={onReady}>
              立即开始
            </Button>
          </div>
        ) : null}
      </div>
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

      {/* 结算：摊牌对比 + 筹码与积分明细（A5.4，浮层）；ESC 关面板不发 ready */}
      {(state.phase === 'showdown' || state.phase === 'settled') && state.settled && !resultDismissed && (
        <ResultPanel
          showdown={state.showdown}
          settled={state.settled}
          seats={state.seats}
          mySeat={state.mySeat}
          onReady={onReady}
          onLeave={onLeave}
          onClose={() => setResultDismissed(true)}
          nextHandAt={state.nextHandAt}
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

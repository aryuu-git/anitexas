import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ApiClientError,
  createRoom,
  joinRoom,
  listRooms,
  type RoomSummary,
} from '../api/client'
import type { DeckStrategy, ThemeFilter } from '../api/types'
import { DeckStrategyField } from '../components/DeckStrategyField'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icons'
import { Panel, SectionHead } from '../components/ui/Panel'

/**
 * 大厅页（A5.1）：樱墨渐变 hero + 建房 / 房间码加入 / 房间列表。
 * v1 无账号（D9）：房间码 + 昵称；建房配置 = 模式（明示/隐藏）/ 盲注 / 座位数 / 揭示费率。
 * 表单分层：首屏 = 昵称 + 快速建局预设 + 盲注 + 揭示方式；微调项收进「高级设置」折叠区。
 * 数据面：真实模式走 REST（client.ts）；VITE_USE_MOCK=1 走本地假数据（离线演示）。
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

/** 快速建局预设：一键套用盲注/座位/揭示方式/费率，其余项仍可在高级设置微调 */
interface RoomPreset {
  key: 'casual' | 'standard'
  name: string
  desc: string
  smallBlind: number
  bigBlind: number
  seats: number
  /** 隐藏揭示（D14 默认）：要素点击展开攒信息差 */
  autoReveal: boolean
  revealRate: number
}

/** 两档预设（休闲 / 标准），均为隐藏揭示 + 费率 0 */
const ROOM_PRESETS: RoomPreset[] = [
  {
    key: 'casual',
    name: '休闲',
    desc: '4 座 · 盲注 1/2 · 隐藏揭示 · 费率 0',
    smallBlind: 1,
    bigBlind: 2,
    seats: 4,
    autoReveal: false,
    revealRate: 0,
  },
  {
    key: 'standard',
    name: '标准',
    desc: '6 座 · 盲注 5/10 · 隐藏揭示 · 费率 0',
    smallBlind: 5,
    bigBlind: 10,
    seats: 6,
    autoReveal: false,
    revealRate: 0,
  },
]

/** mock 模式的固定房表（离线演示） */
const MOCK_ROOMS: RoomSummary[] = [
  { code: 'SAKURA', host: '墨镜', autoReveal: false, smallBlind: 1, bigBlind: 2, seats: 6, players: 3, revealRate: 0 },
  { code: 'KOHAKU', host: '樱', autoReveal: true, smallBlind: 5, bigBlind: 10, seats: 4, players: 1, revealRate: 0 },
  { code: 'SUMI01', host: '老K', autoReveal: false, smallBlind: 2, bigBlind: 5, seats: 6, players: 5, revealRate: 0 },
]

/** 房间列表三态：加载中 / 就绪（可为空）/ 失败（独立错误通道） */
type RoomsStatus = 'loading' | 'ready' | 'error'

export function LobbyPage() {
  const navigate = useNavigate()
  // 建房表单
  const [nick, setNick] = useState('')
  const [autoReveal, setAutoReveal] = useState(false)
  const [smallBlind, setSmallBlind] = useState(1)
  const [bigBlind, setBigBlind] = useState(2)
  const [seats, setSeats] = useState(6)
  const [revealRate, setRevealRate] = useState(0)
  // 默认只收标注数（评分人数）≥2000 的作品：认得出作品的人不用花钱（核心玩法前提）
  const [minVotes, setMinVotes] = useState(2000)
  const [deckStrategy, setDeckStrategy] = useState<DeckStrategy>('stratified')
  const [themeFilter, setThemeFilter] = useState<ThemeFilter>({ kind: 'company', value: '' })
  const [chatEnabled, setChatEnabled] = useState(true)
  // 高级设置折叠区（默认收起）
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // 加入表单
  const [joinCode, setJoinCode] = useState('')
  // 房间列表（三态）+ 建房/加入表单错误回执
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [roomsStatus, setRoomsStatus] = useState<RoomsStatus>('loading')
  const [listError, setListError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const config: RoomConfig = {
    nick: nick.trim() || '牌手',
    autoReveal,
    smallBlind,
    bigBlind,
    seats,
    revealRate,
    minVotes,
    deckStrategy,
    themeFilter,
    chatEnabled,
  }

  // 房间列表：真实模式拉 REST；mock 模式用固定房表
  useEffect(() => {
    if (USE_MOCK) {
      setRooms(MOCK_ROOMS)
      setRoomsStatus('ready')
      return
    }
    listRooms()
      .then((rs) => {
        setRooms(rs)
        setRoomsStatus('ready')
      })
      .catch((e: unknown) => {
        setListError(e instanceof ApiClientError ? e.message : '房间列表加载失败（后端未就绪？）')
        setRoomsStatus('error')
      })
  }, [])

  /** 快速建局：一键套用预设（盲注/座位/揭示方式/费率），其余项保留当前值 */
  const applyPreset = (preset: RoomPreset) => {
    setSmallBlind(preset.smallBlind)
    setBigBlind(preset.bigBlind)
    setSeats(preset.seats)
    setAutoReveal(preset.autoReveal)
    setRevealRate(preset.revealRate)
  }

  /** 入桌跳转（ticket 来自 REST join 回执，喂 WS join 握手） */
  const enterRoom = (code: string, cfg: RoomConfig, ticket?: string, seat?: number) => {
    // 预热对局桌 lazy chunk（与 App 的 React.lazy 同模块）：避免导航后才二次拉 chunk 的「载入中…」停顿。
    void import('./RoomPage')
    navigate(`/room/${code}`, { state: { ...cfg, ticket, seat } satisfies RoomNavState })
  }

  /** 建房：REST createRoom → 原地跳转（对局桌内做 REST join 拿 ticket，刷新可重入） */
  const onCreate = async (e: FormEvent) => {
    e.preventDefault()
    setFormError(null)
    if (USE_MOCK) {
      enterRoom(Math.random().toString(36).slice(2, 8).toUpperCase(), config)
      return
    }
    setSubmitting(true)
    try {
      const room = await createRoom({
        nick: config.nick,
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
      enterRoom(room.code, config)
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : '建房失败，请检查后端是否可用')
    } finally {
      setSubmitting(false)
    }
  }

  /** 加入：REST join 拿一次性 ticket（顺带校验房间码）→ 跳转 */
  const onJoin = async (e: FormEvent) => {
    e.preventDefault()
    setFormError(null)
    const code = joinCode.trim().toUpperCase()
    if (!code) return
    if (USE_MOCK) {
      enterRoom(code, config)
      return
    }
    setSubmitting(true)
    try {
      const joined = await joinRoom(code, config.nick)
      enterRoom(joined.room.code, config, joined.ticket, joined.seat)
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : '加入失败，请检查房间码')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-content px-8 pb-20">
      {/* Hero：左基准线 + 右侧牌面装饰（rules.html hero 同构） */}
      <header className="flex items-center justify-between gap-10 pb-9 pt-[72px]">
        <div>
          <div className="text-kicker text-gold-foil">A N I T E X A S</div>
          <h1 className="mt-3.5 font-serif text-display text-gold-light">动画德州</h1>
          <div className="mt-4 h-px w-[140px] bg-gold-fade" />
          <p className="mt-5 max-w-[560px] text-body-lg text-muted">
            一部动画一张牌，评分比大小、要素凑羁绊。十级牌型，七选五摊牌——
            认得出作品的人，不用花钱。
          </p>
        </div>
        {/* 扇面牌装饰（生成封面同源视觉，D10） */}
        <div className="relative hidden h-[190px] w-[320px] flex-none lg:block" aria-hidden="true">
          <FanCard char="紫" left={0} rotate={-9} />
          <FanCard char="凉" left={96} rotate={0} />
          <FanCard char="命" left={192} rotate={9} />
        </div>
      </header>

      {/* 建房/加入表单错误回执（REST {code,msg}；房间列表错误走独立通道） */}
      {formError && (
        <div
          data-testid="form-error"
          className="mb-4 rounded-tile border border-danger/40 bg-danger/10 px-4 py-2.5 text-body text-danger"
        >
          {formError}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 建房 */}
        <Panel accent>
          <SectionHead kicker="CREATE" title="建房" desc="揭示方式一个开关定：开局自动展开，或要素点击展开攒信息差。" />
          <form onSubmit={onCreate} className="flex flex-col gap-5">
            <Field label="昵称">
              <input
                value={nick}
                onChange={(e) => setNick(e.target.value)}
                placeholder="怎么称呼你"
                maxLength={12}
                className="w-full rounded-tile border border-gold/20 bg-ink-deep/40 px-3.5 py-2.5 text-body-lg text-gold-light outline-none placeholder:text-muted/50 focus:border-gold/60"
              />
            </Field>

            {/* 快速建局：两档预设一键套用（仍可在高级设置微调） */}
            <FieldGroup label="快速建局">
              <div className="flex gap-2.5">
                {ROOM_PRESETS.map((preset) => (
                  <Button
                    key={preset.key}
                    type="button"
                    variant="outline"
                    className="flex-1"
                    data-testid={`preset-${preset.key}`}
                    onClick={() => applyPreset(preset)}
                  >
                    <span className="block text-left">
                      <span className="block font-serif text-card-name text-gold-light">{preset.name}</span>
                      <span className="block text-micro text-muted">{preset.desc}</span>
                    </span>
                  </Button>
                ))}
              </div>
            </FieldGroup>

            <Field label="小盲 / 大盲">
              <div className="flex items-center gap-2">
                <NumberInput value={smallBlind} min={1} onChange={setSmallBlind} ariaLabel="小盲" />
                <span className="text-muted">/</span>
                <NumberInput value={bigBlind} min={2} onChange={setBigBlind} ariaLabel="大盲" />
              </div>
            </Field>

            <FieldGroup label="揭示方式">
              <SwitchCard
                checked={autoReveal}
                onChange={setAutoReveal}
                title="开局自动展开要素"
                desc={autoReveal ? '所有牌开局即揭示（原明示体验）' : '默认关闭：要素点击展开，预留扣分（D4）'}
              />
            </FieldGroup>

            {/* 高级设置：微调项折叠区（默认收起） */}
            <div className="flex flex-col gap-5">
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
                  <Field label="座位数">
                    <NumberInput value={seats} min={2} max={9} onChange={setSeats} ariaLabel="座位数" />
                  </Field>

                  <Field label="揭示费率（积分/次）">
                    <NumberInput value={revealRate} min={0} onChange={setRevealRate} ariaLabel="揭示费率" />
                    <p className="mt-1.5 text-micro text-muted">v1 费率 0：只记账不扣分（D4）</p>
                  </Field>

                  <Field label="最低标注数">
                    <NumberInput value={minVotes} min={0} onChange={setMinVotes} ariaLabel="最低标注数" />
                    <p className="mt-1.5 text-micro text-muted">
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

            <Button type="submit" variant="gold" size="lg" icon="spark" loading={submitting}>
              创建房间
            </Button>
          </form>
        </Panel>

        <div className="flex flex-col gap-4">
          {/* 房间码加入 */}
          <Panel accent>
            <SectionHead kicker="JOIN" title="房间码加入" />
            <form onSubmit={onJoin} className="flex flex-col gap-4">
              <Field label="房间码">
                <input
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  placeholder="6 位房间码"
                  maxLength={6}
                  className="w-full rounded-tile border border-gold/20 bg-ink-deep/40 px-3.5 py-2.5 font-serif text-tier-name tracking-[.3em] text-gold-light outline-none placeholder:tracking-normal placeholder:text-muted/50 focus:border-gold/60"
                />
              </Field>
              <Button
                type="submit"
                variant="outline"
                icon="arrow"
                loading={submitting}
                disabled={joinCode.trim().length === 0}
              >
                加入对局
              </Button>
            </form>
          </Panel>

          {/* 房间列表（loading / 空态 / 错误三态分离） */}
          <Panel>
            <SectionHead kicker="TABLES" title="开放牌桌" />
            {roomsStatus === 'loading' && (
              <div data-testid="rooms-loading" className="flex flex-col gap-2.5">
                <div className="text-micro text-muted">加载中…</div>
                <div className="h-[58px] animate-pulse rounded-tile border border-gold/10 bg-ink-deep/40" />
                <div className="h-[58px] animate-pulse rounded-tile border border-gold/10 bg-ink-deep/40" />
              </div>
            )}
            {roomsStatus === 'error' && (
              <div
                data-testid="room-list-error"
                role="alert"
                className="rounded-tile border border-danger/40 bg-danger/10 px-4 py-2.5 text-body text-danger"
              >
                {listError}
              </div>
            )}
            {roomsStatus === 'ready' &&
              (rooms.length === 0 ? (
                <div
                  data-testid="rooms-empty"
                  className="rounded-tile border border-gold/15 bg-ink-deep/40 px-4 py-6 text-center text-body text-muted"
                >
                  暂无房间，建一个吧
                </div>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {rooms.map((room) => (
                    <li key={room.code}>
                      <RoomRow
                        room={room}
                        onEnter={() =>
                          enterRoom(room.code, {
                            ...config,
                            autoReveal: room.autoReveal,
                            smallBlind: room.smallBlind,
                            bigBlind: room.bigBlind,
                            seats: room.seats,
                          })
                        }
                      />
                    </li>
                  ))}
                </ul>
              ))}
          </Panel>
        </div>
      </div>
    </div>
  )
}

/** hero 扇面牌（rules.html .fc 同款视觉） */
function FanCard({ char, left, rotate }: { char: string; left: number; rotate: number }) {
  return (
    <div
      className="absolute top-2.5 flex h-[176px] w-[128px] items-center justify-center rounded-card border border-gold-foil/45 bg-card-body font-serif text-5xl text-gold-light/85 shadow-fan"
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

/** 数字输入（盲注/座位/费率通用） */
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
 * 揭示方式 / 牌桌聊天共用，消除两份 className 复制。
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
        <span className="block text-micro text-muted">{desc}</span>
      </span>
    </button>
  )
}

/**
 * 房间列表行：整行可点的富行卡片（图标 + 两行文本 + 箭头），
 * 非按钮形控件、ui/Button 的 inline-flex/居中/nowrap 基类不适用，抽成小组件单点维护五态样式。
 */
function RoomRow({ room, onEnter }: { room: RoomSummary; onEnter: () => void }) {
  return (
    <button
      type="button"
      onClick={onEnter}
      className="flex w-full items-center gap-4 rounded-tile border border-gold/15 bg-ink-deep/45 px-4 py-3 text-left transition-[transform,border-color,background-color,box-shadow,opacity] duration-fast ease-standard hover:-translate-y-px hover:border-gold/40 hover:shadow-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70"
    >
      <Icon name="cards" className="text-gold-foil" />
      <div className="flex-1">
        <div className="font-serif text-card-name text-gold-light">
          {room.code}
          <span className="ml-2 text-micro text-muted">{room.host} 的桌</span>
        </div>
        <div className="text-micro text-muted">
          {room.autoReveal ? '开局自动展开' : '手动揭示'} · 盲注 {room.smallBlind}/{room.bigBlind} ·{' '}
          {room.players}/{room.seats} 人
        </div>
      </div>
      <Icon name="arrow" className="text-gold-foil" />
    </button>
  )
}

/** 路由 lazy chunk 默认导出（App.tsx React.lazy 消费） */
export default LobbyPage

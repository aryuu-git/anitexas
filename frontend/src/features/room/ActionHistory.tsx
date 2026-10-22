import type { ExperienceEvent, SeatState } from '../../api/types'

/**
 * 最近动作历史（对局页常驻）：最近 3 条公开过程，按手分组。
 * 只渲染服务端按视角过滤后的事件（私看/dealt 等不上历史）；
 * 文案只用真实动作名与本次投入，不推断行动次序。
 */
export interface ActionHistoryProps {
  events: ExperienceEvent[]
  seats: SeatState[]
  /** 当前手（用于标记「当前」） */
  handSeq: number
}

/** 可进入文字历史的公开事件 */
const PUBLIC_KINDS = new Set<ExperienceEvent['kind']>([
  'blind_posted',
  'acted',
  'flop',
  'turn',
  'river',
  'showdown',
  'settled',
  'readied',
])

const STREET_LABELS: Record<string, string> = {
  flop: '翻牌圈',
  turn: '转牌圈',
  river: '河牌圈',
}

function numberIn(payload: Record<string, unknown> | undefined, key: string): number {
  const v = payload?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function describe(ev: ExperienceEvent, nickOf: (seat: number | null) => string): string {
  switch (ev.kind) {
    case 'blind_posted':
      return `${nickOf(ev.seat)} 盲注 ${numberIn(ev.payload, 'amount')}`
    case 'acted': {
      const type = String(ev.payload?.type ?? '')
      const amount = numberIn(ev.payload, 'amount')
      const nick = nickOf(ev.seat)
      switch (type) {
        case 'fold':
          return `${nick} 弃牌`
        case 'check':
          return `${nick} 过牌`
        case 'call':
          return `${nick} 跟注 ${amount}`
        case 'bet':
          return `${nick} 下注 ${amount}`
        case 'raise':
          return `${nick} 加注 ${amount}`
        case 'allin':
          return `${nick} 全下 ${amount}`
        default:
          return `${nick} 行动`
      }
    }
    case 'flop':
    case 'turn':
    case 'river':
      return STREET_LABELS[ev.kind] ?? '进入下一轮'
    case 'readied':
      return `${nickOf(ev.seat)} 已准备`
    case 'showdown':
      return '摊牌比较'
    case 'settled':
      return '本手结算'
    default:
      return ''
  }
}

export function ActionHistory({ events, seats, handSeq }: ActionHistoryProps) {
  const recent = events.filter((e) => PUBLIC_KINDS.has(e.kind)).slice(-3)
  const nickOf = (seat: number | null) =>
    seat == null ? '全桌' : seats.find((s) => s.seat === seat)?.nick || `座位 ${seat}`

  const groups: { handSeq: number; lines: string[] }[] = []
  for (const ev of recent) {
    const line = describe(ev, nickOf)
    if (!line) continue
    const last = groups[groups.length - 1]
    if (last && last.handSeq === ev.handSeq) last.lines.push(line)
    else groups.push({ handSeq: ev.handSeq, lines: [line] })
  }

  return (
    <div
      className="rounded-panel border border-gold/15 bg-panel px-4 py-3 shadow-panel"
      data-testid="action-history"
      aria-label="最近动作"
    >
      <h2 className="text-tiny tracking-[.25em] text-gold-foil">最近动作</h2>
      {groups.length === 0 ? (
        <p className="mt-2 text-body text-muted">本手暂无公开动作。</p>
      ) : (
        <ol className="mt-2 flex flex-col gap-1.5">
          {groups.map((g) => (
            <li key={g.handSeq}>
              <div className="text-micro text-muted">
                第 {g.handSeq} 手{g.handSeq === handSeq ? '（当前）' : ''}
              </div>
              <ul className="flex flex-col gap-0.5">
                {g.lines.map((line, i) => (
                  <li key={i} className="text-body text-gold-light/85" data-testid="history-item">
                    {line}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

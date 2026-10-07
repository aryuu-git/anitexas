import { CardBack } from '../card/CardBack'

/**
 * 弃牌堆（muck）：桌面一侧的小牌堆，展示已弃牌数量。
 */
export function Muck({ count = 0 }: { count?: number }) {
  if (count <= 0) return null
  return (
    <div className="flex items-center gap-2" data-testid="muck">
      <span className="relative inline-flex">
        {Array.from({ length: Math.min(count, 3) }, (_, i) => (
          <CardBack key={i} className={i > 0 ? '-ml-3' : ''} style={{ transform: `rotate(${i * 7 - 7}deg)` }} />
        ))}
      </span>
      <span className="text-micro text-muted">弃牌 {count}</span>
    </div>
  )
}

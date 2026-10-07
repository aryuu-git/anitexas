/**
 * 金箔扫光层：叠在牌面上的一道光带（高档位/高评分牌面用）。
 * 纯装饰，pointer-events-none；reduced-motion 下动画被全局关闭。
 */
export function CardFoil({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-card" aria-hidden="true">
      <span className="animate-foil absolute inset-y-0 -left-1/2 w-1/3 bg-gradient-to-r from-transparent via-gold-foil/25 to-transparent" />
    </span>
  )
}

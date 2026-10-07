/**
 * 庄家按钮（Dealer button）：一枚小圆片 D，贴在自己座位一侧。
 */
export function DealerButton({ className = '' }: { className?: string }) {
  return (
    <span
      data-testid="dealer-button"
      title="庄位"
      className={`inline-flex h-5 w-5 items-center justify-center rounded-chip border border-gold-foil/60 bg-gold-foil/20 font-serif text-micro text-gold-foil shadow-avatar ${className}`}
    >
      D
    </span>
  )
}

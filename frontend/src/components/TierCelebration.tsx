import { useEffect } from 'react'

/**
 * 顶级牌型全桌特效（D15）：胜者牌型在「合奏」及以上（tier ≥ 7）时，
 * 金幕 + 星屑扫过全桌，中央亮牌型名。2.8s 自行淡出（reduced-motion 静态展示）。
 */
export interface TierCelebrationProps {
  tier: number
  tierName: string
  /** 特效结束（组件随后可卸载） */
  onDone: () => void
}

/** 星屑位置（确定性伪随机，避免每次渲染跳动） */
const SPARKS = Array.from({ length: 12 }, (_, i) => ({
  left: `${(i * 83) % 97}%`,
  delay: `${(i % 5) * 0.18}s`,
  size: 6 + ((i * 7) % 10),
}))

export function TierCelebration({ tier, tierName, onDone }: TierCelebrationProps) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, 2800)
    return () => window.clearTimeout(timer)
  }, [onDone])

  return (
    <div
      className="tier-veil pointer-events-none fixed inset-0 z-overlay flex items-center justify-center"
      role="status"
      aria-label={`${tierName} 全桌特效`}
    >
      {/* 金幕（radial 光斑，token 驱动） */}
      <div className="absolute inset-0 bg-glow-radial opacity-25" aria-hidden="true" />

      {/* 星屑 */}
      {SPARKS.map((s, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="tier-spark absolute top-[12%] rounded-chip bg-gold-foil/70"
          style={{ left: s.left, animationDelay: s.delay, height: s.size, width: s.size }}
        />
      ))}

      <div className="relative text-center">
        <div className="font-serif text-display text-gold-foil drop-shadow-[0_0_18px_rgba(212,167,106,0.35)]">
          {tierName}
        </div>
        <div className="mt-2 text-body-lg text-gold-light">第 {tier} 级</div>
      </div>
    </div>
  )
}

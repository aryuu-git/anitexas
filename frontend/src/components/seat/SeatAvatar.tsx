import { avatarGradient, initialOf } from '../tableLayout'

/**
 * 头像徽章：生成式头像——名字首字 + 樱花渐变底（按座位号确定性取色）。
 * 后续接入真实封面图时，只需替换内层内容。
 */
export interface SeatAvatarProps {
  nick: string
  seat: number
  /** 直径（px） */
  size?: number
  className?: string
}

export function SeatAvatar({ nick, seat, size = 64, className = '' }: SeatAvatarProps) {
  const inner = Math.round(size * 0.78)
  return (
    <span
      data-testid="seat-avatar"
      className={`relative flex items-center justify-center rounded-chip border border-gold-foil/35 shadow-avatar ${className}`}
      style={{ width: size, height: size, backgroundImage: avatarGradient(seat) }}
    >
      {/* 内环 + 高光，增强"徽章"质感 */}
      <span
        className="pointer-events-none absolute rounded-chip border border-gold-light/25"
        style={{ width: size - 5, height: size - 5 }}
        aria-hidden="true"
      />
      <span
        className="flex items-center justify-center rounded-chip bg-ink-deep/35 font-serif text-gold-light"
        style={{ width: inner, height: inner, fontSize: Math.round(size * 0.42) }}
      >
        {initialOf(nick)}
      </span>
    </span>
  )
}

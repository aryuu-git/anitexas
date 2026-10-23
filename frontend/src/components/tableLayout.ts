/**
 * 牌桌 v2 布局与主题：椭圆投影（座位位置/角度/朝向）、注堆方向、筹码面额分层、头像配色。
 * 纯函数、无副作用——供 PokerTable/PlayerSeat 使用，也便于单测。
 */

/** 椭圆横/纵半径（相对桌容器的百分比）；座位略压桌沿。 */
export const TABLE_RX = 43
export const TABLE_RY = 40

/** 桌容器设计尺寸（宽 × 高，px）：压到 1366×768 首屏可容纳的桌面比例。 */
export const TABLE_W = 1120
export const TABLE_H = 480

/** 座位 index → 相对桌容器的百分比坐标 {x,y}（0–100）；mySeat 恒在正下方（θ=90°）。 */
export function seatPosition(index: number, mySeat: number, total: number): { x: number; y: number } {
  if (total <= 0) return { x: 50, y: 50 }
  const theta = Math.PI / 2 + ((index - mySeat) * 2 * Math.PI) / total
  return {
    x: 50 + TABLE_RX * Math.cos(theta),
    y: 50 + TABLE_RY * Math.sin(theta),
  }
}

/** 座位角度（度）：0 = 右侧（3 点钟），顺时针为正；mySeat 恒在正下方（90°）。 */
export function seatAngle(index: number, mySeat: number, total: number): number {
  if (total <= 0) return 90
  return (90 + ((index - mySeat) * 360) / total) % 360
}

/**
 * 座位朝向：1 = 正立（近侧/下方），-1 = 转向 180°（远侧，位于桌心上方）。
 * 屏幕坐标 y 轴向下：sin(θ) < 0 即座位在中心上方 → 需转身，让牌背/注堆朝桌心。
 */
export function seatFacing(index: number, mySeat: number, total: number): 1 | -1 {
  const theta = (seatAngle(index, mySeat, total) * Math.PI) / 180
  return Math.sin(theta) < -0.06 ? -1 : 1
}

/**
 * 注堆落点：从座位朝桌心的百分比位移（已按下注线收缩 pull）。
 * 座位相对中心的偏移为 (cosθ, sinθ)，朝中心取反。
 */
export function betOffset(
  index: number,
  mySeat: number,
  total: number,
  pull = 0.36,
): { dx: number; dy: number } {
  if (total <= 0) return { dx: 0, dy: -1 }
  const theta = (seatAngle(index, mySeat, total) * Math.PI) / 180
  return { dx: -Math.cos(theta) * TABLE_RX * pull, dy: -Math.sin(theta) * TABLE_RY * pull }
}

/** 筹码面额（从大到小）。 */
export const CHIP_DENOMS = [500, 100, 25, 5, 1] as const

/** 金额 → 面额分层（最多 maxLayers 层，币值降序），供 ChipStack 画筹码堆。 */
export function chipLayers(amount: number, maxLayers = 5): { denom: number; count: number }[] {
  let rest = Math.max(0, Math.floor(amount))
  const out: { denom: number; count: number }[] = []
  for (const denom of CHIP_DENOMS) {
    if (rest < denom) continue
    const count = Math.floor(rest / denom)
    rest -= count * denom
    out.push({ denom, count: Math.min(count, 9) })
    if (out.length >= maxLayers) break
  }
  return out
}

/** 头像渐变（按座位号确定性取色；只用 token，不出现裸色值）。 */
const AVATAR_PALETTE = [
  'linear-gradient(160deg, rgb(var(--color-gold) / 0.85), rgb(var(--color-surface-elevated)))',
  'linear-gradient(160deg, rgb(var(--color-gold-foil) / 0.85), rgb(var(--color-surface)))',
  'linear-gradient(160deg, rgb(var(--color-gold-light) / 0.8), rgb(var(--color-ink-deep)))',
  'linear-gradient(160deg, rgb(var(--color-muted) / 0.85), rgb(var(--color-surface)))',
]

export function avatarGradient(seat: number): string {
  return AVATAR_PALETTE[Math.abs(seat) % AVATAR_PALETTE.length]
}

/** 昵称首字（头像内文字）。 */
export function initialOf(nick: string): string {
  const t = (nick || '').trim()
  if (!t) return '?'
  const first = t.replace(/^bot[·.\-]?/i, '')
  return (first[0] ?? t[0]).toUpperCase()
}

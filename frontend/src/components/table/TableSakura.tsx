/**
 * 桌心印记：樱墨徽记——五瓣樱花 + ANITEXAS 字样，低透明度压印在毡面上。
 * 只用 token 变量上色（无裸色值）。
 */
export function TableSakura({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 200" className={className} aria-hidden="true" focusable="false">
      <g fill="rgb(var(--color-gold-foil))" opacity="0.5">
        {[0, 72, 144, 216, 288].map((deg) => (
          <ellipse
            key={deg}
            cx="100"
            cy="62"
            rx="20"
            ry="34"
            transform={`rotate(${deg} 100 100)`}
          />
        ))}
      </g>
      <circle cx="100" cy="100" r="13" fill="rgb(var(--color-gold-light))" opacity="0.6" />
    </svg>
  )
}

import { TableSakura } from './TableSakura'

/**
 * 毡面（v2）：顶亮底暗的径向渐变 + 织物噪点（SVG feTurbulence，低透明度）+
 * 中央桌印（樱墨徽记）+ 内凹阴影。盖在 TableRail 之上，留下的环即桌沿。
 */
export function TableFelt() {
  return (
    <div
      className="absolute inset-x-[3.5%] inset-y-[8%] overflow-hidden rounded-[50%] bg-felt-v2 shadow-felt-inset"
      data-testid="table-felt"
      aria-hidden="true"
    >
      {/* 织物噪点（svg 滤镜铺底，透明度极低，避免影响可读性） */}
      <svg className="absolute inset-0 h-full w-full opacity-[0.05]">
        <filter id="felt-noise">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
        </filter>
        <rect width="100%" height="100%" filter="url(#felt-noise)" />
      </svg>

      {/* 中央桌印：樱花徽记 + 字样 */}
      <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 opacity-[0.07]">
        <TableSakura className="h-[190px] w-[190px]" />
        <span className="font-serif text-[20px] tracking-[0.55em] text-gold-light">ANITEXAS</span>
      </div>

      {/* 毡面暗角（中心略亮、四周压暗） */}
      <div className="absolute inset-0 bg-vignette" />
    </div>
  )
}

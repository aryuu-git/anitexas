import type { CSSProperties } from 'react'

/**
 * 规则书图标精灵（docs/rules.html <symbol> 同款路径）：
 * 单组件 + 名称查表，避免十七个文件的碎片化。
 */

export type IconName =
  | 'user'
  | 'building'
  | 'tag'
  | 'cal'
  | 'book'
  | 'cards'
  | 'link'
  | 'scale'
  | 'dice'
  | 'filter'
  | 'shield'
  | 'spark'
  | 'list'
  | 'arrow'
  | 'star'
  | 'close'
  | 'chevronLeft'
  | 'chevronRight'

/** 图标路径子元素（stroke 风格，viewBox 24×24） */
const PATHS: Record<IconName, string> = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
  building:
    '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
  tag: '<path d="M20 13l-7 7-10-10V3h7l10 10z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  book: '<path d="M6 3h13v18H6a2 2 0 01-2-2V5a2 2 0 012-2z"/><path d="M4 17h15"/>',
  cards: '<rect x="3" y="6" width="10" height="14" rx="2"/><rect x="11" y="3" width="10" height="14" rx="2"/>',
  link: '<path d="M10 14a4 4 0 010-6l2-2a4 4 0 016 6l-1 1"/><path d="M14 10a4 4 0 010 6l-2 2a4 4 0 01-6-6l1-1"/>',
  scale: '<path d="M12 3v18M4 21h16M12 6l7 3M12 6L5 9"/><path d="M5 9l-2 6h4zM19 9l-2 6h4z"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/><circle cx="15" cy="15" r="1"/>',
  filter: '<path d="M5 3h18l-7 8v6l-4 2v-8z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  spark: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  arrow: '<path d="M4 12h16M14 6l6 6-6 6"/>',
  star: '<path d="M12 3l2.6 6.2 6.4.6-4.9 4.3 1.5 6.4L12 17l-5.6 3.5 1.5-6.4L3 9.8l6.4-.6z"/>',
  // 导航/关闭字形：非规则书 sprite，同风格手绘（stroke 1.7 圆角端点）
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
}

interface IconProps {
  name: IconName
  /** 边长 px（默认 18，小号 15，与 rules.html .ic/.ic.sm 一致） */
  size?: number
  className?: string
  style?: CSSProperties
}

export function Icon({ name, size = 18, className = '', style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-none ${className}`}
      style={style}
      // 路径数据来自规则书 sprite，静态可信
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
      aria-hidden="true"
    />
  )
}

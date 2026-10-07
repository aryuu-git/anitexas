import type { EmoteKey } from '../api/types'
import { ChatPanel, type ChatLine } from './ChatPanel'
import { EmoteBar } from './EmoteBar'
import { Icon } from './ui/Icons'

/**
 * 桌边浮窗（EMOTE + CHAT 二合一）：固定右侧 overlay，不占对局桌布局宽度。
 * 自带开关（RoomPage header 的「表情·聊天」按钮）；关闭时不渲染。
 * disabled：观战/未入座等禁言态，一并禁用聊天输入与表情栏。
 */
export interface TableDockProps {
  open: boolean
  onClose: () => void
  messages: ChatLine[]
  chatEnabled: boolean
  /** 禁言态（观战/未入座）：禁用聊天输入与 EmoteBar */
  disabled?: boolean
  onSay: (text: string) => void
  cooldownUntil: number
  onEmote: (key: EmoteKey) => void
}

export function TableDock({
  open,
  onClose,
  messages,
  chatEnabled,
  disabled = false,
  onSay,
  cooldownUntil,
  onEmote,
}: TableDockProps) {
  if (!open) return null
  return (
    <aside
      data-testid="table-dock"
      className="fixed right-5 top-24 z-modal flex max-h-[76vh] w-[322px] flex-col overflow-hidden rounded-panel border border-gold-foil/25 bg-ink-deep/95 shadow-lift"
    >
      <header className="flex items-center gap-2 border-b border-gold/15 px-4 py-3">
        <span className="text-kicker text-gold-foil">桌边</span>
        <button
          type="button"
          aria-label="关闭侧栏"
          onClick={onClose}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-chip border border-gold/20 bg-ink-deep/40 text-micro text-gold-light transition-[transform,border-color,background-color,opacity] duration-fast ease-standard hover:-translate-y-px hover:border-gold/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70"
        >
          <Icon name="close" size={15} />
        </button>
      </header>

      {/* 快捷表情 */}
      <div className="px-4 pt-3">
        <div className="mb-2 text-micro text-muted">表情</div>
        <EmoteBar bare cooldownUntil={cooldownUntil} onEmote={onEmote} disabled={disabled} />
      </div>

      {/* 牌桌聊天 */}
      <div className="mt-3 border-t border-gold/10">
        <div className="px-4 pt-3 text-micro text-muted">聊天</div>
        <ChatPanel bare messages={messages} chatEnabled={chatEnabled} disabled={disabled} onSay={onSay} />
      </div>
    </aside>
  )
}

import { memo, useCallback, useState, type CSSProperties } from 'react'
import type { CardData, RevealScope, ShowdownHand } from '../../api/types'
import { CardFace } from '../CardFace'
import { RevealConfirm } from '../RevealConfirm'
import { useShowdownLookup } from '../../hooks/useShowdownLookup'

/**
 * 公告牌（v2）：公共牌按德州 **3-1-1** 分组（翻牌三张紧排，转牌/河牌各留大缝），
 * 带卡影与桌面倒影；保留「当众翻开」揭示交互。非 5 位配置时退化为平铺一行。
 */
export interface CommunityRowProps {
  community: CardData[]
  communitySlots?: number
  autoReveal: boolean
  canReveal: boolean
  revealRate: number
  onReveal: (card: CardData, scope: RevealScope) => void
  myShowdownHand?: ShowdownHand | null
  showCover?: boolean
  cardSize?: 'sm' | 'md'
}

/** 5 位时的分组：flop 3 / turn 1 / river 1 */
const GROUPS_5: number[][] = [
  [0, 1, 2],
  [3],
  [4],
]

export const CommunityRow = memo(function CommunityRow({
  community,
  communitySlots = 5,
  autoReveal,
  canReveal,
  revealRate,
  onReveal,
  myShowdownHand,
  showCover = true,
  cardSize = 'md',
}: CommunityRowProps) {
  const [pending, setPending] = useState<CardData | null>(null)
  const showdownOf = useShowdownLookup(myShowdownHand)
  const handleClick = useCallback((c: CardData) => setPending(c), [])

  const isSm = cardSize === 'sm'
  const slotCls = isSm ? 'h-[128px] w-[104px] text-lg' : 'h-[190px] w-[144px] text-2xl'
  const cardGap = isSm ? 'gap-1.5' : 'gap-2'
  /** 卡面统一最小高度 → 长标题/多要素也不破行对齐；发牌按索引错峰 */
  const cardCls = `animate-deal-v2 ${isSm ? 'min-h-[128px]' : 'min-h-[190px]'}`
  const dealStyle = (i: number) => ({ '--deal-delay': `${i * 70}ms` }) as CSSProperties
  const groups = communitySlots === 5 ? GROUPS_5 : [Array.from({ length: communitySlots }, (_, i) => i)]

  const renderSlot = (i: number) => {
    const card = community[i]
    if (!card) {
      return (
        <div
          key={`slot-${i}`}
          aria-hidden="true"
          data-testid="community-slot"
          className={`flex flex-none items-center justify-center rounded-card border border-dashed border-gold/20 bg-ink-deep/30 font-serif text-muted/40 ${slotCls}`}
        >
          ？
        </div>
      )
    }
    const showdown = showdownOf(card)
    return (
      <CardFace
        key={card.id}
        card={card}
        size={cardSize}
        className={cardCls}
        style={dealStyle(i)}
        state={showdown ? 'showdown' : autoReveal || card.elements ? 'revealed' : 'hidden'}
        grouped={showdown?.grouped ?? false}
        groupElement={showdown?.groupElement ?? undefined}
        interactive={!autoReveal && !card.elements && canReveal && !myShowdownHand}
        onReveal={handleClick}
        showCover={showCover}
      />
    )
  }

  return (
    <div className="flex items-end justify-center gap-5" data-testid="community-row">
      {groups.map((grp, gi) => (
        <div key={gi} className={`flex ${cardGap}`} data-testid="community-group">
          {grp.map((i) => (i < communitySlots ? renderSlot(i) : null))}
        </div>
      ))}

      {/* 公共牌揭示确认（A5.4，当众翻开） */}
      {pending && (
        <RevealConfirm
          card={pending}
          scope="public"
          revealRate={revealRate}
          onConfirm={() => {
            onReveal(pending, 'public')
            setPending(null)
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
})

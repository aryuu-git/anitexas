import { memo, useCallback, useState } from 'react'
import { TIER_NAMES, type CardData, type RevealScope, type ShowdownHand } from '../api/types'
import { CardFace } from './CardFace'
import { RevealConfirm } from './RevealConfirm'
import { Button } from './ui/Button'
import { useShowdownLookup } from '../hooks/useShowdownLookup'

/**
 * 自己的底牌（A5.2；对局桌改版：置于桌底中央，放大展示）：
 * - 点击自己的牌 → 私看确认（RevealConfirm，scope=private）后展开（仅自己可见；D3 不可逆故单击也过确认）；
 * - 「亮一只」（D15）：第一张未揭示底牌当众翻开，需确认（RevealConfirm）；
 * - 摊牌态按 best5 成组描金、散牌压暗；autoReveal 开局直接已揭示。
 */
export interface HoleCardsProps {
  myCards: CardData[]
  /** 开局自动展开要素（D14） */
  autoReveal: boolean
  /** 本方行动时才可揭示（下注轮内随时，§1.3） */
  canReveal: boolean
  /** 揭示费率（积分/次） */
  revealRate: number
  onReveal: (card: CardData, scope: RevealScope) => void
  /** 自己的摊牌手牌（best5 + groups 下标指向该 cards 数组） */
  myShowdownHand?: ShowdownHand | null
  /** 是否显示封面区（透传 CardFace） */
  showCover?: boolean
}

export const HoleCards = memo(function HoleCards({
  myCards,
  autoReveal,
  canReveal,
  revealRate,
  onReveal,
  myShowdownHand,
  showCover = true,
}: HoleCardsProps) {
  // 揭示确认弹层待确认的牌与范围（私看 / 当众翻开共用）
  const [pending, setPending] = useState<{ card: CardData; scope: RevealScope } | null>(null)
  const showdownOf = useShowdownLookup(myShowdownHand)

  /** 点击自己的牌 → 私看确认（稳定引用，配合 CardFace 的 memo） */
  const handleClick = useCallback((c: CardData) => setPending({ card: c, scope: 'private' }), [])

  const canLiang = !autoReveal && canReveal && !myShowdownHand && myCards.some((c) => !c.elements)

  return (
    <div className="flex flex-col items-center gap-2" data-testid="hole-cards">
      <div className="flex flex-wrap items-center justify-center gap-x-3">
        <span className="font-serif text-body text-gold-light">我的底牌</span>
        {canLiang && (
          <Button
            size="sm"
            variant="outline"
            icon="spark"
            onClick={() => {
              const target = myCards.find((c) => !c.elements)
              if (target) setPending({ card: target, scope: 'public' })
            }}
          >
            亮一只
          </Button>
        )}
        {!autoReveal && !myShowdownHand && (
          <span className="text-micro text-muted">点击牌面查看要素</span>
        )}
        <details className="relative">
          <summary className="cursor-pointer rounded-chip border border-gold/20 px-2 py-0.5 text-micro text-muted">
            牌型
          </summary>
          <div className="absolute right-0 top-full z-30 mt-2 w-56 rounded-tile border border-gold/20 bg-ink-deep p-3 shadow-lift">
            <div className="mb-2 text-micro text-gold-foil">牌型大小</div>
            <ol className="grid grid-cols-2 gap-1 text-micro text-gold-light/85">
              {Object.entries(TIER_NAMES)
                .sort((a, b) => Number(a[0]) - Number(b[0]))
                .map(([tier, name]) => (
                  <li key={tier}>
                    {tier}. {name}
                  </li>
                ))}
            </ol>
          </div>
        </details>
      </div>
      <div className="flex justify-center gap-3">
        {myCards.map((card) => {
          const showdown = showdownOf(card)
          return (
            <CardFace
              key={card.id}
              card={card}
              size="sm"
              className="animate-deal-in"
              state={showdown ? 'showdown' : autoReveal || card.elements ? 'revealed' : 'hidden'}
              grouped={showdown?.grouped ?? false}
              groupElement={showdown?.groupElement ?? undefined}
              interactive={!autoReveal && !card.elements && canReveal && !myShowdownHand}
              onReveal={handleClick}
              showCover={showCover}
            />
          )
        })}
      </div>

      {/* 揭示确认（私看 / 当众翻开，A5.4） */}
      {pending && (
        <RevealConfirm
          card={pending.card}
          scope={pending.scope}
          revealRate={revealRate}
          onConfirm={() => {
            onReveal(pending.card, pending.scope)
            setPending(null)
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
})

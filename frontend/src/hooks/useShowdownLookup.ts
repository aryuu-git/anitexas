import { useMemo } from 'react'
import type { CardData, Element, ShowdownHand } from '../api/types'
import { sharedGroupElement } from '../components/CardFace'

/** 单张牌的摊牌成组信息（不在 best5 的按散牌：grouped=false）。 */
export interface ShowdownLookup {
  grouped: boolean
  groupElement: Element | null
}

/**
 * 摊牌态查表：自己的 best5 → 每张牌的成组信息（useMemo 稳定，跨渲染同一牌返回同一对象，
 * 避免击穿 CardFace 的 React.memo）。无摊牌手牌时返回 () => undefined。
 */
export function useShowdownLookup(
  myShowdownHand: ShowdownHand | null | undefined,
): (card: CardData) => ShowdownLookup | undefined {
  const byId = useMemo(() => {
    const map = new Map<number, ShowdownLookup>()
    const hand = myShowdownHand
    if (!hand) return map
    hand.cards.forEach((card, idx) => {
      const g = hand.groups.find((grp) => grp.includes(idx))
      map.set(card.id, {
        grouped: g != null,
        groupElement: g ? sharedGroupElement(hand.cards, g) : null,
      })
    })
    return map
  }, [myShowdownHand])

  const fallback = useMemo<ShowdownLookup>(() => ({ grouped: false, groupElement: null }), [])

  return useMemo(
    () => (card: CardData) => (myShowdownHand ? byId.get(card.id) ?? fallback : undefined),
    [myShowdownHand, byId, fallback],
  )
}

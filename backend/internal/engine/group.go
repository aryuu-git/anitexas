package engine

import "sort"

// group 是一个候选成组：同一要素取值覆盖的卡集（规则书 §4「同要素取值的卡片集合」）。
type group struct {
	class int   // 要素类（1..5，越小越优先）
	mask  int   // 五张输入牌的位集（bit i = 下标 i）
	cards []int // 组内牌下标，升序
}

// candidateGroups 枚举 5 张牌的全部候选成组（卡数 ≥2 的同要素卡集）。
// 「撞要素只算一组」：同一卡集被多类/多值命中时只留一条，类取最高（规则书 §6）；
// 「组间卡不相交」不在这里约束，由牌型识别挑组时保证（一张卡可属于多个候选组）。
// 输出确定性排序：组大小降序 -> 要素类升序 -> 位集升序。
func candidateGroups(cards []Card) []group {
	byValue := map[Element]int{} // 要素 -> 卡位集
	for i, c := range cards {
		for _, e := range c.Elements {
			byValue[e] |= 1 << uint(i)
		}
	}
	byMask := map[int]int{} // 卡位集 -> 命中类里最高的一档
	for e, m := range byValue {
		if m&(m-1) == 0 { // 只命中 1 张，不成组
			continue
		}
		if cl, ok := byMask[m]; !ok || e.Class < cl {
			byMask[m] = e.Class
		}
	}
	gs := make([]group, 0, len(byMask))
	for m, cl := range byMask {
		g := group{class: cl, mask: m}
		for i := 0; m != 0; i++ {
			if m&1 != 0 {
				g.cards = append(g.cards, i)
			}
			m >>= 1
		}
		gs = append(gs, g)
	}
	sort.Slice(gs, func(i, j int) bool {
		a, b := gs[i], gs[j]
		if len(a.cards) != len(b.cards) {
			return len(a.cards) > len(b.cards)
		}
		if a.class != b.class {
			return a.class < b.class
		}
		return a.mask < b.mask
	})
	return gs
}

package engine

// Best7 从 7 张里七选五（21 种组合）取最大的一手（规则书 §6）。
// 返回入选 5 张的下标（升序，坐标系 = 入参 7 张）；HandEval.Groups 的下标同样相对入参 7 张。
// 注：量级 21 次 Eval，无需优化。入参必须恰好 7 张，否则 panic。
func Best7(cards []Card) (HandEval, []int) {
	if len(cards) != 7 {
		panic("engine.Best7: 需要恰好 7 张牌")
	}
	var best HandEval
	var bestIdx []int
	first := true
	for i0 := 0; i0 < 3; i0++ {
		for i1 := i0 + 1; i1 < 4; i1++ {
			for i2 := i1 + 1; i2 < 5; i2++ {
				for i3 := i2 + 1; i3 < 6; i3++ {
					for i4 := i3 + 1; i4 < 7; i4++ {
						idx := [5]int{i0, i1, i2, i3, i4}
						var sub [5]Card
						for k, v := range idx {
							sub[k] = cards[v]
						}
						e := Eval5(sub[:])
						// 组下标从五张子集的坐标系重映射回归入参七张
						for gi, g := range e.Groups {
							for ci, v := range g {
								e.Groups[gi][ci] = idx[v]
							}
						}
						if first || Compare(e, best) > 0 {
							best, bestIdx, first = e, idx[:], false
						}
					}
				}
			}
		}
	}
	return best, bestIdx
}

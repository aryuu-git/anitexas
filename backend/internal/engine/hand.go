package engine

// isYearRun 判断若干张牌的年份是否恰好铺在连续年份上：一年一张、首尾不绕圈（规则书 §6）。
func isYearRun(cards []Card, idx []int) bool {
	if len(idx) == 0 {
		return false
	}
	lo, hi := cards[idx[0]].Year, cards[idx[0]].Year
	seen := map[int]bool{cards[idx[0]].Year: true}
	for _, v := range idx[1:] {
		y := cards[v].Year
		if seen[y] {
			return false // 一年两张不算「一年一张」
		}
		seen[y] = true
		if y < lo {
			lo = y
		}
		if y > hi {
			hi = y
		}
	}
	return hi-lo == len(idx)-1
}

// Eval5 识别五张牌的牌型（规则书 §4）：从 10 级到 1 级枚举全部解读，多重解读取最高
// （规则书 §6 边界规则）——先比级数，同级取比较向量最大的解读。
// 入参必须恰好 5 张（契约：Groups 的坐标系即入参下标），否则 panic。
func Eval5(cards []Card) HandEval {
	if len(cards) != 5 {
		panic("engine.Eval5: 需要恰好 5 张牌")
	}
	gs := candidateGroups(cards)
	all := []int{0, 1, 2, 3, 4}
	best := newHandEval(cards, TierSolo, nil) // 1 独奏兜底：任何成组解读都会压过它
	upd := func(tier int, sel []group) {
		if e := newHandEval(cards, tier, sel); Compare(e, best) > 0 {
			best = e
		}
	}

	// 10 黄金世代：同要素×5 且这 5 张年份连续
	for _, g := range gs {
		if len(g.cards) == 5 && isYearRun(cards, g.cards) {
			upd(TierGoldGen, []group{g})
		}
	}
	// 9 命运共同体：同要素×5
	for _, g := range gs {
		if len(g.cards) == 5 {
			upd(TierFateUnion, []group{g})
		}
	}
	// 8 四大名作：同要素×4 + 散1
	for _, g := range gs {
		if len(g.cards) == 4 {
			upd(TierMasterwork, []group{g})
		}
	}
	// 7 合奏：同×3 + 同×2（要素不同、卡不相交；同卡集已折叠，天然要素不同）
	for _, a := range gs {
		if len(a.cards) != 3 {
			continue
		}
		for _, b := range gs {
			if len(b.cards) == 2 && a.mask&b.mask == 0 {
				upd(TierEnsemble, []group{a, b})
			}
		}
	}
	// 6 年代物语：年份连续×5（与成组无关，内藏对/三条也按最高级判——G5 的情形）
	if isYearRun(cards, all) {
		upd(TierEra, nil)
	}
	// 5 三部曲物语：同要素×3 且这 3 张年份连续 + 散2
	for _, g := range gs {
		if len(g.cards) == 3 && isYearRun(cards, g.cards) {
			upd(TierTrilogy, []group{g})
		}
	}
	// 4 三连星：同要素×3 + 散2
	for _, g := range gs {
		if len(g.cards) == 3 {
			upd(TierTriple, []group{g})
		}
	}
	// 3 四手联弹：同×2 + 同×2（卡不相交）+ 散1
	for i, a := range gs {
		if len(a.cards) != 2 {
			continue
		}
		for _, b := range gs[i+1:] {
			if len(b.cards) == 2 && a.mask&b.mask == 0 {
				upd(TierQuartet, []group{a, b})
			}
		}
	}
	// 2 二重唱：同×2 + 散3
	for _, g := range gs {
		if len(g.cards) == 2 {
			upd(TierDuet, []group{g})
		}
	}
	return best
}

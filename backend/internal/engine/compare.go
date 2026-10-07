package engine

import "sort"

// cardFirst 为组内张/散牌定序：档位分降序 -> 原始分降序 -> id 降序（强张在前）。
func cardFirst(cards []Card, a, b int) bool {
	ca, cb := cards[a], cards[b]
	if ca.Bucket != cb.Bucket {
		return ca.Bucket > cb.Bucket
	}
	if ca.Score != cb.Score {
		return ca.Score > cb.Score
	}
	return ca.ID > cb.ID
}

// groupFirst 为组间定序（规则书 §5 ④）：大组到小组 -> 要素类优先级高到低 -> 组内张强到弱。
// 四手联弹的「强对 -> 弱对」即同大小组按后两条定序。
func groupFirst(cards []Card, a, b group) bool {
	if len(a.cards) != len(b.cards) {
		return len(a.cards) > len(b.cards)
	}
	if a.class != b.class {
		return a.class < b.class
	}
	for k := range a.cards {
		if a.cards[k] != b.cards[k] {
			return cardFirst(cards, a.cards[k], b.cards[k])
		}
	}
	return false
}

// newHandEval 组装一手牌：组按「大组到小组、强组到弱组」排，组内张与散牌按强张在前排，
// 再压扁成全序比较向量（规则书 §5 比较链：级数 -> 要素类 -> 组内档位分逐张
// -> 大组到小组 -> 散牌档位分 -> 原始分 -> id）。向量同位更大者胜。
// 同级多重解读的取舍 = 各解读向量取最大，故向量的组/张顺序即「最强解读」的展示顺序。
func newHandEval(cards []Card, tier int, sel []group) HandEval {
	var used [5]bool
	gs := make([]group, len(sel))
	for i, g := range sel {
		idx := append([]int(nil), g.cards...)
		sort.Slice(idx, func(x, y int) bool { return cardFirst(cards, idx[x], idx[y]) })
		gs[i] = group{class: g.class, mask: g.mask, cards: idx}
		for _, v := range idx {
			used[v] = true
		}
	}
	sort.Slice(gs, func(i, j int) bool { return groupFirst(cards, gs[i], gs[j]) })
	kickers := make([]int, 0, len(cards)-len(sel))
	for i := 0; i < len(cards); i++ {
		if !used[i] {
			kickers = append(kickers, i)
		}
	}
	sort.Slice(kickers, func(x, y int) bool { return cardFirst(cards, kickers[x], kickers[y]) })

	// 展示/兜底共用的张顺序：各组成员（组序）-> 散牌
	order := make([]int, 0, len(cards))
	for _, g := range gs {
		order = append(order, g.cards...)
	}
	order = append(order, kickers...)

	tb := make([]float64, 0, 21+len(gs))
	tb = append(tb, float64(tier)) // ① 级数
	for _, g := range gs {
		tb = append(tb, float64(6-g.class)) // ② 要素类优先级（数值越大越优先）
		for _, v := range g.cards {
			tb = append(tb, cards[v].Bucket) // ③ 组内档位分逐张降序
		}
	}
	for _, v := range kickers {
		tb = append(tb, cards[v].Bucket) // ⑤ 散牌档位分降序
	}
	for _, v := range order {
		tb = append(tb, cards[v].Score) // ⑥ 兜底：原始分（0.1）
	}
	for _, v := range order {
		tb = append(tb, float64(cards[v].ID)) // ⑥ 兜底：id（同牌集外永不平局）
	}
	groups := make([][]int, len(gs))
	for i, g := range gs {
		groups[i] = g.cards
	}
	return HandEval{Tier: tier, Tiebreak: tb, Groups: groups}
}

// Compare 全序比较两手牌：Tiebreak 向量字典序，同位更大者胜。
// 返回 1（a 胜）/ -1（b 胜）。牌集不同的两手永不平局——向量末位是 card id（规则书 §5 ⑥）；
// 仅牌集完全相同（对局中一副牌不会重复发）才返回 0。
func Compare(a, b HandEval) int {
	ta, tb := a.Tiebreak, b.Tiebreak
	n := len(ta)
	if len(tb) < n {
		n = len(tb)
	}
	for i := 0; i < n; i++ {
		if ta[i] > tb[i] {
			return 1
		}
		if ta[i] < tb[i] {
			return -1
		}
	}
	switch {
	case len(ta) > len(tb):
		return 1
	case len(ta) < len(tb):
		return -1
	}
	return 0
}

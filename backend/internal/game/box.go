package game

import (
	"math/bits"
	"sort"

	"anitexas/backend/internal/engine"
)

// ElemFreq 是盒内单个要素的携带牌数。
type ElemFreq struct {
	Element engine.Element `json:"element"`
	Count   int            `json:"count"`
}

// DeckStats 是牌盒图约束统计(高级算法①;测试报告对拍用)。
type DeckStats struct {
	TopFreq     []ElemFreq  `json:"topFreq"`     // 高频要素(频次降序)
	MaxElemFreq int         `json:"maxElemFreq"` // 盒内单要素值最高携带牌数
	PartnerMin  int         `json:"partnerMin"`
	PartnerMax  int         `json:"partnerMax"`
	PartnerDist map[int]int `json:"partnerDist"` // 搭档数 -> 牌数
	Dead        int         `json:"dead"`        // 0 搭档(死牌)
	Hubs        int         `json:"hubs"`        // 搭档数 > MaxPartners(枢纽)
}

// elemFreqs 统计盒内要素携带牌数(同要素只按每牌一次计)。
// R1 提速:卡内去重改线性扫(每卡要素≤5),免去旧「每卡建 seen map」的海量小分配(boxPenalty 热路径)。
func elemFreqs(box []engine.Card) map[engine.Element]int {
	freq := map[engine.Element]int{}
	for _, c := range box {
		for i, e := range c.Elements {
			dup := false
			for j := 0; j < i; j++ {
				if c.Elements[j] == e {
					dup = true
					break
				}
			}
			if !dup {
				freq[e]++
			}
		}
	}
	return freq
}

// partnerCounts 统计盒内每张牌的搭档数(共享 ≥1 要素的其它牌张数,图 = 共享要素边)。
// R1 提速:要素->携带者位图 + 逐牌并集去自,得去重搭档数。与旧全对 sharesElement 同值
// (搭档 = 共享任一要素的其它牌,去重),但 O(盒×要素×字) 优于 O(盒²×要素²)——
// boxPenalty 每次修复调用上百回,是 SampleDeck 的热路径。
func partnerCounts(box []engine.Card) map[int64]int {
	n := len(box)
	if n == 0 {
		return map[int64]int{}
	}
	words := (n + 63) / 64
	// 要素 -> 携带者位图(同要素同牌多记无妨,位图幂等)
	carrier := map[engine.Element][]uint64{}
	for i, c := range box {
		for _, e := range c.Elements {
			cb, ok := carrier[e]
			if !ok {
				cb = make([]uint64, words)
				carrier[e] = cb
			}
			cb[i/64] |= 1 << uint(i%64)
		}
	}
	// 每牌搭档位图 = 其各要素携带者位图之并,再清自身位
	partner := make([]uint64, n*words)
	for i, c := range box {
		base := i * words
		for _, e := range c.Elements {
			cb := carrier[e]
			for w := 0; w < words; w++ {
				partner[base+w] |= cb[w]
			}
		}
	}
	out := map[int64]int{}
	for i := range box {
		base := i * words
		cnt := 0
		for w := 0; w < words; w++ {
			v := partner[base+w]
			if w == i/64 {
				v &^= 1 << uint(i%64) // 去自
			}
			cnt += bits.OnesCount64(v)
		}
		if cnt > 0 {
			out[box[i].ID] = cnt
		}
	}
	return out
}

// boxPenalty 计算图约束惩罚(高级算法①,越小越好,0 = 全部满足):
// 超频要素(超出部分按要素类加权,监督最重)+ 死牌(0 搭档)+ 枢纽(> MaxPartners)。
func boxPenalty(box []engine.Card, maxElemFreq int) int {
	p := 0
	if maxElemFreq > 0 {
		for e, f := range elemFreqs(box) {
			if f > maxElemFreq {
				w := 6 - e.Class // 要素类优先级:监督(1)最重、原作类型(5)最轻
				if w < 1 {
					w = 1
				}
				p += (f - maxElemFreq) * w
			}
		}
	}
	parts := partnerCounts(box)
	for _, c := range box {
		switch n := parts[c.ID]; { // 无记录 = 0 搭档(死牌)
		case n < MinPartners:
			p += 5
		case n > MaxPartners:
			p += (n - MaxPartners) * 5
		}
	}
	return p
}

// repairBox 图约束修复(高级算法①):从分层选中结果出发,贪心局部交换最小化
// 「违反约束的惩罚项」(超频值、死牌、枢纽各计分,图 = 共享要素边)。
// 交换限同档未选候选(保持档位分席不变):出盒候选违规牌优先(再其余牌,均按
// id 升序),入盒候选本层洗牌序列序优先、再同档其它层(层键升序);
// 每轮取第一个降低惩罚的换人,直到惩罚归零或迭代上限(可复现:同 seed 同结果)。
// 返回各层最终选中牌(层内按洗牌序列位次)。
func repairBox(f *deckFrame, seq map[layerKey][]engine.Card, sel map[layerKey]int, maxElemFreq int) map[layerKey][]engine.Card {
	keys := f.keys
	layerOf := f.layerOf
	bucketOf := f.bucketOf
	in := map[layerKey]map[int64]bool{}
	for _, k := range keys {
		in[k] = map[int64]bool{}
		for i := 0; i < sel[k]; i++ {
			in[k][seq[k][i].ID] = true
		}
	}
	// build 重建当前盒(供 boxPenalty/违规判定):从 in 直取选中牌(R1:O(盒),替代旧
	// 「扫全库 seq 过滤」的 O(库));盒次序不影响惩罚(惩罚与次序无关)与换人决策
	// (viol/rest 会按 id 排序),但 sortByID 固定枚举序保证 run-to-run 逐字节一致(D16)。
	build := func() []engine.Card {
		out := make([]engine.Card, 0, len(sel))
		for _, k := range keys {
			for id := range in[k] {
				out = append(out, f.byID[id])
			}
		}
		sortByID(out)
		return out
	}

	budget := maxRepairRounds
	work := repairWorkBudget
	for iter := 0; iter < budget; iter++ {
		box := build()
		base := boxPenalty(box, maxElemFreq)
		if base == 0 {
			break
		}
		// 违规判定:死牌/枢纽/携带超频要素
		parts := partnerCounts(box)
		over := map[engine.Element]bool{}
		for e, f := range elemFreqs(box) {
			if maxElemFreq > 0 && f > maxElemFreq {
				over[e] = true
			}
		}
		viol, rest := []engine.Card{}, []engine.Card{}
		for _, c := range box {
			n := parts[c.ID]
			bad := n < MinPartners || n > MaxPartners
			for _, e := range c.Elements {
				if over[e] {
					bad = true
				}
			}
			if bad {
				viol = append(viol, c)
			} else {
				rest = append(rest, c)
			}
		}
		sortByID(viol)
		sortByID(rest)

		swapped := tryImprove(box, in, seq, bucketOf, layerOf, viol, rest, base, maxElemFreq, &work)
		if !swapped {
			break // 单换/二换二均无改进,尽力而为(统计照报)
		}
	}

	out := map[layerKey][]engine.Card{}
	for _, k := range keys {
		for _, c := range seq[k] {
			if in[k][c.ID] {
				out[k] = append(out[k], c)
			}
		}
	}
	return out
}

// poolFor 返回 x 的换入候选:同档未选牌,本层洗牌序列序优先,再同档其它层(层键升序)。
func poolFor(seq map[layerKey][]engine.Card, in map[layerKey]map[int64]bool, bucketOf map[float64][]layerKey, layerOf map[int64]layerKey, x engine.Card) []engine.Card {
	xk := layerOf[x.ID]
	out := []engine.Card{}
	appendLayer := func(k layerKey) {
		for _, c := range seq[k] {
			if !in[k][c.ID] {
				out = append(out, c)
			}
		}
	}
	appendLayer(xk)
	for _, k := range bucketOf[xk.bucket] {
		if k != xk {
			appendLayer(k)
		}
	}
	return out
}

// tryImprove 尝试一轮惩罚下降换人:先单换(违规牌优先,再其余牌,均按 id 升序);
// 单换无改进(局部极小,如 3+3 团对 2+2+2 团)再做二换二兜底。
// 出盒/入盒仅限同档未选候选(保持档位分席不变)。找到并应用返回 true。
func tryImprove(box []engine.Card, in map[layerKey]map[int64]bool,
	seq map[layerKey][]engine.Card, bucketOf map[float64][]layerKey, layerOf map[int64]layerKey,
	viol, rest []engine.Card, base, maxElemFreq int, work *int) bool {
	apply := func(x, y engine.Card) {
		delete(in[layerOf[x.ID]], x.ID)
		in[layerOf[y.ID]][y.ID] = true
	}
	sc1 := make([]engine.Card, len(box)) // 试换写缓冲(复用,免每试换一次分配)
	sc2 := make([]engine.Card, len(box))
	n2 := len(box) * len(box) // boxPenalty 是 O(n²),试换按 n² 计权消耗共享工作量池
	entry := *work
	half := entry / 2 // 单换先用一半预算,余下留给二换二兜底
	// 单换
	for _, list := range [][]engine.Card{viol, rest} {
		for _, x := range list {
			for _, y := range poolFor(seq, in, bucketOf, layerOf, x) {
				if *work <= half {
					goto pair
				}
				*work -= n2
				if boxPenalty(swapInto(sc1, box, x, y), maxElemFreq) < base {
					apply(x, y)
					return true
				}
			}
		}
	}
pair:
	// 二换二兜底(贪心局部交换;出盒对违规牌优先)
	xs := append(append([]engine.Card{}, viol...), rest...)
	for i := 0; i < len(xs); i++ {
		for j := i + 1; j < len(xs); j++ {
			x1, x2 := xs[i], xs[j]
			for _, y1 := range poolFor(seq, in, bucketOf, layerOf, x1) {
				for _, y2 := range poolFor(seq, in, bucketOf, layerOf, x2) {
					if y1.ID == y2.ID {
						continue
					}
					if *work <= 0 {
						return false
					}
					*work -= n2
					if boxPenalty(swapInto(sc2, swapInto(sc1, box, x1, y1), x2, y2), maxElemFreq) < base {
						apply(x1, y1)
						apply(x2, y2)
						return true
					}
				}
			}
		}
	}
	return false
}

// swapInto 把 box 中 x 换成 y 后写入 dst(复用缓冲,免每试换一次分配;惩罚与次序无关)。
func swapInto(dst, box []engine.Card, x, y engine.Card) []engine.Card {
	dst = dst[:len(box)]
	copy(dst, box)
	for i := range dst {
		if dst[i].ID == x.ID {
			dst[i] = y
			break
		}
	}
	return dst
}

// sortByID 按牌 id 升序(确定性枚举序)。
func sortByID(cards []engine.Card) {
	sort.Slice(cards, func(i, j int) bool { return cards[i].ID < cards[j].ID })
}

// NewDeckStats 计算牌盒统计(频率 top、搭档数分布;测试报告用)。
func NewDeckStats(box []engine.Card) DeckStats {
	freq := elemFreqs(box)
	parts := partnerCounts(box)
	st := DeckStats{PartnerDist: map[int]int{}}
	for e, f := range freq {
		st.TopFreq = append(st.TopFreq, ElemFreq{Element: e, Count: f})
		if f > st.MaxElemFreq {
			st.MaxElemFreq = f
		}
	}
	sort.Slice(st.TopFreq, func(i, j int) bool {
		if st.TopFreq[i].Count != st.TopFreq[j].Count {
			return st.TopFreq[i].Count > st.TopFreq[j].Count
		}
		if st.TopFreq[i].Element.Class != st.TopFreq[j].Element.Class {
			return st.TopFreq[i].Element.Class < st.TopFreq[j].Element.Class
		}
		return st.TopFreq[i].Element.Value < st.TopFreq[j].Element.Value
	})
	st.PartnerMin = MaxPartners + 1
	for _, c := range box {
		n := parts[c.ID] // 无记录 = 0 搭档
		st.PartnerDist[n]++
		if n < st.PartnerMin {
			st.PartnerMin = n
		}
		if n > st.PartnerMax {
			st.PartnerMax = n
		}
		if n < MinPartners {
			st.Dead++
		}
		if n > MaxPartners {
			st.Hubs++
		}
	}
	return st
}

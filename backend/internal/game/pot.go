package game

// potLayer 是主池/边池的一层。
type potLayer struct {
	Amount   int   // 该层筹码总额
	Eligible []int // 可赢该层的座位(该层投入达标且未弃牌),升序
}

// splitPots 按全下投入封顶拆主池/边池(支持任意多层):
// 每个不同的总投入水平 c 生成一层,层额 = Σ min(committed_i, c) - 上层累计,
// 可赢者 = 未弃牌且总投入 >= c(弃牌玩家的投入照常入池但不可赢)。
//
// 理论边界(某层无可赢者,如顶层投入者已弃牌):层额并入上一层(可赢面更宽);
// 首层无可赢者则累积并入下一层。入参 seats 下标即座位号。
func splitPots(committed []int, folded []bool) []potLayer {
	// 收集升序的投入水平(>0)
	caps := []int{}
	seen := map[int]bool{}
	for _, c := range committed {
		if c > 0 && !seen[c] {
			seen[c] = true
			caps = append(caps, c)
		}
	}
	sortInts(caps)

	out := []potLayer{}
	carry := 0 // 无可赢者层的累积,并入下一层
	prev := 0
	for _, lvl := range caps {
		amount := 0
		for _, c := range committed {
			amount += minInt(c, lvl) - minInt(c, prev)
		}
		prev = lvl
		if amount <= 0 {
			continue
		}
		eligible := []int{}
		for i, c := range committed {
			if c >= lvl && !folded[i] {
				eligible = append(eligible, i)
			}
		}
		if len(eligible) == 0 {
			carry += amount
			continue
		}
		if len(out) > 0 {
			out[len(out)-1].Amount += carry // 上一层可赢面更宽,承接死筹码
		} else {
			amount += carry
		}
		carry = 0
		out = append(out, potLayer{Amount: amount, Eligible: eligible})
	}
	// 尾层死筹码(顶层投入者已弃牌)并入最后一个可赢层
	if carry > 0 && len(out) > 0 {
		out[len(out)-1].Amount += carry
		carry = 0
	}
	// 兜底:全部层无可赢者(理论不可达,防御)——并入首层,由 award 定赢家
	if len(out) == 0 {
		total := 0
		for _, c := range committed {
			total += c
		}
		out = append(out, potLayer{Amount: total, Eligible: []int{}})
	}
	return out
}

// buttonOrder 返回按钮后顺序的座位环(庄家下家起,环回;先行动者在前)。
// 奇数筹码余筹按此顺序给「靠前者」(温州惯例,规则书 §7 均分余筹)。
func buttonOrder(n, button int) []int {
	out := make([]int, 0, n)
	start := 0
	if button >= 0 {
		start = (button + 1) % n
	}
	for i := 0; i < n; i++ { // go 1.21:整数 range 不可用
		out = append(out, (start+i)%n)
	}
	return out
}

// distribute 把层额均分给赢家;除不尽的余筹按 order 顺序给靠前者。
// 返回座位 -> 赢得筹码。order 缺席的赢家排最后(防御)。
func distribute(amount int, winners, order []int) map[int]int {
	out := map[int]int{}
	if len(winners) == 0 || amount <= 0 {
		return out
	}
	// 按按钮后顺序排赢家(靠前者得余筹)
	rank := map[int]int{}
	for i, s := range order {
		rank[s] = i
	}
	sorted := append([]int(nil), winners...)
	sortIntsBy(sorted, func(a, b int) bool {
		ra, okA := rank[a]
		rb, okB := rank[b]
		if okA != okB {
			return okA // order 内的排前面
		}
		if ra != rb {
			return ra < rb
		}
		return a < b
	})
	base := amount / len(sorted)
	rem := amount % len(sorted)
	for i, w := range sorted {
		out[w] = base
		if i < rem {
			out[w]++
		}
	}
	return out
}

// sortInts 升序排整数切片(就地)。
func sortInts(s []int) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// sortIntsBy 按 less 升序排整数切片(就地)。
func sortIntsBy(s []int, less func(a, b int) bool) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && less(s[j], s[j-1]); j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

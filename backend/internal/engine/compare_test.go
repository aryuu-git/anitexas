package engine

import (
	"math"
	"math/rand" // 依赖固定 seed 的经典 NewSource 可复现流；math/rand/v2 需 go1.22，而 go.mod 钉在 1.21（共享文件不可改）
	"strconv"
	"testing"
)

// randCard 生成一张随机牌：要素从共享取值池抽取（保证能撞出成组），id 全局唯一。
func randCard(r *rand.Rand, id int64) Card {
	directors := [4]string{"导A", "导B", "导C", "导D"}
	studios := [3]string{"社A", "社B", "社C"}
	tags := [8]string{"标1", "标2", "标3", "标4", "标5", "标6", "标7", "标8"}
	origins := [3]string{"原创", "漫画改", "轻小说改"}
	c := Card{ID: id, Year: 2000 + r.Intn(13)}
	c.Score = math.Round((5.0+r.Float64()*5.0)*10) / 10 // 0.1 粒度
	c.Bucket = Bucket(c.Score)
	if r.Intn(5) > 0 {
		c.Elements = append(c.Elements, Element{Class: ClassDirector, Value: directors[r.Intn(len(directors))]})
	}
	c.Elements = append(c.Elements, Element{Class: ClassStudio, Value: studios[r.Intn(len(studios))]})
	for k := r.Intn(4); k > 0; k-- {
		c.Elements = append(c.Elements, Element{Class: ClassTag, Value: tags[r.Intn(len(tags))]})
	}
	c.Elements = append(c.Elements, Element{Class: ClassYear, Value: strconv.Itoa(c.Year)})
	c.Elements = append(c.Elements, Element{Class: ClassOriginType, Value: origins[r.Intn(len(origins))]})
	return c
}

// TestCompareFuzz 固定 seed 的 10 万组随机五张：Compare 反对称、传递、永不 0
// （A1.4 后半），并顺带验证 Eval5 对输入顺序不敏感（纯函数确定性）。
func TestCompareFuzz(t *testing.T) {
	r := rand.New(rand.NewSource(20260930)) // 固定 seed，结果可复现
	perms := [6][3]int{{0, 1, 2}, {0, 2, 1}, {1, 0, 2}, {1, 2, 0}, {2, 0, 1}, {2, 1, 0}}
	for trial := 0; trial < 100000; trial++ {
		var hands [3]HandEval
		var first [5]Card
		id := int64(trial)*15 + 1 // 每次试验 15 张唯一 id，模拟一副牌发三手，牌集互异
		for h := 0; h < 3; h++ {
			var cards [5]Card
			for k := 0; k < 5; k++ {
				cards[k] = randCard(r, id)
				id++
			}
			hands[h] = Eval5(cards[:])
			if h == 0 {
				first = cards
			}
		}
		// 反对称 + 永不 0
		for i := 0; i < 3; i++ {
			for j := i + 1; j < 3; j++ {
				ab, ba := Compare(hands[i], hands[j]), Compare(hands[j], hands[i])
				if ab == 0 {
					t.Fatalf("trial %d: 手 %d 与手 %d 平局", trial, i, j)
				}
				if ab != -ba {
					t.Fatalf("trial %d: 手 %d/手 %d 反对称失败: %d vs %d", trial, i, j, ab, ba)
				}
			}
		}
		// 传递：任意序 x>y>z 必蕴含 x>z
		for _, p := range perms {
			if Compare(hands[p[0]], hands[p[1]]) > 0 && Compare(hands[p[1]], hands[p[2]]) > 0 &&
				Compare(hands[p[0]], hands[p[2]]) <= 0 {
				t.Fatalf("trial %d: 手 %d>手 %d>手 %d 但手 %d<=手 %d", trial, p[0], p[1], p[2], p[0], p[2])
			}
		}
		// 纯函数确定性：同五张牌换序重算，比较向量必须逐位一致
		var rev [5]Card
		for k := 0; k < 5; k++ {
			rev[k] = first[4-k]
		}
		got := Eval5(rev[:])
		if len(got.Tiebreak) != len(hands[0].Tiebreak) {
			t.Fatalf("trial %d: 换序后向量长度漂移", trial)
		}
		for k := range got.Tiebreak {
			if got.Tiebreak[k] != hands[0].Tiebreak[k] {
				t.Fatalf("trial %d: 换序后向量第 %d 位漂移: %v vs %v", trial, k, got.Tiebreak[k], hands[0].Tiebreak[k])
			}
		}
	}
}

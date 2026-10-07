package game

import (
	"fmt"
	"testing"

	"anitexas/backend/internal/engine"
)

// libForDeck 造一个多层卡池:5 档位 × 4 张;每档 2 张共享监督(组牌类 1)、
// 2 张共享公司(组牌类 2),各自互为搭档、档间互不相干。
func libForDeck() []engine.Card {
	lib := []engine.Card{}
	id := int64(1)
	for b := 0; b < 5; b++ {
		director := engine.Element{Class: engine.ClassDirector, Value: fmt.Sprintf("导%d", b)}
		studio := engine.Element{Class: engine.ClassStudio, Value: fmt.Sprintf("社%d", b)}
		lib = append(lib,
			testCard(id, "池", float64(5+b), 1980+b*3, director),
			testCard(id+1, "池", float64(5+b), 1980+b*3, director),
			testCard(id+2, "池", float64(5+b), 1980+b*3, studio),
			testCard(id+3, "池", float64(5+b), 1980+b*3, studio),
		)
		id += 4
	}
	return lib
}

// bucketCount 统计牌盒里各档位的张数。
func bucketCount(box []engine.Card) map[float64]int {
	out := map[float64]int{}
	for _, c := range box {
		out[c.Bucket]++
	}
	return out
}

// TestSampleDeckReproducible 固定 seed 可复现(D16):同库同 n 同 seed 逐字节一致,
// 异 seed 异输出。
func TestSampleDeckReproducible(t *testing.T) {
	lib := libForDeck()
	a := SampleDeck(lib, 12, 42)
	b := SampleDeck(lib, 12, 42)
	if len(a) != 12 || len(b) != 12 {
		t.Fatalf("抽盒张数 %d/%d != 12", len(a), len(b))
	}
	for i := range a {
		if a[i].ID != b[i].ID {
			t.Fatalf("同 seed 输出不一致: 第 %d 张 %d != %d", i, a[i].ID, b[i].ID)
		}
	}
	c := SampleDeck(lib, 12, 43)
	same := true
	for i := range a {
		if a[i].ID != c[i].ID {
			same = false
		}
	}
	if same {
		t.Fatal("不同 seed 输出不应相同")
	}
}

// TestSampleDeckNoDuplicates 盒内不重复发牌(A3.3):抽盒无重复 id 且全部来自卡库。
func TestSampleDeckNoDuplicates(t *testing.T) {
	lib := libForDeck()
	out := SampleDeck(lib, 20, 7)
	seen := map[int64]bool{}
	inLib := map[int64]bool{}
	for _, c := range lib {
		inLib[c.ID] = true
	}
	for _, c := range out {
		if seen[c.ID] {
			t.Fatalf("重复发牌: %d", c.ID)
		}
		if !inLib[c.ID] {
			t.Fatalf("外来牌: %d", c.ID)
		}
		seen[c.ID] = true
	}
	if len(out) != 20 {
		t.Fatalf("全库应抽 20 张,实际 %d", len(out))
	}
}

// TestSampleDeckBucketEqualSeats 档位等额分席(D16):档内候选数悬殊时席位仍等额,
// 层容量不足的档由余席回填补给剩余容量最大的层。
func TestSampleDeckBucketEqualSeats(t *testing.T) {
	// 三档候选 30/10/5;n=30 -> 每档 10 席;7 档只有 5 张,封顶后回填给 5 档
	lib := []engine.Card{}
	id := int64(1)
	for _, spec := range []struct {
		bucket float64
		size   int
	}{{5.0, 30}, {6.0, 10}, {7.0, 5}} {
		for i := 0; i < spec.size; i++ {
			lib = append(lib, testCard(id, "池", spec.bucket, 1980+i,
				engine.Element{Class: engine.ClassTag, Value: fmt.Sprintf("杂%04d", id)}))
			id++
		}
	}
	out := SampleDeck(lib, 30, 1)
	got := bucketCount(out)
	want := map[float64]int{5.0: 15, 6.0: 10, 7.0: 5}
	for b, w := range want {
		if got[b] != w {
			t.Errorf("档位 %v 抽 %d 张,期望 %d(全盒 %v)", b, got[b], w, got)
		}
	}
	if len(out) != 30 {
		t.Fatalf("全盒 %d 张 != 30", len(out))
	}
}

// TestSampleDeckZeroCoverage 零覆盖兜底(D16):比例最大余数把小组牌类挤成 0 张时,
// 从最大层挪 1 席给该类,保证库中存在的组牌类每类 ≥1 张。
func TestSampleDeckZeroCoverage(t *testing.T) {
	// 单档 5.0:组牌类 1 层 48 张(共享监督),组牌类 5 层 2 张(共享原作类型)
	lib := []engine.Card{}
	for id := int64(1); id <= 48; id++ {
		lib = append(lib, testCard(id, "池", 5.0, 1980,
			engine.Element{Class: engine.ClassDirector, Value: "导X"},
			engine.Element{Class: engine.ClassTag, Value: fmt.Sprintf("杂%04d", id)}))
	}
	for id := int64(51); id <= 52; id++ {
		lib = append(lib, testCard(id, "孤", 5.0, 1990,
			engine.Element{Class: engine.ClassOriginType, Value: "游戏改"}))
	}
	out := SampleDeck(lib, 10, 9)
	if len(out) != 10 {
		t.Fatalf("全盒 %d 张 != 10", len(out))
	}
	cover5 := 0
	for _, c := range out {
		if anchorClass(c, sharedElements(lib)) == 5 {
			cover5++
		}
	}
	if cover5 < 1 {
		t.Fatal("零覆盖兜底应保证组牌类 5 ≥1 张")
	}
}

// TestSampleDeckEdge 边界:超抽封顶为全库;非正 n 返回空。
func TestSampleDeckEdge(t *testing.T) {
	lib := libForDeck()
	if got := SampleDeck(lib, 99, 1); len(got) != 20 {
		t.Fatalf("超抽应返回全库 20 张,实际 %d", len(got))
	}
	if got := SampleDeck(lib, 0, 1); len(got) != 0 {
		t.Fatalf("n=0 应返回空,实际 %d", len(got))
	}
	if got := SampleDeck(nil, 5, 1); len(got) != 0 {
		t.Fatalf("空库应返回空,实际 %d", len(got))
	}
}

// TestSampleDeckUniformShuffle 洗牌均匀性(验收补充):同一牌库抽 1 万次,
// 首张/各位置的档位与要素分布近似均匀(计数上下界,不作严格卡方)。
func TestSampleDeckUniformShuffle(t *testing.T) {
	const rounds = 10000
	lib := libForDeck() // 20 张 = 5 档位 × 4;组牌类 1/2 各半
	n := len(lib)

	firstCard := map[int64]int{}
	firstBucket := map[float64]int{}
	firstClass := map[int]int{}
	posBucket := make([]map[float64]int, n)
	for p := range posBucket {
		posBucket[p] = map[float64]int{}
	}
	shared := sharedElements(lib)
	for i := 0; i < rounds; i++ {
		out := SampleDeck(lib, n, NewSeed())
		if len(out) != n {
			t.Fatalf("第 %d 次抽盒张数 %d != %d", i, len(out), n)
		}
		firstCard[out[0].ID]++
		firstBucket[out[0].Bucket]++
		firstClass[anchorClass(out[0], shared)]++
		for p, c := range out {
			posBucket[p][c.Bucket]++
		}
	}

	// 每张牌当首张的期望 = 10000/20 = 500;上下界 [350, 650](>10σ 余量)
	for _, c := range lib {
		if got := firstCard[c.ID]; got < 350 || got > 650 {
			t.Errorf("牌%d 当首张 %d 次,超出 [350,650]", c.ID, got)
		}
	}
	// 首张档位分布:档位等额分席,每档 1/5,期望 2000,上下界 [1600, 2400]
	for b := 0; b < 5; b++ {
		bucket := float64(5 + b)
		if got := firstBucket[bucket]; got < 1600 || got > 2400 {
			t.Errorf("首张档位 %v 计 %d,超出 [1600,2400]", bucket, got)
		}
	}
	// 首张要素(组牌类)分布:类1/类2 各半,期望 5000,±20% 上下界
	for cls, want := range map[int]int{1: 5000, 2: 5000} {
		if got := firstClass[cls]; got < want*4/5 || got > want*6/5 {
			t.Errorf("首张组牌类 %d 计 %d,超出 [%d,%d]", cls, got, want*4/5, want*6/5)
		}
	}
	// 各位置档位分布:每档期望 2000,上下界 [1600, 2400]
	for p := 0; p < n; p++ {
		for b := 0; b < 5; b++ {
			bucket := float64(5 + b)
			if got := posBucket[p][bucket]; got < 1600 || got > 2400 {
				t.Errorf("位置%d 档位 %v 计 %d,超出 [1600,2400]", p, bucket, got)
			}
		}
	}
}

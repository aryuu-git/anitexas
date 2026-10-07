package game

import (
	"fmt"
	"testing"

	"anitexas/backend/internal/engine"
)

// graphLib 造图约束测试卡库(单档 5.0):T0 枢纽团 6 张 + Ta/Tb/Tc 小团各 3 张,
// 团内共享标签互为搭档,团间互不相干;各卡另带唯一监督(不共享,不影响组牌类)。
func graphLib() []engine.Card {
	lib := []engine.Card{}
	id := int64(1)
	for _, spec := range []struct {
		tag  string
		size int
	}{{"T0", 6}, {"Ta", 3}, {"Tb", 3}, {"Tc", 3}} {
		for i := 0; i < spec.size; i++ {
			lib = append(lib, testCard(id, "池", 5.0, 1980+i,
				engine.Element{Class: engine.ClassTag, Value: spec.tag},
				engine.Element{Class: engine.ClassDirector, Value: fmt.Sprintf("导%03d", id)}))
			id++
		}
	}
	return lib
}

// TestSampleDeckPlanCrossCheck 分层席位数与 Python 参考实现对拍
// (scripts/simulate_balance.py 的 prepare/plan_quota,真源 2026-09-30 实跑):
// 夹具 A(5.0,类1)×4 / B(5.0,类2)×2 / C(6.0,类3)×3 / D(6.0,类5)×2,S=8,
// 期望席位 A=3 B=1 C=2 D=2(档位等额 4/4;档内最大余数:6.0 档余席按小数部分
// 降序给 D 层)。夹具任意子集搭档数 ∈ [1,4],图约束零违规,故输出层席位即配额。
func TestSampleDeckPlanCrossCheck(t *testing.T) {
	lib := []engine.Card{}
	for id := int64(1); id <= 4; id++ {
		lib = append(lib, testCard(id, "池", 5.0, 1980,
			engine.Element{Class: engine.ClassDirector, Value: "导X"},
			engine.Element{Class: engine.ClassStudio, Value: "社Y"}))
	}
	for id := int64(5); id <= 6; id++ {
		lib = append(lib, testCard(id, "池", 5.0, 1980,
			engine.Element{Class: engine.ClassStudio, Value: "社Y"}))
	}
	for id := int64(7); id <= 9; id++ {
		lib = append(lib, testCard(id, "池", 6.0, 1980,
			engine.Element{Class: engine.ClassTag, Value: "Z"}))
	}
	for id := int64(10); id <= 11; id++ {
		lib = append(lib, testCard(id, "池", 6.0, 1980,
			engine.Element{Class: engine.ClassOriginType, Value: "游戏改"}))
	}
	out := SampleDeckBox(lib, 8, 3, 0) // K=0 关频率约束;夹具自证搭档合规
	shared := sharedElements(lib)
	got := map[layerKey]int{}
	for _, c := range out {
		got[layerKey{bucket: c.Bucket, class: anchorClass(c, shared)}]++
	}
	want := map[layerKey]int{
		{bucket: 5.0, class: 1}: 3,
		{bucket: 5.0, class: 2}: 1,
		{bucket: 6.0, class: 3}: 2,
		{bucket: 6.0, class: 5}: 2,
	}
	for k, w := range want {
		if got[k] != w {
			t.Errorf("层%v 席位 %d != 参考 %d(全盒 %v)", k, got[k], w, got)
		}
	}
	if len(got) != len(want) {
		t.Errorf("层数 %d != 期望 %d: %v", len(got), len(want), got)
	}
}

// TestSampleDeckGraphConstraints 高级算法①:盒内要素频率 ≤ K、搭档密度 ∈ [1,4],
// 多 seed 贪心修复后零违规;输出盒统计(频率 top、搭档数分布)进测试报告。
func TestSampleDeckGraphConstraints(t *testing.T) {
	lib := graphLib()
	for seed := int64(1); seed <= 20; seed++ {
		out := SampleDeckBox(lib, 6, seed, 3)
		if len(out) != 6 {
			t.Fatalf("seed=%d 全盒 %d 张 != 6", seed, len(out))
		}
		st := NewDeckStats(out)
		t.Logf("seed=%d 频率top=%v 搭档分布=%v", seed, st.TopFreq[:minInt(3, len(st.TopFreq))], st.PartnerDist)
		if st.MaxElemFreq > 3 {
			t.Errorf("seed=%d 要素频率 %d 超上限 3(top=%v)", seed, st.MaxElemFreq, st.TopFreq)
		}
		if st.Dead != 0 || st.Hubs != 0 {
			t.Errorf("seed=%d 死牌 %d 枢纽 %d(应为 0,搭档分布=%v)", seed, st.Dead, st.Hubs, st.PartnerDist)
		}
		if st.PartnerMin < MinPartners || st.PartnerMax > MaxPartners {
			t.Errorf("seed=%d 搭档数 [%d,%d] 越界 [1,4]", seed, st.PartnerMin, st.PartnerMax)
		}
	}
}

// TestSampleDeckFreqCapParam 频率上限 K 参数化:K=2 时盒内任一要素值 ≤2 张。
func TestSampleDeckFreqCapParam(t *testing.T) {
	lib := graphLib()
	for seed := int64(1); seed <= 10; seed++ {
		out := SampleDeckBox(lib, 6, seed, 2)
		st := NewDeckStats(out)
		if st.MaxElemFreq > 2 {
			t.Errorf("seed=%d 要素频率 %d 超上限 2(top=%v)", seed, st.MaxElemFreq, st.TopFreq)
		}
		if st.Dead != 0 || st.Hubs != 0 {
			t.Errorf("seed=%d 死牌 %d 枢纽 %d(应为 0)", seed, st.Dead, st.Hubs)
		}
	}
}

package game

import (
	"crypto/rand"
	"encoding/binary"
	mrand "math/rand"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"anitexas/backend/internal/engine"
)

// NewSeed 生成一手牌的发牌种子:crypto/rand 随机 64 位,每手独立(换手换种子,D11)。
// SampleDeck 的固定 seed 仅用于牌盒构造的可复现;正式发牌由调用方每手取
// NewSeed() 抽盒,保证手与手之间无关联。crypto/rand 读失败(系统级故障)时
// 退化为时间熵,保证对局仍可继续。
func NewSeed() int64 {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return time.Now().UnixNano()
	}
	return int64(binary.LittleEndian.Uint64(b[:]))
}

// 牌盒图约束参数(高级算法①):任一要素值在盒内最多 MaxElemFreq 张(参数化,
// 绞杀枢纽标签);每张牌在盒内的搭档数须落在 [MinPartners, MaxPartners]
// (0 = 死牌不要,>4 = 枢纽不要)。
const (
	DefaultMaxElemFreq = 3
	MinPartners        = 1
	MaxPartners        = 4
)

// 修复工作量确定性封顶(性能根因修复,见 acceptance-report「胶水修复清单」):
// 原实现 repairBox 轮数 = 10×n、tryImprove trial 上限 20000/40000(固定次数),而
// boxPenalty 为 O(n²)(partnerCounts 全对扫描)。真实库 2 万张抽 78 张时 boxPenalty
// 被调用数千万次,单次 SampleDeck 实测 62s,远超规格 <10ms(即「假死锁」真凶:每手
// 同步发牌被拖到分钟级)。改为「n² 计权的跨轮共享工作量池」:每次试换消耗 len(box)²,
// 池尽即停。这样小夹具(graphLib n=6)的 boxPenalty 便宜、可尽情修复(零违规质量断言
// 不破),大库(n=78)则天然被压到很少几次,命中 <10ms。封顶确定性(无计时器,D16 同
// seed 同结果不变)。
const (
	maxRepairRounds  = 8      // repairBox 局部交换轮数上限;每轮 build() 扫全库,须压低
	repairWorkBudget = 900000 // 修复总工作量池(Σ len(box)²);大库~193 次、graphLib~2.5 万次
)

// layerKey 是分层键(档位 × 组牌类,CardPipeline 口径 P6)。
type layerKey struct {
	bucket float64
	class  int // 组牌类:与库内共享要素的最高优先级类;无共享要素记 5
}

// lessKey 是层键的确定性全序(档位升序 -> 类号升序)。
func lessKey(a, b layerKey) bool {
	if a.bucket != b.bucket {
		return a.bucket < b.bucket
	}
	return a.class < b.class
}

// sharedElements 计算库内共享要素集合:同一要素(类,值)被 ≥2 张牌携带即共享。
// 基数 = 全量卡库(帧),保证同一张卡的组牌类不随抽样波动(配额可复现)。
// 性能:单张扁平计数 map + 卡内线性去重(每卡要素≤5),替代原「map[要素]map[卡id]bool」
// 的 map-of-maps(2 万张分配海量内层 map,实测占 SampleDeck 固定开销 ~12ms)。语义等价。
func sharedElements(library []engine.Card) map[engine.Element]bool {
	count := make(map[engine.Element]int, len(library))
	for _, c := range library {
		for i, e := range c.Elements {
			dup := false
			for j := 0; j < i; j++ {
				if c.Elements[j] == e {
					dup = true
					break
				}
			}
			if !dup {
				count[e]++
			}
		}
	}
	out := map[engine.Element]bool{}
	for e, n := range count {
		if n >= 2 {
			out[e] = true
		}
	}
	return out
}

// anchorClass 返回牌的组牌类:共享要素中最高优先级(类号最小)的类;
// 无任何共享要素记 5(散牌并入 5 层;类 4/5 几乎总共享,落 5 的是真孤卡)。
func anchorClass(c engine.Card, shared map[engine.Element]bool) int {
	best := 5
	for _, e := range c.Elements {
		if shared[e] && e.Class > 0 && e.Class < best {
			best = e.Class
		}
	}
	return best
}

// deckFrame 是卡库派生、与 seed 无关的预计算结构(R1 提速):共享要素集、分层分组
// (层键 + 层内 id 升序候选)、牌->层/档位映射。这些只依赖卡库本身,与 n/seed 无关,
// 旧实现每手 SampleDeck 都重扫全库(实测 sharedElements+分层占 ~13ms),帧化后一次构建
// 多手复用。帧构建后只读,sample 不改其字段,故并发抽盒共享同一帧安全(D12 多桌并发)。
// 取舍:分层语义(anchorClass/sharedElements)不变,序列化结果与旧实现逐字节一致(D16)。
type deckFrame struct {
	lib      []engine.Card              // 归一化(按 id 升序)卡库
	shared   map[engine.Element]bool    // 共享要素集(同要素被 ≥2 张牌携带)
	keys     []layerKey                 // 层键,lessKey 升序
	byKey    map[layerKey][]engine.Card // 层内候选,id 升序
	byID     map[int64]engine.Card      // 牌 id -> 牌(修复期 O(1) 取牌)
	layerOf  map[int64]layerKey         // 牌 id -> 层键
	bucketOf map[float64][]layerKey     // 档位 -> 该档层键(升序)
}

// buildDeckFrame 从卡库构建帧:归一排序 + sharedElements + 分层分组(与 seed 无关的全部 O(库) 重活)。
func buildDeckFrame(library []engine.Card) *deckFrame {
	lib := append([]engine.Card(nil), library...)
	sort.Slice(lib, func(i, j int) bool { return lib[i].ID < lib[j].ID })
	shared := sharedElements(lib)
	keys := []layerKey{}
	byKey := map[layerKey][]engine.Card{}
	byID := make(map[int64]engine.Card, len(lib))
	layerOf := map[int64]layerKey{}
	for _, c := range lib {
		k := layerKey{bucket: c.Bucket, class: anchorClass(c, shared)}
		if _, ok := byKey[k]; !ok {
			keys = append(keys, k)
		}
		byKey[k] = append(byKey[k], c)
		byID[c.ID] = c
		layerOf[c.ID] = k
	}
	sort.Slice(keys, func(i, j int) bool { return lessKey(keys[i], keys[j]) })
	bucketOf := map[float64][]layerKey{}
	for _, k := range keys {
		bucketOf[k.bucket] = append(bucketOf[k.bucket], k)
	}
	return &deckFrame{
		lib: lib, shared: shared, keys: keys, byKey: byKey, byID: byID,
		layerOf: layerOf, bucketOf: bucketOf,
	}
}

// frameCache 单槽帧缓存:以「首元素指针 + 长度」为身份。调用方(房间/基准)在多次
// SampleDeck 间传入同一卡库切片(同一底层数组),指针即稳定身份;缓存持 lib 强引用钉住
// 该数组,防 GC 后地址被他库复用误命中。换库即重建(正确性优先,慢路径),典型一进程一库。
var frameCache struct {
	sync.Mutex
	first  *engine.Card
	length int
	frame  *deckFrame
}

// deckFrameFor 取卡库对应帧(命中缓存 O(1),否则构建)。返回帧只读,调用方在其上抽盒。
func deckFrameFor(library []engine.Card) *deckFrame {
	frameCache.Lock()
	defer frameCache.Unlock()
	if frameCache.frame != nil && len(library) == frameCache.length &&
		(len(library) == 0 || &library[0] == frameCache.first) {
		return frameCache.frame
	}
	f := buildDeckFrame(library)
	if len(library) > 0 {
		frameCache.first = &library[0]
	}
	frameCache.length = len(library)
	frameCache.frame = f
	return f
}

// seqBufPool 复用层内洗牌缓冲(R1:每手全库牌拷贝 ~1.5MB,池化降 GC 压力、稳基准抖动)。
// 缓冲仅在 sample 孅内借出、返回;返回前已把选中牌拷入输出(牌对象只引用帧的稳定数据),
// 复用安全。多桌并发抽盒各自借独立缓冲,sync.Pool 保证不串。
var seqBufPool = sync.Pool{New: func() any { s := make([]engine.Card, 0, 256); return &s }}

// borrowSeqBuf 借一块容量 ≥ n 的洗牌缓冲(长度置 n)。
func borrowSeqBuf(n int) []engine.Card {
	p := seqBufPool.Get().(*[]engine.Card)
	if cap(*p) < n {
		*p = make([]engine.Card, n)
	}
	return (*p)[:n]
}

// returnSeqBuf 归还洗牌缓冲。
func returnSeqBuf(s []engine.Card) { seqBufPool.Put(&s) }

// FilterMinVotes 按作品标注数（评分人数）下限筛出卡库子集（RoomConfig.MinVotes 运行时收池）：
// 仅保留 Votes >= min 的牌；min <= 0 表示不过滤，原样返回。返回子集保持库内相对顺序
// （调用方决定是否再抽样/回退）。纯函数，不改入参切片。
func FilterMinVotes(library []engine.Card, min int) []engine.Card {
	if min <= 0 {
		return library
	}
	out := make([]engine.Card, 0, len(library))
	for _, c := range library {
		if c.Votes >= min {
			out = append(out, c)
		}
	}
	return out
}

// FilterTheme 按主题过滤项筛出卡库子集（D11 主题池 = 过滤后再分层，frontend-contract §3）。
// kind 取值与 model.Theme* 逐字一致：
//   - company：含公司(engine.ClassStudio)要素且值 == value（公司要素值匹配）；
//   - year：年份匹配——卡 Year 字段或年份(engine.ClassYear)要素值 == value；
//   - tag：含标签(engine.ClassTag)要素且值包含 value（有效标签包含）。
//
// 返回子集保持库内相对顺序（调用方决定是否再抽样）。过滤结果不足以撑牌池时的
// 回退策略由调用方定（room 层：不足 DeckSize 回退全库并记日志）。
func FilterTheme(library []engine.Card, kind, value string) []engine.Card {
	out := make([]engine.Card, 0, len(library))
	for _, c := range library {
		if themeMatch(c, kind, value) {
			out = append(out, c)
		}
	}
	return out
}

// themeMatch 判断单张牌是否命中主题过滤项（语义见 FilterTheme）。
func themeMatch(c engine.Card, kind, value string) bool {
	switch kind {
	case "company":
		for _, e := range c.Elements {
			if e.Class == engine.ClassStudio && e.Value == value {
				return true
			}
		}
	case "year":
		if strconv.Itoa(c.Year) == value {
			return true
		}
		for _, e := range c.Elements {
			if e.Class == engine.ClassYear && e.Value == value {
				return true
			}
		}
	case "tag":
		for _, e := range c.Elements {
			if e.Class == engine.ClassTag && strings.Contains(e.Value, value) {
				return true
			}
		}
	}
	return false
}

// SampleDeck 从全量卡库抽一副牌盒(默认 78 张,规则书参数表 52-104):
// 纯分层抽样、零保送(D16,CardPipeline 口径 P6)——档位等额分席 × 档位内
// 组牌类比例最大余数法 + 余席回填 + 零覆盖兜底,层内固定 seed 随机;
// 再做图约束修复(高级算法①:要素频率上限 DefaultMaxElemFreq、搭档密度
// [MinPartners, MaxPartners])。同库同 n 同 seed 牌盒逐字节一致。
// 需要自定义频率上限用 SampleDeckBox。
func SampleDeck(library []engine.Card, n int, seed int64) []engine.Card {
	return SampleDeckBox(library, n, seed, DefaultMaxElemFreq)
}

// SampleDeckBox 同 SampleDeck,但可指定盒内单要素值频率上限 maxElemFreq
// (<=0 表示不设频率上限;搭档密度约束始终生效)。
func SampleDeckBox(library []engine.Card, n int, seed int64, maxElemFreq int) []engine.Card {
	if n <= 0 || len(library) == 0 {
		return []engine.Card{}
	}
	// R1 提速:与 seed 无关的 O(库) 结构(shared 要素集/分层分组/牌->层映射)缓存为帧复用,
	// 免去每手全库重扫。分层语义不变,序列化结果与旧实现逐字节一致(D16)。
	f := deckFrameFor(library)
	keys := f.keys
	byKey := f.byKey
	if n > len(f.lib) {
		n = len(f.lib)
	}

	// 层内洗牌定序(每个层一条确定性「洗牌序列」,后续回填/兜底/修复引用其位次)。
	// 全库牌拷入可复用缓冲的不相交区段再各自洗牌(R1:池化降 GC 压力;区段互不重叠、
	// 洗牌互不影响;rng 逐层消费与旧实现同序,故洗牌结果逐字节一致,D16)。
	rng := mrand.New(mrand.NewSource(seed))
	seqBuf := borrowSeqBuf(len(f.lib))
	defer returnSeqBuf(seqBuf)
	seq := make(map[layerKey][]engine.Card, len(keys))
	off := 0
	for _, k := range keys {
		s := seqBuf[off : off+len(byKey[k])]
		copy(s, byKey[k])
		rng.Shuffle(len(s), func(a, b int) { s[a], s[b] = s[b], s[a] })
		seq[k] = s
		off += len(byKey[k])
	}

	// 1) 档位等额分席:每档 base 席,余 R 席按档内候选数降序补(同数比档位升序)
	type bucketInfo struct {
		key  float64
		size int
	}
	buckets := []bucketInfo{}
	for i := range keys {
		b := keys[i].bucket
		if len(buckets) == 0 || buckets[len(buckets)-1].key != b {
			buckets = append(buckets, bucketInfo{key: b})
		}
		buckets[len(buckets)-1].size += len(byKey[keys[i]])
	}
	base := n / len(buckets)
	remB := n - base*len(buckets)
	sort.SliceStable(buckets, func(i, j int) bool {
		if buckets[i].size != buckets[j].size {
			return buckets[i].size > buckets[j].size
		}
		return buckets[i].key < buckets[j].key
	})
	bucketSeats := map[float64]int{}
	for i, b := range buckets {
		bucketSeats[b.key] = base
		if i < remB {
			bucketSeats[b.key]++
		}
	}

	// 2) 档位内组牌类比例最大余数法
	sel := map[layerKey]int{}
	for _, b := range buckets {
		layers := []layerKey{}
		total := 0
		for _, k := range keys {
			if k.bucket == b.key {
				layers = append(layers, k)
				total += len(byKey[k])
			}
		}
		seats := bucketSeats[b.key]
		used := 0
		type frac struct {
			k    layerKey
			rest int // 小数部分分子
		}
		fracs := []frac{}
		for _, k := range layers {
			q := seats * len(byKey[k]) / total
			sel[k] = q
			used += q
			fracs = append(fracs, frac{k: k, rest: seats*len(byKey[k]) % total})
		}
		sort.SliceStable(fracs, func(i, j int) bool {
			if fracs[i].rest != fracs[j].rest {
				return fracs[i].rest > fracs[j].rest
			}
			return fracs[i].k.class < fracs[j].k.class
		})
		for i := 0; i < seats-used; i++ {
			sel[fracs[i%len(fracs)].k]++
		}
	}

	// 3) 余席回填:层拟给席位封顶层容量,总席不足 n 时反复给「剩余容量最大」的层
	// +1(同容量比 (档位,类号) 升序),直到满 n 或全层满。
	for {
		total := 0
		for _, k := range keys {
			if sel[k] > len(byKey[k]) {
				sel[k] = len(byKey[k])
			}
			total += sel[k]
		}
		if total >= n {
			break
		}
		bestK := layerKey{}
		bestRest, found := 0, false
		for _, k := range keys {
			rest := len(byKey[k]) - sel[k]
			if rest <= 0 {
				continue
			}
			if !found || rest > bestRest || (rest == bestRest && lessKey(k, bestK)) {
				bestK, bestRest, found = k, rest, true
			}
		}
		if !found {
			break // 全层满(库不足 n 张)
		}
		sel[bestK]++
	}

	// 4) 零覆盖兜底:库中存在的组牌类 c∈{1..5} 在已选牌里 0 张时,
	// 从「席位≥2 且类≠c」的最大层挪 1 席给「c 类且还有未选候选」的层
	// (按层剩余容量升序取第一个);换人确定性 = 被挪层回退洗牌序列末位、
	// 目标层补入洗牌序列首位(剩余位)。
	present := map[int]bool{}
	for _, k := range keys {
		present[k.class] = true
	}
	for c := 1; c <= 5; c++ {
		if !present[c] {
			continue
		}
		for {
			if countClass(keys, sel, c) > 0 {
				break
			}
			donor, donorOK := layerKey{}, false
			for _, k := range keys {
				if k.class == c || sel[k] < 2 {
					continue
				}
				if !donorOK || sel[k] > sel[donor] || (sel[k] == sel[donor] && lessKey(k, donor)) {
					donor, donorOK = k, true
				}
			}
			target, targetOK := layerKey{}, false
			for _, k := range keys {
				if k.class != c || len(byKey[k])-sel[k] <= 0 {
					continue
				}
				rest := len(byKey[k]) - sel[k]
				if !targetOK {
					target, targetOK = k, true
					continue
				}
				tRest := len(byKey[target]) - sel[target]
				if rest < tRest || (rest == tRest && lessKey(k, target)) {
					target = k
				}
			}
			if !donorOK || !targetOK {
				break
			}
			sel[donor]-- // 回退洗牌序列末位
			sel[target]++ // 补入洗牌序列首位(剩余位)
		}
	}

	// 5) 图约束修复(高级算法①):贪心/局部交换最小化惩罚(超频/死牌/枢纽),
	// 交换保持档位分席不变(仅在同档内换人)
	picked := repairBox(f, seq, sel, maxElemFreq)

	// 组盒:层内按洗牌序列位次取选中牌,层序 = 层键升序
	out := make([]engine.Card, 0, n)
	for _, k := range keys {
		out = append(out, picked[k]...)
	}
	// 发牌顺序整体打散(同 rng 流延续,确定性保持)
	rng.Shuffle(len(out), func(a, b int) { out[a], out[b] = out[b], out[a] })
	return out
}

// countClass 统计已选牌里组牌类为 c 的张数。
func countClass(keys []layerKey, sel map[layerKey]int, c int) int {
	n := 0
	for _, k := range keys {
		if k.class == c {
			n += sel[k]
		}
	}
	return n
}

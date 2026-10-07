// Package engine 是 AniTexas 的规则引擎：纯函数、无 IO、无全局态（D6）。
// 只认识牌，不认识「房间」「下注」；玩法规则真源 docs/rules.html v1.0，
// 类型契约与 §4.1 逐字对齐。
package engine

import "math"

// 要素类常量（规则书 §2）：编号即优先级，越小越强。
const (
	ClassDirector   = 1 // 监督
	ClassStudio     = 2 // 公司
	ClassTag        = 3 // 标签
	ClassYear       = 4 // 年份
	ClassOriginType = 5 // 原作类型
)

// 牌型级数常量（规则书 §4 牌型排行榜，10 级最高）。
const (
	TierGoldGen    = 10 // 黄金世代：同要素×5 且这 5 张年份五连
	TierFateUnion  = 9  // 命运共同体：同要素×5
	TierMasterwork = 8  // 四大名作：同要素×4 + 散1
	TierEnsemble   = 7  // 合奏：同×3 + 同×2（要素不同、卡不相交）
	TierEra        = 6  // 年代物语：年份五连（一年一张，不绕圈）
	TierTrilogy    = 5  // 三部曲物语：同×3 且这 3 张年份三连 + 散2
	TierTriple     = 4  // 三连星：同×3 + 散2
	TierQuartet    = 3  // 四手联弹：同×2 + 同×2（卡不相交）+ 散1
	TierDuet       = 2  // 二重唱：同×2 + 散3
	TierSolo       = 1  // 独奏：无成组
)

// Element 是一个要素：五类要素的取值（规则书 §2）。
// 身份 = (Class, Value)，同要素取值即成组依据。
type Element struct {
	Class int    // 要素类：ClassDirector..ClassOriginType
	Value string // 要素取值，同类内唯一标识（如「石原立也」「京都动画」「2007」）
}

// Card 是一张牌（规则书 §2 牌面）。
// Bucket 为 Score 的档位分，应由调用方以 Bucket() 填充，引擎比较时直接取用。
type Card struct {
	ID       int64     // 牌 id，兜底比较用（同牌集永不平局的最后防线）
	Title    string    // 作品名（引擎不参与比较，仅供展示）
	Score    float64   // 原始分（0.1 粒度，兜底比较用）
	Bucket   float64   // 档位分 = Bucket(Score)，20 档（规则书 §2）
	Year     int       // 年份（黄金世代/年代物语/三部曲物语的连续判定）
	// Votes 是作品标注数（评分人数），仅供运行时按热度收池（room.computeDeckLib）；
	// 引擎的比较/成组/发牌逻辑均不读此字段，故不影响发牌确定性与判定结果。
	Votes    int       `json:"votes,omitempty"`
	Elements []Element // 要素清单（五类，隐藏模式的 L2）
}

// HandEval 是一手牌的识别结果。
type HandEval struct {
	Tier     int       // 牌型级数：TierGoldGen..TierSolo
	Tiebreak []float64 // 全序比较向量（规则书 §5 比较链）：字典序比对，同位更大者胜
	Groups   [][]int   // 成组牌下标（坐标系 = Eval5/Best7 入参）；顺序 = 大组到小组、强组到弱组，组内与 Tiebreak 同序
}

// Bucket 把原始分映射为档位分：round(score*2)/2，半值向上（规则书 §2 的 20 档）。
func Bucket(score float64) float64 {
	return math.Floor(score*2+0.5) / 2
}

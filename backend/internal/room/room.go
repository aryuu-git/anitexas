package room

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"anitexas/backend/internal/engine"
	"anitexas/backend/internal/game"
	"anitexas/backend/internal/model"
	"anitexas/backend/internal/store"
)

// Link 是已入座玩家的下行通道（api 的 WS 连接实现）。
// Send 必须非阻塞；投递失败由实现方自行断开（慢消费者断开重连走快照恢复，A4.3）。
type Link interface {
	Send(msg []byte)
}

// 常见错误（api 映射为 HTTP 状态码 / error 消息）。
var (
	ErrRoomClosed = errors.New("房间已解散")
	ErrRoomFull   = errors.New("房间已满")
	ErrBadSeat    = errors.New("座位无效")
	// ErrNickTaken 是同昵称但无恢复凭据（v2 身份契约：不静默抢占他人座位）。
	ErrNickTaken    = errors.New("nick_taken: 昵称已被占用，请换一个或使用原设备恢复")
	ErrNotPlaying   = errors.New("当前没有进行中的牌局")
	ErrBadEmote     = errors.New("表情 key 非法")
	ErrEmoteCool    = errors.New("表情冷却中，10 秒一次")
	ErrChatDisabled = errors.New("房主已关闭聊天")
	ErrChatTooLong  = errors.New("发言超长（≤120 字）")
	ErrChatThrottle = errors.New("发言太快，稍候再发")
)

// EmoteCooldown 是表情冷却（D15：10 秒/座位，防刷屏）。
const EmoteCooldown = 10 * time.Second

// occupant 是一个座位的占用者（人或 bot）。
type occupant struct {
	nick  string
	isBot bool
	ready bool // 准备开局（每手消耗一次）
	// joined 表示是否已 g.Join 进本桌对局（game 侧的昵称/身份绑定）。
	joined bool
	// link 是下行通道；nil = 未连接（bot 或掉线）。掉线者的座位由 bot 策略代打，
	// 保证牌局不卡死（超时自动动作另有 game 兜底，A3.6）。
	link Link
	// detachedAt 是断线时刻（Detach 记录、Attach 清零）；零值 = 在线/未断线过。
	// 断线超 DISCONNECT_GRACE_SECONDS 由巡检自动离席（见 reapLocked）。
	detachedAt time.Time
	// pendingLeave 为「局内离座、手牌结束后生效」标记。
	pendingLeave bool
	// v2 身份：participantId 是房间实例内的稳定玩家标识，resumeToken 是其恢复凭据。
	participantID string
	resumeToken   string
	// joinRequestID 是最近一次 REST 加入请求 id（幂等：重复请求复用同座位）。
	joinRequestID string
}

// Summary 是 REST 房间列表条目。
type Summary struct {
	Code       string `json:"code"`
	Host       string `json:"host"`
	AutoReveal bool   `json:"autoReveal"` // D14：true = 开局全揭示
	SmallBlind int    `json:"smallBlind"`
	BigBlind   int    `json:"bigBlind"`
	Seats      int    `json:"seats"`
	Players    int    `json:"players"` // 已占座人数（含 bot）
	Status     string `json:"status"`
	// ===== v2 预览扩展（首页/加入预览）=====
	Phase      string `json:"phase"` // waiting | preflop | ... | settled
	HandSeq    int    `json:"handSeq"`
	HumanCount int    `json:"humanCount"`
	BotCount   int    `json:"botCount"`
	Joinable   bool   `json:"joinable"`
	// ===== 第二轮房间策略 =====
	RoomKind         string `json:"roomKind"`
	BotPolicy        string `json:"botPolicy"`
	TargetHumanCount int    `json:"targetHumanCount"`
	NextHandPolicy   string `json:"nextHandPolicy"`
	HostSeat         int    `json:"hostSeat"`
}

// preppedDeck 是预生成好的一手牌盒 + 其种子（种子用于可验证发牌固证，frontend-contract §2）。
type preppedDeck struct {
	cards []engine.Card
	seed  int64
}

// Timing 是房间节奏参数（config 注入，ManagerOptions 透传）：
// 零值 = 该机制关闭（维持旧语义：无下一手排程、不回收断线/空闲房、重买不限次）。
type Timing struct {
	// NextHandDelay 是下一手自动开局延迟（NEXT_HAND_DELAY_SECONDS）。
	// >0 时 settled 后广播 nextHand 并排程定时器，到点 active≥2 自动开局；0 = 关闭。
	NextHandDelay time.Duration
	// DisconnectGrace 是断线回收宽限（DISCONNECT_GRACE_SECONDS）：
	// 真人 Detach 超时后 playing 标 pendingLeave 收手生效、waiting 立即 freeSeat；0 = 不回收。
	DisconnectGrace time.Duration
	// IdleTTL 是空闲房回收（IDLE_ROOM_TTL_MINUTES）：waiting 且无在座人类持续超时
	// → closed + Manager 摘除；0 = 不回收（无在座人类仍立即解散）。
	IdleTTL time.Duration
	// MaxRebuys 是每座位重买上限（MAX_REBUYS），注入 game.Config.MaxRebuys；<=0 不限次。
	MaxRebuys int
	// ReapInterval 是巡检周期（断线回收/空闲房回收的检查间隔）。
	// 0 = 自动取 min(宽限,TTL)/4（仅测试显式调小）。
	ReapInterval time.Duration
}

// reapAutoInterval 算默认巡检周期（调用方持 r.mu 无关，纯函数）。
func (tm Timing) reapAutoInterval() time.Duration {
	m := tm.DisconnectGrace
	if m <= 0 || (tm.IdleTTL > 0 && tm.IdleTTL < m) {
		m = tm.IdleTTL
	}
	if m <= 0 {
		return 0
	}
	if d := m / 4; d > 0 {
		return d
	}
	return time.Millisecond
}

// Room 是一桌：座位管理 + 一局局牌的驱动（D12：一桌一 goroutine 消费 game 事件，
// 其余入口（WS/REST）在互斥锁下短临界区操作；game 侧动作入队串行）。
type Room struct {
	mu sync.Mutex

	id                 string // rooms.id（uuid）
	code               string // 6 位房间码
	host               string // 房主昵称（展示用）
	cfg                model.RoomConfig
	bot                BotParams
	turnTimeoutSeconds int

	st      *store.Store
	library []engine.Card // 全量卡池（game.SampleDeck 输入）
	// deckLib 是本桌实际抽盒用的卡库：theme 策略按 themeFilter 过滤后（不足 DeckSize
	// 回退全库），一次性算定、多手复用——保证帧缓存按稳定切片命中（R1）。
	deckLib []engine.Card

	seats  []*occupant // 长度 = cfg.Seats
	status string

	// emoteAt 是各座位上次表情时刻（D15 冷却计账）。
	emoteAt map[int]time.Time
	// chatAt 是各座位上次发言时刻（frontend-contract §1 节流计账）。
	chatAt map[int]time.Time

	// game 为本桌对局长实例（GameCore 方案 A）：筹码/积分跨手延续，Start 可重复调，
	// 每手开前 SetDeck 换新牌池。nil = 尚未开局。
	game *game.Game

	handSeq   int   // 房间内第几手（hands.seq）
	handID    int64 // 当前手牌的 DB id
	actionSeq int   // 手内动作序号（actions.seq）
	// handSeed 是本手牌盒种子（game.SampleDeck 入参）；handSeedCommit = SHA-256(seed) hex
	// 小写固证（frontend-contract §2）。新一手重置。
	handSeed       int64
	handSeedCommit string
	// 本手节奏指标（只记时长与公开动作数，不含牌面/私密信息）。
	handStartedAt time.Time
	handActCount  int

	// 本手攒批的动作/揭示账（一手一事务批量提交，见 store.AppendHandLog）。
	pendingActions []model.ActionRecord
	pendingReveals []model.RevealLogRecord

	// nextDeck 是后台预生成的下一手牌盒（当前手进行中抽好，seed 独立；
	// 未就绪/失败则开手时现抽回退）。
	nextDeck *preppedDeck

	seq int64 // 下行信封递增序号（§5：客户端据此丢弃乱序旧事件）

	botTimer *time.Timer
	botGen   int // bot 定时器代际：旧定时器到期后自行失效

	// bot 加注计数（防 min-raise 拉锯不收敛，见 BotParams.MaxRaises）：
	// 每座位「本条街面对下注的再加注次数」+ 计数对应的下注街，换街/换手即重置。
	botRaiseCount map[int]int
	botRaisePhase map[int]string

	// 房主身份由服务端座位绑定（不是昵称比较，也不靠按钮隐藏）。
	hostParticipantID string
	hostSeat          int

	// 节奏参数（Timing 注入；零值 = 机制关闭，见 Timing 注释）。
	timing        Timing
	nextHandTimer *time.Timer // 下一手自动开局定时器
	nextHandGen   int         // 下一手定时器代际：策略切换/取消后旧回调失效
	reapTimer     *time.Timer // 断线/空闲巡检定时器（自续排程）
	emptySince    time.Time   // 无在座人类的起算时刻（空闲房回收 TTL 起点）
	poolFallback  bool        // 主题过滤过窄已回退全库（PoolInfo.fallback 真源）
	seedRevealed  bool        // 本手 seed 已揭示（摊牌后可见，之前 snapshot.seed 为 null）

	// ===== v2 权威状态（见 state.go）=====
	revision        int64                   // 房间可见状态版本（每次可见事务 +1）
	latestSnapshots []model.SnapshotPayload // 最近一次事务的全座位快照（按座位视角）
	latestValid     bool
	pendingEvents   []pendingEvent                          // 待随下一帧下发的过程事件
	pendingReceipts map[int][]model.CommandReceipt          // 待随下一帧下发的命令回执（按座位）
	receipts        map[int]map[string]model.CommandReceipt // 命令回执去重缓存
	eventSeq        int64
	recentEvents    []model.ExperienceEvent
	lastResult      *model.HandResult
	nextHandAt      *int64
	// recaptureCommits 表示接下来 N 个 game commit 需以 game 当前状态重拍
	// （结算后 room 立即重买/离席，commit 快照是处置前的旧筹码）。
	recaptureCommits int
	// handShowdown 是本手摊牌快照（结算摘要的 showdown 区）。
	handShowdown []model.ShowdownHand

	stopCh     chan struct{}
	closed     bool
	onDissolve func(*Room) // 解散回调（Manager 摘除索引）
}

// NewRoom 建桌（Manager 调用）。cfg 必须已通过 config 校验；timing 是节奏参数
// （下一手排程/断线回收/空闲房回收/重买上限，零值 = 机制关闭）。
func NewRoom(id, code, host string, cfg model.RoomConfig, turnTimeoutSeconds int, bot BotParams,
	library []engine.Card, st *store.Store, onDissolve func(*Room), timing Timing) *Room {
	cfg = model.NormalizeRoomConfig(cfg)
	r := &Room{
		id:                 id,
		code:               code,
		host:               host,
		cfg:                cfg,
		bot:                bot,
		turnTimeoutSeconds: turnTimeoutSeconds,
		st:                 st,
		library:            library,
		seats:              make([]*occupant, cfg.Seats),
		status:             model.StatusWaiting,
		emoteAt:            make(map[int]time.Time),
		chatAt:             make(map[int]time.Time),
		botRaiseCount:      make(map[int]int),
		botRaisePhase:      make(map[int]string),
		receipts:           make(map[int]map[string]model.CommandReceipt),
		pendingReceipts:    make(map[int][]model.CommandReceipt),
		timing:             timing,
		hostSeat:           -1,
		stopCh:             make(chan struct{}),
		onDissolve:         onDissolve,
	}
	// 练习房在创建时就补齐机器人（创建前摘要可见）；朋友房绝不自动补位。
	if cfg.RoomKind == model.RoomKindPractice && cfg.BotPolicy == model.BotPolicyFill {
		for i := range r.seats {
			r.seats[i] = &occupant{nick: BotNick(i), isBot: true, ready: true}
		}
	}
	r.deckLib = r.computeDeckLib()
	r.scheduleReapLocked() // 巡检（断线回收/空闲房回收）自续排程，Close 时停
	return r
}

// computeDeckLib 算本桌抽盒用卡库（D11 主题池 = 过滤后再分层，frontend-contract §3）：
// 先按作品标注数下限收池（RoomConfig.MinVotes，运行时热度筛选），再走主题过滤：
//   - MinVotes > 0 时先 FilterMinVotes；过滤后不足以撑 DeckSize 时回退全库并记日志
//     （与主题回退同语义，防过窄开局失败）；
//   - theme 策略且带 themeFilter 时再按过滤项筛卡库；结果不足以撑 DeckSize 时回退全库并记日志。
//
// 一次性算定后存 r.deckLib，多手复用（帧缓存按稳定切片命中，R1）。
func (r *Room) computeDeckLib() []engine.Card {
	lib := r.library
	if r.cfg.MinVotes > 0 {
		filtered := game.FilterMinVotes(lib, r.cfg.MinVotes)
		if len(filtered) >= r.cfg.DeckSize {
			lib = filtered
		} else {
			slog.Warn("标注数过滤池不足以撑牌池，回退全库",
				"room", r.code, "minVotes", r.cfg.MinVotes, "filtered", len(filtered), "need", r.cfg.DeckSize)
		}
	}
	if r.cfg.DeckStrategy != "theme" || r.cfg.ThemeFilter == nil {
		return lib
	}
	filtered := game.FilterTheme(lib, r.cfg.ThemeFilter.Kind, r.cfg.ThemeFilter.Value)
	if len(filtered) >= r.cfg.DeckSize {
		return filtered
	}
	slog.Warn("主题过滤池不足以撑牌池，回退全库",
		"room", r.code, "filtered", len(filtered), "need", r.cfg.DeckSize,
		"kind", r.cfg.ThemeFilter.Kind, "value", r.cfg.ThemeFilter.Value)
	r.poolFallback = true // PoolInfo.fallback 真源：主题过滤过窄已回退全库
	return lib
}

// Code 返回房间码。
func (r *Room) Code() string { return r.code }

// ID 返回房间内部 id。
func (r *Room) ID() string { return r.id }

// Config 返回建房配置。
func (r *Room) Config() model.RoomConfig { return r.cfg }

// Status 返回房间状态（waiting / playing / closed）。
func (r *Room) Status() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.status
}

// Summary 汇总 REST 列表条目。
func (r *Room) Summary() Summary {
	r.mu.Lock()
	defer r.mu.Unlock()
	players, humans, bots := 0, 0, 0
	for _, o := range r.seats {
		if o != nil {
			players++
			if o.isBot {
				bots++
			} else {
				humans++
			}
		}
	}
	phase := model.PhaseWaiting
	if r.game != nil {
		phase = string(r.game.SnapshotFor(0).Phase)
	}
	return Summary{
		Code: r.code, Host: r.host, AutoReveal: r.cfg.AutoReveal,
		SmallBlind: r.cfg.SmallBlind, BigBlind: r.cfg.BigBlind,
		Seats: r.cfg.Seats, Players: players, Status: r.status,
		Phase: phase, HandSeq: r.handSeq, HumanCount: humans, BotCount: bots,
		// 满座时预览直接标不可加入，避免用户点进加入后才收到 room_full。
		Joinable: r.status != model.StatusClosed && players < r.cfg.Seats,
		RoomKind: r.cfg.RoomKind, BotPolicy: r.cfg.BotPolicy,
		TargetHumanCount: r.cfg.TargetHumanCount, NextHandPolicy: r.cfg.NextHandPolicy,
		HostSeat: r.hostSeat,
	}
}

// Join 是兼容 v1 的占座入口（同昵称静默复用座位）。REST 走 JoinIdentity。
func (r *Room) Join(nick string) (int, error) {
	seat, _, _, err := r.joinLocked(nick, "", "", "", false)
	return seat, err
}

// JoinIdentity 是 v2 占座：凭 resumeToken 恢复原座位；无凭据的同昵称请求返回
// ErrNickTaken（不静默抢占他人身份）；新入座签发 participantId + resumeToken。
func (r *Room) JoinIdentity(nick, resumeToken, requestID, roomInstance string) (int, string, string, error) {
	return r.joinLocked(nick, resumeToken, requestID, roomInstance, true)
}

func (r *Room) joinLocked(nick, resumeToken, requestID, roomInstance string, strict bool) (int, string, string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.status == model.StatusClosed {
		return -1, "", "", ErrRoomClosed
	}
	if roomInstance != "" && roomInstance != r.id {
		return -1, "", "", errStaleState
	}
	// 凭据恢复：resumeToken 命中即回原座位（昵称以座位为准）。
	if resumeToken != "" {
		for i, o := range r.seats {
			if o != nil && !o.isBot && o.resumeToken == resumeToken {
				o.detachedAt = time.Time{}
				if requestID != "" {
					o.joinRequestID = requestID
				}
				r.updateHostLocked()
				return i, o.participantID, o.resumeToken, nil
			}
		}
	}
	// 幂等：同一 joinRequestId 重复请求复用同座位。
	if requestID != "" {
		for i, o := range r.seats {
			if o != nil && o.joinRequestID == requestID {
				return i, o.participantID, o.resumeToken, nil
			}
		}
	}
	// 兼容旧客户端：同昵称静默复用原座位。
	if !strict {
		for i, o := range r.seats {
			if o != nil && !o.isBot && o.nick == nick {
				return i, o.participantID, o.resumeToken, nil
			}
		}
	} else {
		for _, o := range r.seats {
			if o != nil && !o.isBot && o.nick == nick {
				return -1, "", "", ErrNickTaken
			}
		}
	}
	// 空位优先。
	for i, o := range r.seats {
		if o == nil {
			pid, token := newIdentity()
			r.seats[i] = &occupant{nick: nick, participantID: pid, resumeToken: token, joinRequestID: requestID}
			r.updateHostLocked()
			return i, pid, token, nil
		}
	}
	// 替换 bot：继承座位与在局状态，立即改绑 game 侧昵称。
	for i, o := range r.seats {
		if o.isBot {
			pid, token := newIdentity()
			o.isBot = false
			o.nick = nick
			o.ready = false
			o.link = nil
			o.participantID = pid
			o.resumeToken = token
			o.joinRequestID = requestID
			if o.joined && r.game != nil {
				if err := r.game.Join(i, nick, false); err != nil {
					slog.Warn("替换 bot 后改绑 game 失败", "room", r.code, "seat", i, "err", err)
				}
			}
			r.updateHostLocked()
			return i, pid, token, nil
		}
	}
	return -1, "", "", ErrRoomFull
}

// newIdentity 生成房间实例内的玩家标识与恢复凭据。
func newIdentity() (participantID, resumeToken string) {
	return "p_" + uuid.NewString(), "r_" + uuid.NewString()
}

// updateHostLocked 维护房主座位绑定：房主座位失效时转交给仍在座的最早真人；
// 没有真人则标记为无房主（等待阶段由 checkDissolve 收桌，局内不会因此开局）。
func (r *Room) updateHostLocked() {
	r.hostSeat = -1
	if r.hostParticipantID != "" {
		for i, o := range r.seats {
			if o != nil && !o.isBot && o.participantID == r.hostParticipantID {
				r.host = o.nick
				r.hostSeat = i
				return
			}
		}
		r.hostParticipantID = ""
	}
	for i, o := range r.seats {
		if o == nil || o.isBot || o.participantID == "" {
			continue
		}
		r.hostParticipantID = o.participantID
		r.host = o.nick
		r.hostSeat = i
		return
	}
}

// isHostLocked 判断座位是否为服务端确认的房主。
func (r *Room) isHostLocked(seat int) bool {
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil || r.seats[seat].isBot {
		return false
	}
	return r.hostParticipantID != "" && r.seats[seat].participantID == r.hostParticipantID
}

// humanBotCountsLocked 统计真人/机器人数量（机器人不是朋友人数）。
func (r *Room) humanBotCountsLocked() (humans, bots int) {
	for _, o := range r.seats {
		if o == nil {
			continue
		}
		if o.isBot {
			bots++
		} else {
			humans++
		}
	}
	return humans, bots
}

// startStatusLocked 派生“房主现在能否开始”和唯一阻塞原因（服务端真源）。
func (r *Room) startStatusLocked() (bool, string) {
	if r.status != model.StatusWaiting {
		return false, "本手正在进行"
	}
	if r.hostParticipantID == "" || r.hostSeat < 0 {
		return false, "房主尚未入座"
	}
	humans, bots := r.humanBotCountsLocked()
	// 有其他真人时，房主断线必须暂停开局；单人练习房不受此限（房主回来即可开）。
	if r.seats[r.hostSeat].link == nil && humans > 1 {
		return false, "房主连接断开，重连后可开始"
	}
	if r.cfg.RoomKind == model.RoomKindPractice {
		if humans+bots < 2 {
			return false, "至少需要 2 位参局者"
		}
	} else if humans < 2 {
		return false, "至少需要 2 位真人，可邀请朋友或明确添加机器人"
	}
	// 先报“具体谁没准备好/掉线”，再报人数目标缺口：取消准备必须能立刻被房主看见。
	for i, o := range r.seats {
		if o == nil || o.isBot || o.pendingLeave {
			continue
		}
		if !o.ready {
			return false, fmt.Sprintf("等待 %s 准备", o.nick)
		}
		// 房主连接已在上面单独判定（多人房断线必须暂停）；单人练习房允许无链路观测。
		if o.link == nil && i != r.hostSeat {
			return false, fmt.Sprintf("等待 %s 重连", o.nick)
		}
	}
	need := r.cfg.TargetHumanCount
	if need < 2 {
		need = 2
	}
	if humans+bots < need {
		return false, fmt.Sprintf("还差 %d 位参局者（当前 %d/%d 人）", need-humans-bots, humans+bots, need)
	}
	return true, ""
}

// Attach 挂接 WS 连接并直发全量快照（join 握手成功后；断线重连同样走这里恢复，A4.3）。
// v2：同时下发权威 state 帧（reason=join），客户端据此进入 live。
func (r *Room) Attach(seat int, link Link) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil {
		return ErrBadSeat
	}
	r.seats[seat].link = link
	r.seats[seat].pendingLeave = false
	r.seats[seat].detachedAt = time.Time{} // 重连成功，断线计时清零
	r.updateHostLocked()
	// 新连接落座后必须让已在座客户端看到人数/连接变化（REST join 本身不广播）。
	r.refreshOthersLocked(seat)
	r.sendLocked(seat, model.TypeSnapshot, r.snapshotLocked(seat))
	var receipts []model.CommandReceipt
	if len(r.pendingReceipts[seat]) > 0 {
		receipts = r.pendingReceipts[seat]
		delete(r.pendingReceipts, seat)
	}
	r.sendStateLocked(seat, stateReasonJoin, nil, receipts)
	r.tickBotsLocked()
	return nil
}

// Detach 摘除 WS 连接（断线）。座位保留，掉线期间由 bot 策略代打；
// 记录断线时刻，超 DISCONNECT_GRACE_SECONDS 由巡检自动离席（reapLocked）。
func (r *Room) Detach(seat int) {
	r.detachLink(seat, nil)
}

// DetachLink 只摘除指定连接（连接代际保护：旧连接延迟关闭不会踢掉新连接）。
func (r *Room) DetachLink(seat int, link Link) {
	r.detachLink(seat, link)
}

func (r *Room) detachLink(seat int, link Link) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil {
		return
	}
	if link != nil && r.seats[seat].link != link {
		return // 旧连接：已不是当前下行通道
	}
	r.seats[seat].link = nil
	r.seats[seat].detachedAt = time.Now()
	r.tickBotsLocked()
	if !r.closed {
		r.refreshStateLocked() // canStart 可能因房主/队友断线变化
	}
}

// Ready 准备：只表达“我已准备好”，绝不触发开局。朋友房开局只能由房主 start。
func (r *Room) Ready(seat int) error {
	return r.ReadyWithMeta(seat, model.CommandMeta{})
}

// ReadyWithMeta 是 v2 准备命令：去重回执 + expected 校验；状态变化广播新帧。
func (r *Room) ReadyWithMeta(seat int, meta model.CommandMeta) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil || r.seats[seat].isBot {
		return ErrBadSeat
	}
	if rc, ok := r.lookupReceiptLocked(seat, meta.RequestID); ok {
		r.replayReceiptLocked(seat, rc)
		return nil
	}
	if err := r.validateMetaLocked(meta); err != nil {
		r.rejectCommandLocked(seat, meta.RequestID, "stale_state", err.Error())
		return err
	}
	if r.status != model.StatusWaiting {
		r.rejectCommandLocked(seat, meta.RequestID, "not_waiting", "本手进行中，结束时可准备下一手")
		return ErrNotPlaying
	}
	r.seats[seat].ready = true
	r.queueAppliedReceiptLocked(seat, meta.RequestID)
	r.broadcastLocked(model.TypeReadied, model.ReadiedPayload{Seat: seat})
	r.refreshStateLocked()
	return nil
}

// CancelReadyWithMeta 取消准备（服务端确认后才生效；房主 start 会看到原因）。
func (r *Room) CancelReadyWithMeta(seat int, meta model.CommandMeta) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil || r.seats[seat].isBot {
		return ErrBadSeat
	}
	if rc, ok := r.lookupReceiptLocked(seat, meta.RequestID); ok {
		r.replayReceiptLocked(seat, rc)
		return nil
	}
	if err := r.validateMetaLocked(meta); err != nil {
		r.rejectCommandLocked(seat, meta.RequestID, "stale_state", err.Error())
		return err
	}
	if r.status != model.StatusWaiting {
		r.rejectCommandLocked(seat, meta.RequestID, "not_waiting", "本手进行中，不能取消准备")
		return ErrNotPlaying
	}
	r.seats[seat].ready = false
	r.queueAppliedReceiptLocked(seat, meta.RequestID)
	r.refreshStateLocked()
	return nil
}

// StartGame 是唯一开局入口：仅房主、仅等待阶段、全部条件原子校验；同 requestId 幂等。
func (r *Room) StartGame(seat int, p model.StartPayload) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil || r.seats[seat].isBot {
		return ErrBadSeat
	}
	if rc, ok := r.lookupReceiptLocked(seat, p.RequestID); ok {
		r.replayReceiptLocked(seat, rc)
		return nil
	}
	if err := r.validateMetaLocked(p.CommandMeta); err != nil {
		r.rejectCommandLocked(seat, p.RequestID, "stale_state", err.Error())
		return err
	}
	if !r.isHostLocked(seat) {
		r.rejectCommandLocked(seat, p.RequestID, "not_host", "只有房主可以开始游戏")
		return errNotHost
	}
	if p.TargetHumanCount != nil {
		if err := r.setTargetLocked(*p.TargetHumanCount); err != nil {
			r.rejectCommandLocked(seat, p.RequestID, "bad_target", err.Error())
			return err
		}
	}
	if ok, reason := r.startStatusLocked(); !ok {
		r.rejectCommandLocked(seat, p.RequestID, "cannot_start", reason)
		return fmt.Errorf("cannot_start: %s", reason)
	}
	r.queueAppliedReceiptLocked(seat, p.RequestID)
	if err := r.beginHandLocked(); err != nil {
		delete(r.pendingReceipts, seat)
		r.rejectCommandLocked(seat, p.RequestID, errCode(err, "start_failed"), err.Error())
		return err
	}
	return nil
}

// SetTarget 明确调整期望参局人数（朋友房“以当前人数开始”的显式前置操作）。
func (r *Room) SetTarget(seat int, p model.SetTargetPayload) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil || r.seats[seat].isBot {
		return ErrBadSeat
	}
	if rc, ok := r.lookupReceiptLocked(seat, p.RequestID); ok {
		r.replayReceiptLocked(seat, rc)
		return nil
	}
	if err := r.validateMetaLocked(p.CommandMeta); err != nil {
		r.rejectCommandLocked(seat, p.RequestID, "stale_state", err.Error())
		return err
	}
	if !r.isHostLocked(seat) {
		r.rejectCommandLocked(seat, p.RequestID, "not_host", "只有房主可以调整人数")
		return errNotHost
	}
	if err := r.setTargetLocked(p.TargetHumanCount); err != nil {
		r.rejectCommandLocked(seat, p.RequestID, "bad_target", err.Error())
		return err
	}
	r.queueAppliedReceiptLocked(seat, p.RequestID)
	r.refreshStateLocked()
	return nil
}

func (r *Room) setTargetLocked(n int) error {
	if n < 2 || n > r.cfg.Seats {
		return fmt.Errorf("目标人数需在 2–%d 之间", r.cfg.Seats)
	}
	if r.cfg.TargetHumanCount == n {
		return nil
	}
	r.cfg.TargetHumanCount = n
	// 目标人数变化会改变开局条件：让在场真人重新确认准备，避免用旧 ready 直接开局。
	for _, o := range r.seats {
		if o != nil && !o.isBot {
			o.ready = false
		}
	}
	return nil
}

// AddBot 房主显式添加机器人（朋友房空座绝不自动补位）。
func (r *Room) AddBot(seat int, p model.AddBotPayload) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil || r.seats[seat].isBot {
		return ErrBadSeat
	}
	if rc, ok := r.lookupReceiptLocked(seat, p.RequestID); ok {
		r.replayReceiptLocked(seat, rc)
		return nil
	}
	if err := r.validateMetaLocked(p.CommandMeta); err != nil {
		r.rejectCommandLocked(seat, p.RequestID, "stale_state", err.Error())
		return err
	}
	if !r.isHostLocked(seat) {
		r.rejectCommandLocked(seat, p.RequestID, "not_host", "只有房主可以添加机器人")
		return errNotHost
	}
	if r.status != model.StatusWaiting {
		r.rejectCommandLocked(seat, p.RequestID, "not_waiting", "本手进行中，不能添加机器人")
		return ErrNotPlaying
	}
	target := -1
	if p.Seat != nil {
		if *p.Seat < 0 || *p.Seat >= len(r.seats) || r.seats[*p.Seat] != nil {
			r.rejectCommandLocked(seat, p.RequestID, "bad_seat", "该座位不可添加机器人")
			return ErrBadSeat
		}
		target = *p.Seat
	} else {
		for i, o := range r.seats {
			if o == nil {
				target = i
				break
			}
		}
	}
	if target < 0 {
		r.rejectCommandLocked(seat, p.RequestID, "room_full", ErrRoomFull.Error())
		return ErrRoomFull
	}
	r.seats[target] = &occupant{nick: BotNick(target), isBot: true, ready: true}
	r.queueAppliedReceiptLocked(seat, p.RequestID)
	r.refreshStateLocked()
	return nil
}

// RemoveBot 房主移除等待阶段机器人：留下空座等待朋友，不自动补回。
func (r *Room) RemoveBot(seat int, p model.RemoveBotPayload) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil || r.seats[seat].isBot {
		return ErrBadSeat
	}
	if rc, ok := r.lookupReceiptLocked(seat, p.RequestID); ok {
		r.replayReceiptLocked(seat, rc)
		return nil
	}
	if err := r.validateMetaLocked(p.CommandMeta); err != nil {
		r.rejectCommandLocked(seat, p.RequestID, "stale_state", err.Error())
		return err
	}
	if !r.isHostLocked(seat) {
		r.rejectCommandLocked(seat, p.RequestID, "not_host", "只有房主可以移除机器人")
		return errNotHost
	}
	if r.status != model.StatusWaiting {
		r.rejectCommandLocked(seat, p.RequestID, "not_waiting", "本手进行中，不能移除机器人")
		return ErrNotPlaying
	}
	if p.Seat < 0 || p.Seat >= len(r.seats) || r.seats[p.Seat] == nil || !r.seats[p.Seat].isBot {
		r.rejectCommandLocked(seat, p.RequestID, "bad_seat", "该座位不是机器人")
		return ErrBadSeat
	}
	r.freeSeatLocked(p.Seat)
	r.queueAppliedReceiptLocked(seat, p.RequestID)
	r.refreshStateLocked()
	return nil
}

// SetNextHandPolicy 练习房房主切换手动/自动续局；自动排程仅由服务端建立/取消。
func (r *Room) SetNextHandPolicy(seat int, p model.NextPolicyPayload) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil || r.seats[seat].isBot {
		return ErrBadSeat
	}
	if rc, ok := r.lookupReceiptLocked(seat, p.RequestID); ok {
		r.replayReceiptLocked(seat, rc)
		return nil
	}
	if err := r.validateMetaLocked(p.CommandMeta); err != nil {
		r.rejectCommandLocked(seat, p.RequestID, "stale_state", err.Error())
		return err
	}
	if !r.isHostLocked(seat) {
		r.rejectCommandLocked(seat, p.RequestID, "not_host", "只有房主可以调整续局方式")
		return errNotHost
	}
	if r.cfg.RoomKind != model.RoomKindPractice {
		r.rejectCommandLocked(seat, p.RequestID, "not_practice", "朋友房固定手动开始下一手")
		return errNotPractice
	}
	switch p.Policy {
	case model.NextHandManual:
		r.cfg.NextHandPolicy = model.NextHandManual
		r.stopNextHandTimerLocked()
		r.broadcastLocked(model.TypeNextHand, model.NextHandPayload{StartAt: 0})
	case model.NextHandAutomatic:
		r.cfg.NextHandPolicy = model.NextHandAutomatic
		if r.status == model.StatusWaiting && r.handSeq > 0 {
			r.scheduleNextHandLocked()
		}
	default:
		r.rejectCommandLocked(seat, p.RequestID, "bad_policy", "续局方式非法")
		return fmt.Errorf("bad_policy: %s", p.Policy)
	}
	r.queueAppliedReceiptLocked(seat, p.RequestID)
	r.refreshStateLocked()
	return nil
}

var (
	errNotHost     = fmt.Errorf("not_host: 只有房主可以执行该操作")
	errNotPractice = fmt.Errorf("not_practice: 该房间不支持此设置")
)

// flushReceiptLocked 立即把某座位的待发回执随一帧状态发出（不改变 revision）。
func (r *Room) flushReceiptLocked(seat int) {
	receipts := r.pendingReceipts[seat]
	if len(receipts) == 0 {
		return
	}
	delete(r.pendingReceipts, seat)
	r.sendStateToSeatLocked(seat, stateReasonMutation, nil, receipts)
}

// Action 提交下注动作（上行 action；amount 语义 = bet/raise「加到」本轮总投入目标）。
// 非法动作同步回 error 消息（不回显隐藏数据，D7）。
func (r *Room) Action(seat int, a model.ActionPayload) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil {
		return ErrBadSeat
	}
	if rc, ok := r.lookupReceiptLocked(seat, a.RequestID); ok {
		r.replayReceiptLocked(seat, rc)
		return nil
	}
	if err := r.validateMetaLocked(a.CommandMeta); err != nil {
		r.rejectCommandLocked(seat, a.RequestID, "stale_state", err.Error())
		return err
	}
	if r.game == nil {
		r.rejectCommandLocked(seat, a.RequestID, "not_playing", ErrNotPlaying.Error())
		return ErrNotPlaying
	}
	err := r.game.Submit(game.Action{Seat: seat, Type: a.Type, Amount: a.Amount})
	if err != nil {
		r.rejectCommandLocked(seat, a.RequestID, errCode(err, "illegal_action"), err.Error())
		return err
	}
	// 成功命令的 applied 回执随紧随其后的 commit 状态帧下发（带 appliedRevision）。
	r.queueAppliedReceiptLocked(seat, a.RequestID)
	return nil
}

// Reveal 提交揭示动作（上行 reveal）：私看自己底牌 / 当众翻公共牌（§1.3）。
// 范围与时机校验由 game 负责；揭示广播（含成本）经事件通道下发。
func (r *Room) Reveal(seat int, rp model.RevealPayload) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil {
		return 0, ErrBadSeat
	}
	if rc, ok := r.lookupReceiptLocked(seat, rp.RequestID); ok {
		r.replayReceiptLocked(seat, rc)
		return 0, nil
	}
	if err := r.validateMetaLocked(rp.CommandMeta); err != nil {
		r.rejectCommandLocked(seat, rp.RequestID, "stale_state", err.Error())
		return 0, err
	}
	if r.game == nil {
		r.rejectCommandLocked(seat, rp.RequestID, "not_playing", ErrNotPlaying.Error())
		return 0, ErrNotPlaying
	}
	cost, err := r.game.Reveal(game.RevealReq{Seat: seat, CardID: rp.CardID, Scope: rp.Scope})
	if err != nil {
		r.rejectCommandLocked(seat, rp.RequestID, "illegal_reveal", err.Error())
		return 0, err
	}
	r.queueAppliedReceiptLocked(seat, rp.RequestID)
	return cost, nil
}

// Leave 离座：空闲期立即释放；局内先标记，手牌结束后生效（避免座位中途蒸发）。
func (r *Room) Leave(seat int) error {
	return r.LeaveWithMeta(seat, model.CommandMeta{})
}

// LeaveWithMeta 是 v2 离座命令（去重回执 + expected 校验）。
func (r *Room) LeaveWithMeta(seat int, meta model.CommandMeta) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil {
		return ErrBadSeat
	}
	if rc, ok := r.lookupReceiptLocked(seat, meta.RequestID); ok {
		r.replayReceiptLocked(seat, rc)
		return nil
	}
	if err := r.validateMetaLocked(meta); err != nil {
		r.rejectCommandLocked(seat, meta.RequestID, "stale_state", err.Error())
		return err
	}
	r.queueAppliedReceiptLocked(seat, meta.RequestID)
	r.flushReceiptLocked(seat)
	if r.status == model.StatusPlaying {
		r.seats[seat].pendingLeave = true
		r.seats[seat].link = nil
		r.tickBotsLocked()
		r.refreshStateLocked()
		return nil
	}
	r.freeSeatLocked(seat)
	r.checkDissolveLocked()
	if !r.closed {
		r.refreshStateLocked()
	}
	return nil
}

// Snapshot 取某座位视角的全量快照（join / resync 时下发）。
// hidden 模式未揭示要素的裁剪由 game.SnapshotFor 保证（D7：服务端不查询不下发）。
func (r *Room) Snapshot(seat int) model.SnapshotPayload {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.snapshotLocked(seat)
}

// Resync 给某座位补发全量快照（上行 resync / 断线重连修复，A4.3）。
func (r *Room) Resync(seat int) {
	r.ResyncWithMeta(seat, "")
}

// ResyncWithMeta 补发快照 + v2 状态帧；requestId 命中回执缓存时一并重放（核对在途命令）。
func (r *Room) ResyncWithMeta(seat int, requestID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil {
		return
	}
	r.sendLocked(seat, model.TypeSnapshot, r.snapshotLocked(seat))
	var receipts []model.CommandReceipt
	if requestID != "" {
		if rc, ok := r.lookupReceiptLocked(seat, requestID); ok {
			receipts = append(receipts, rc)
		}
	}
	if len(receipts) == 0 {
		receipts = r.pendingReceipts[seat]
		delete(r.pendingReceipts, seat)
	}
	r.sendStateLocked(seat, stateReasonResync, nil, receipts)
}

// SendError 给某座位回 error 消息（WS 网关层错误：坏信封/未知类型等）。
func (r *Room) SendError(seat int, code, msg string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sendErrorLocked(seat, code, msg)
}

// Emote 发表情（D15）：校验 key 白名单与 10 秒/座位冷却后全桌广播 emoted。
// game 不感知表情（纯互动层），冷却计账放 room 保证重连不可刷冷却。
func (r *Room) Emote(seat int, key string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil {
		return ErrBadSeat
	}
	if !model.ValidEmote(key) {
		return ErrBadEmote
	}
	if last, ok := r.emoteAt[seat]; ok && time.Since(last) < EmoteCooldown {
		return ErrEmoteCool
	}
	r.emoteAt[seat] = time.Now()
	r.broadcastLocked(model.TypeEmoted, model.EmotedPayload{Seat: seat, Key: key})
	return nil
}

// Say 发聊天（frontend-contract §1，与 emote 同构）：校验 chatEnabled / 长度 / 节流后
// 全桌广播 said。text 去空白后 ≤ ChatMaxLen；节流 ChatThrottleMs/座位（防刷屏）。
func (r *Room) Say(seat int, text string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil {
		return ErrBadSeat
	}
	if !r.cfg.ChatEnabled {
		return ErrChatDisabled
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return ErrChatTooLong
	}
	if len([]rune(text)) > model.ChatMaxLen {
		return ErrChatTooLong
	}
	if last, ok := r.chatAt[seat]; ok && time.Since(last) < model.ChatThrottle {
		return ErrChatThrottle
	}
	r.chatAt[seat] = time.Now()
	r.broadcastLocked(model.TypeSaid, model.SaidPayload{Seat: seat, Text: text})
	return nil
}

// Close 优雅退出：停事件循环、bot 定时与 game 表 goroutine（game.Events 是阻塞背压，
// 不 Close 会让 game 的表 goroutine 卡在事件投递上；不动库里的审计记录）。
func (r *Room) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	r.closed = true
	close(r.stopCh)
	if r.botTimer != nil {
		r.botTimer.Stop()
		r.botTimer = nil
	}
	r.stopNextHandTimerLocked()
	if r.reapTimer != nil {
		r.reapTimer.Stop()
		r.reapTimer = nil
	}
	r.flushHandLogLocked() // 优雅退出也要把在途的攒批账落掉
	if r.game != nil {
		r.game.Close()
	}
}

// ===== 以下为锁内实现（调用方持 r.mu）=====

// nextSeqLocked 分配下一个下行序号。
func (r *Room) nextSeqLocked() int64 {
	r.seq++
	return r.seq
}

// sendLocked 给单个座位发一条下行消息（payload 为 nil 发空载荷；json.RawMessage 原样透传）。
func (r *Room) sendLocked(seat int, t string, payload any) {
	if seat < 0 || seat >= len(r.seats) {
		return
	}
	occ := r.seats[seat]
	if occ == nil || occ.link == nil {
		return
	}
	env, err := model.NewEnvelope(t, r.nextSeqLocked(), payload)
	if err != nil {
		slog.Error("编信封失败", "room", r.code, "t", t, "err", err)
		return
	}
	b, err := json.Marshal(env)
	if err != nil {
		slog.Error("编信封 JSON 失败", "room", r.code, "t", t, "err", err)
		return
	}
	occ.link.Send(b)
}

// broadcastLocked 全桌广播（在线座位）。
func (r *Room) broadcastLocked(t string, payload any) {
	for i := range r.seats {
		r.sendLocked(i, t, payload)
	}
}

// sendErrorLocked 给单个座位回 error 消息（§5 error：不得回显隐藏数据，D7）。
func (r *Room) sendErrorLocked(seat int, code, msg string) {
	r.sendLocked(seat, model.TypeError, model.ErrorPayload{Code: code, Msg: msg})
}

// broadcastErrorLocked 全桌广播 error（开局失败等整桌级错误；载荷无隐藏数据，D7）。
func (r *Room) broadcastErrorLocked(code, msg string) {
	r.broadcastLocked(model.TypeError, model.ErrorPayload{Code: code, Msg: msg})
}

// beginHandLocked 开一手牌：绑定 game 座位 -> 换新牌池 -> 落手牌行 -> Start。
// 绝不补机器人：机器人只能由练习房创建策略或房主显式 addBot 加入。
// 任一步失败即回滚半成品，状态保持 waiting，可重新由房主 start。
func (r *Room) beginHandLocked() error {
	// 0) 换手重置 bot 再加注计数（每手每街独立封顶，见 BotParams.MaxRaises）。
	clear(r.botRaiseCount)
	clear(r.botRaisePhase)
	r.handShowdown = nil
	r.handStartedAt = time.Now()
	r.handActCount = 0
	r.stopNextHandTimerLocked()

	// 1) 本手牌盒：优先用后台预生成的下一手牌盒，缺则现抽（回退）。种子在开局成功后才固证。
	deck, seed := r.takeDeckLocked()

	// 2) game 实例：首手 New，之后复用长实例（筹码/积分跨手延续）。
	if r.game == nil {
		gc := GameConfig(r.cfg, r.turnTimeoutSeconds, r.timing.MaxRebuys)
		r.game = game.New(gc, deck)
		go r.run(r.game.Events())
	}

	// 3) 同步 game 座位绑定（人来了可替换：改绑昵称 / 新入座补绑）。
	for i, o := range r.seats {
		if o == nil {
			continue
		}
		if !o.joined {
			if err := r.game.Join(i, o.nick, o.isBot); err != nil {
				slog.Warn("game.Join 失败", "room", r.code, "seat", i, "err", err)
				continue
			}
			o.joined = true
		}
	}

	// 4) 换新牌池（长实例每手换盒；可复现性由 hands.deck 落库保证：deck 即回放真源）。
	if err := r.game.SetDeck(deck); err != nil {
		return fmt.Errorf("%s: %w", errCode(err, game.CodeBadState), err)
	}

	// 5) 落手牌行（牌池记账，可回放）。失败中止并回滚手序号，保持 waiting。
	r.handSeq++
	r.actionSeq = 0
	deckJSON, _ := json.Marshal(deck)
	handID, err := r.st.CreateHand(model.HandRecord{
		RoomID: r.id, Seq: r.handSeq, Deck: string(deckJSON),
		Community: "[]", StartedAt: model.Now(),
	})
	if err != nil {
		r.handSeq--
		return fmt.Errorf("%s: %w", game.CodeInternal, err)
	}
	r.handID = handID

	// 6) 状态推进 + 开局（发牌/下注由 game 事件驱动）。
	for _, o := range r.seats {
		if o != nil {
			o.ready = false // 准备每手消耗一次
		}
	}
	if err := r.game.Start(); err != nil {
		r.rollbackHandLocked(handID)
		return fmt.Errorf("%s: %w", errCode(err, game.CodeBadState), err)
	}
	r.handSeed = seed
	r.handSeedCommit = model.SeedCommitHex(strconv.FormatInt(seed, 10))
	r.seedRevealed = false
	r.status = model.StatusPlaying
	if err := r.st.UpdateRoomStatus(r.id, model.StatusPlaying); err != nil {
		slog.Warn("更新房间状态失败", "room", r.code, "err", err)
	}
	// 可验证发牌固证（frontend-contract §2）：先承诺（广播 seedCommit）后发牌（game.Start 触发
	// dealt 事件）。room 持锁覆盖 Start 与广播、事件转发排在解锁之后，seedCommit 必先于
	// dealt 到达——发牌前已固证。
	r.broadcastLocked(model.TypeSeedCommit, model.SeedCommitPayload{Sha256: r.handSeedCommit})
	r.tickBotsLocked()

	// 7) 本手进行中后台预生成下一手牌盒（seed 独立；未就绪/失败届时回退现抽）。
	go r.prepNextDeck()
	return nil
}

// rollbackHandLocked 回滚开局半成品：删已落手牌行、退手序号、清种子固证。
// game.Start 失败不推进状态机，回滚后房间保持 waiting，可重新 ready 开局。
func (r *Room) rollbackHandLocked(handID int64) {
	if handID != 0 {
		if err := r.st.DeleteHand(handID); err != nil {
			slog.Warn("回滚手牌行失败", "room", r.code, "handID", handID, "err", err)
		}
	}
	r.handID = 0
	r.handSeq--
	r.actionSeq = 0
	r.handSeed, r.handSeedCommit = 0, ""
}

// errCode 取 game 同步错误的回执码（错误消息以 code 起头，见 game.actionErr）；
// 取不出已知码时回退 fallback。
func errCode(err error, fallback string) string {
	head, _, _ := strings.Cut(err.Error(), ":")
	head = strings.TrimSpace(head)
	switch head {
	case game.CodeBadState, game.CodeDeckExhausted, game.CodeRebuyExhausted:
		return head
	}
	return fallback
}

// takeDeckLocked 取本手牌盒 + 种子：优先用后台预生成的下一手牌盒，缺则现抽（回退）。
func (r *Room) takeDeckLocked() ([]engine.Card, int64) {
	if d := r.nextDeck; d != nil && len(d.cards) > 0 {
		r.nextDeck = nil
		return d.cards, d.seed
	}
	seed := newSeed()
	return game.SampleDeck(r.deckLib, r.cfg.DeckSize, seed), seed
}

// prepNextDeck 后台预生成下一手牌盒（与本手 seed 独立）。关桌后直接丢弃，
// 空结果也丢弃——届时 takeDeckLocked 回退现抽。
func (r *Room) prepNextDeck() {
	seed := newSeed()
	deck := game.SampleDeck(r.deckLib, r.cfg.DeckSize, seed)
	if len(deck) == 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	r.nextDeck = &preppedDeck{cards: deck, seed: seed}
}

// freeSeatLocked 释放一个座位（含 game 侧解绑）。
func (r *Room) freeSeatLocked(seat int) {
	o := r.seats[seat]
	if o == nil {
		return
	}
	if o.joined && r.game != nil {
		if err := r.game.Leave(seat); err != nil {
			slog.Warn("game.Leave 失败", "room", r.code, "seat", seat, "err", err)
		}
	}
	r.seats[seat] = nil
	r.updateHostLocked()  // 房主座位失效→转交仍在座真人；无真人则留空由生命周期处理
	r.latestValid = false // 事务快照已过期，下一次状态帧从 game 重拍
}

// checkDissolveLocked 房间回收判定（A4.2 生命周期闭环 + 空闲房回收）：
// waiting 且无在座人类持续 IdleTTL（IDLE_ROOM_TTL_MINUTES）→ closed + Manager 摘除；
// 未配 IdleTTL 维持旧语义（无在座人类即解散）。有在座人类即清空闲计时；
// playing 不回收（打完这手回到 waiting 后由 onSettled 再判）。
func (r *Room) checkDissolveLocked() {
	for _, o := range r.seats {
		if o != nil && !o.isBot {
			r.emptySince = time.Time{}
			return
		}
	}
	if r.status != model.StatusWaiting {
		return
	}
	if r.timing.IdleTTL <= 0 {
		r.dissolveLocked() // 未配空闲 TTL：维持旧语义
		return
	}
	if r.emptySince.IsZero() {
		r.emptySince = time.Now() // 起算空闲时长，由巡检到点回收（reapLocked）
		return
	}
	if time.Since(r.emptySince) >= r.timing.IdleTTL {
		slog.Info("空闲房回收", "room", r.code, "idleTTL", r.timing.IdleTTL)
		r.dissolveLocked()
	}
}

// dissolveLocked 关桌：状态 closed、停事件循环与全部定时器、通知 Manager 摘除索引。
func (r *Room) dissolveLocked() {
	r.status = model.StatusClosed
	if err := r.st.UpdateRoomStatus(r.id, model.StatusClosed); err != nil {
		slog.Warn("更新房间状态失败", "room", r.code, "err", err)
	}
	r.closed = true
	close(r.stopCh)
	if r.botTimer != nil {
		r.botTimer.Stop()
		r.botTimer = nil
	}
	r.stopNextHandTimerLocked()
	if r.reapTimer != nil {
		r.reapTimer.Stop()
		r.reapTimer = nil
	}
	if r.game != nil {
		r.game.Close() // 停表 goroutine，防事件背压卡死
	}
	if r.onDissolve != nil {
		cb := r.onDissolve
		go cb(r) // 不在锁内回调 Manager（避免锁序反转）
	}
}

// broadcastSnapshotLocked 对账帧：给全部在线座位各发其视角全量快照。
// 凡座位/筹码结构变化（重买、离席、断线回收、破产处置）后调用，客户端整表对账。
func (r *Room) broadcastSnapshotLocked() {
	for i := range r.seats {
		if r.seats[i] == nil || r.seats[i].link == nil {
			continue
		}
		r.sendLocked(i, model.TypeSnapshot, r.snapshotLocked(i))
	}
}

// scheduleNextHandLocked 排程下一手自动开局并广播 nextHand{startAt}（epoch ms）：
// 到点 active≥2 自动开局（不再要求全员 ready）；全员 ready 可经 maybeStartLocked 提前开局。
// NextHandDelay<=0 = 机制关闭（不排程不广播）。
func (r *Room) scheduleNextHandLocked() {
	if r.timing.NextHandDelay <= 0 || r.closed || r.status != model.StatusWaiting {
		return
	}
	if r.cfg.RoomKind != model.RoomKindPractice || r.cfg.NextHandPolicy != model.NextHandAutomatic {
		return // 朋友房/手动模式：没有自动开局排程
	}
	r.stopNextHandTimerLocked()
	r.nextHandGen++
	gen := r.nextHandGen
	startAt := time.Now().Add(r.timing.NextHandDelay)
	at := startAt.UnixMilli()
	r.nextHandAt = &at
	r.nextHandTimer = time.AfterFunc(r.timing.NextHandDelay, func() { r.onNextHandTick(gen) })
	r.broadcastLocked(model.TypeNextHand, model.NextHandPayload{StartAt: at})
}

// stopNextHandTimerLocked 取消下一手排程（策略切换/提前开局/关桌时清场）并让旧回调失效。
func (r *Room) stopNextHandTimerLocked() {
	if r.nextHandTimer != nil {
		r.nextHandTimer.Stop()
		r.nextHandTimer = nil
	}
	r.nextHandGen++
	r.nextHandAt = nil
}

// onNextHandTick 自动续局到点：仅练习房 + 明示 automatic；条件不满足则不偷偷开局。
func (r *Room) onNextHandTick(gen int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if gen != r.nextHandGen {
		return // 旧代际定时器：策略已被取消/替换
	}
	r.nextHandTimer = nil
	if r.closed || r.status != model.StatusWaiting {
		return
	}
	if r.cfg.RoomKind != model.RoomKindPractice || r.cfg.NextHandPolicy != model.NextHandAutomatic {
		return
	}
	humans, bots := r.humanBotCountsLocked()
	if humans == 0 || humans+bots < 2 {
		return
	}
	if err := r.beginHandLocked(); err != nil {
		slog.Error("自动续局失败，保持等待", "room", r.code, "err", err)
		r.broadcastErrorLocked(errCode(err, "start_failed"), err.Error())
		r.refreshStateLocked()
	}
}

// scheduleReapLocked 排程一次巡检（自续）：断线回收 + 空闲房回收。
// 两机制均未启用（Timing 零值）时不排程；NewRoom 建桌即起，Close/dissolve 停。
func (r *Room) scheduleReapLocked() {
	if r.closed || r.reapTimer != nil {
		return
	}
	if r.timing.DisconnectGrace <= 0 && r.timing.IdleTTL <= 0 {
		return
	}
	d := r.timing.ReapInterval
	if d <= 0 {
		d = r.timing.reapAutoInterval()
	}
	r.reapTimer = time.AfterFunc(d, r.reapTick)
}

// reapTick 一次巡检：跑 reapLocked 后自续排程（除非已关桌）。
func (r *Room) reapTick() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reapTimer = nil
	if r.closed {
		return
	}
	r.reapLocked()
	r.scheduleReapLocked()
}

// reapLocked 巡检主体（调用方持 r.mu）：
//   - 断线回收：真人 Detach 超 DISCONNECT_GRACE_SECONDS 自动离席——playing 标 pendingLeave
//     （收手生效）、waiting 立即 freeSeat（bot 补位机制复用），随后广播对账快照；
//   - 空闲房回收：waiting 且无在座人类持续 IDLE_ROOM_TTL_MINUTES → closed + Manager 摘除。
func (r *Room) reapLocked() {
	now := time.Now()
	changed := false
	if r.timing.DisconnectGrace > 0 {
		for i, o := range r.seats {
			if o == nil || o.isBot || o.link != nil || o.detachedAt.IsZero() {
				continue
			}
			if now.Sub(o.detachedAt) < r.timing.DisconnectGrace {
				continue
			}
			if r.status == model.StatusPlaying {
				if !o.pendingLeave {
					o.pendingLeave = true // 局内不蒸发座位，手牌结束后生效
					changed = true
				}
				continue
			}
			slog.Info("断线超时自动离席", "room", r.code, "seat", i, "nick", o.nick)
			r.freeSeatLocked(i)
			changed = true
		}
	}
	r.checkDissolveLocked()
	if r.closed || !changed {
		return
	}
	r.broadcastSnapshotLocked() // 对账帧：离席后全量快照对账
	r.tickBotsLocked()
}

// snapshotLocked 构造某视角全量快照：
// 未开局 = 座位表空桌形态；开局后 = game.SnapshotFor 的 JSON 形状（与 model.SnapshotPayload
// 逐字段对齐）+ room 补房间码/昵称。game 是唯一牌局真源，room 不二次计算筹码/积分。
func (r *Room) snapshotLocked(seat int) model.SnapshotPayload {
	if r.game == nil {
		seats := make([]model.SeatState, len(r.seats))
		for i, o := range r.seats {
			st := model.SeatState{Seat: i, Chips: r.cfg.Chips, HoleCount: 0}
			if o != nil {
				st.Nick = o.nick
				st.Ready = o.ready
			}
			seats[i] = st
		}
		s := model.SnapshotPayload{
			RoomCode:     r.code,
			AutoReveal:   r.cfg.AutoReveal,
			Phase:        model.PhaseWaiting,
			Seats:        seats,
			MySeat:       seat,
			MyCards:      []model.CardData{},
			Community:    []model.CardData{},
			TurnSeat:     -1,
			SmallBlind:   r.cfg.SmallBlind,
			BigBlind:     r.cfg.BigBlind,
			RevealRate:   r.cfg.RevealRate,
			Reveals:      []model.RevealRecord{},
			ChatEnabled:  r.cfg.ChatEnabled,
			Seq:          r.seq, // 快照基线 = 最后事件序号（本帧信封 seq = 基线+1）
			TurnMs:       r.turnTimeoutSeconds * 1000,
			Seed:         nil, // 未开局无「当前手 seed」
			Box:          []model.BoxCard{},
			Pool:         r.poolInfoLocked(),
			LegalActions: []string{},
		}
		r.decorateLocked(seat, &s)
		return s
	}
	return r.toModelSnapshotLocked(seat, r.game.SnapshotFor(seat))
}

// toModelSnapshotLocked 把 game 视角快照转成线上快照并补齐 room 字段。
// game 是唯一牌局真源，room 不二次计算筹码/积分。
func (r *Room) toModelSnapshotLocked(seat int, gs game.Snapshot) model.SnapshotPayload {
	raw, err := json.Marshal(gs)
	if err != nil {
		slog.Error("game 快照序列化失败", "room", r.code, "err", err)
		return model.SnapshotPayload{RoomCode: r.code, MySeat: seat, TurnSeat: -1}
	}
	var s model.SnapshotPayload
	if err := json.Unmarshal(raw, &s); err != nil {
		slog.Error("game 快照解析失败", "room", r.code, "err", err)
		return model.SnapshotPayload{RoomCode: r.code, MySeat: seat, TurnSeat: -1}
	}
	s.Seq = r.seq // 快照基线 = 信封 seq 的当前值（本帧信封 seq = 基线+1）
	r.decorateLocked(seat, &s)
	return s
}

// poolInfoLocked 装配牌池摘要（PoolInfo 真源）：策略 + 主题过滤项 + 有效池大小 + 主题回退标记。
func (r *Room) poolInfoLocked() model.PoolInfo {
	return model.PoolInfo{
		Strategy: r.cfg.DeckStrategy,
		Theme:    r.cfg.ThemeFilter,
		PoolSize: len(r.deckLib),
		Fallback: r.poolFallback,
	}
}

// ===== 事件循环（一桌一 goroutine，D12）=====

// run 消费 game 事件：落账（actions/reveal_log/hands/scores）+ 按视角脱敏转发。
func (r *Room) run(events <-chan game.Event) {
	for {
		select {
		case <-r.stopCh:
			return
		case ev := <-events:
			r.handleEvent(ev)
		}
	}
}

// handleEvent 处理一条 game 事件（落库 + 转发）。game 事件载荷 JSON 与 model 下行载荷
// 逐字段对齐（双方契约定稿），非 dealt/revealed 一律原样透传，避免字段裁剪。
func (r *Room) handleEvent(ev game.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	raw, err := json.Marshal(ev.Payload)
	if err != nil {
		slog.Error("事件序列化失败", "room", r.code, "t", ev.Type, "err", err)
		return
	}
	r.recordGameEventLocked(ev)

	switch ev.Type {
	case game.EventCommit:
		// 事务提交：game 在锁内捕获的全座位快照，room 在此有序应用并分配 revision。
		var cp game.CommitPayload
		if err := json.Unmarshal(raw, &cp); err == nil {
			r.applyCommitLocked(&cp)
		} else {
			slog.Error("提交快照解析失败", "room", r.code, "err", err)
		}
		return

	case model.TypeDealt:
		// 底牌只发给本人，他人只收占位（§5 dealt）。
		var dp model.DealtPayload
		if err := json.Unmarshal(raw, &dp); err == nil {
			for i := range r.seats {
				out := dp
				if out.Seat != i {
					out.Cards = []model.CardData{}
				}
				r.sendLocked(i, model.TypeDealt, out)
			}
		}

	case model.TypeFlop, model.TypeTurn, model.TypeRiver:
		// 公共牌落库（每街推进，断电不丢进度）。
		var cp model.CommunityPayload
		if err := json.Unmarshal(raw, &cp); err == nil && r.handID != 0 {
			if cj, err := json.Marshal(cp.Cards); err == nil {
				if err := r.st.UpdateHandCommunity(r.handID, string(cj)); err != nil {
					slog.Warn("更新公共牌失败", "room", r.code, "err", err)
				}
			}
		}
		r.broadcastLocked(ev.Type, raw)

	case model.TypeActed:
		// 动作日志追加式（可回放一手牌，§4.5）：攒批，一手一事务落库。
		var ap model.ActedPayload
		if err := json.Unmarshal(raw, &ap); err == nil && r.handID != 0 {
			r.actionSeq++
			r.pendingActions = append(r.pendingActions, model.ActionRecord{
				HandID: r.handID, Seq: r.actionSeq, Seat: ap.Seat,
				Type: ap.Type, Amount: ap.Amount, At: model.Now(),
			})
		}
		r.handActCount++
		r.broadcastLocked(model.TypeActed, raw)

	case model.TypeRevealed:
		// 揭示账（A4.6）+ private 只路由本人（D2）：攒批，一手一事务落库。
		var rp model.RevealedPayload
		if err := json.Unmarshal(raw, &rp); err == nil {
			if r.handID != 0 {
				r.pendingReveals = append(r.pendingReveals, model.RevealLogRecord{
					HandID: r.handID, CardID: rp.CardID, Seat: rp.Seat,
					Scope: rp.Scope, Cost: rp.Cost, At: model.Now(),
				})
			}
			if rp.Scope == model.ScopePrivate {
				r.sendLocked(rp.Seat, model.TypeRevealed, raw)
			} else {
				r.broadcastLocked(model.TypeRevealed, raw)
			}
		}

	case model.TypeShowdown:
		// 摊牌：冻结本手公开牌型（结算摘要的 showdown 区）。
		var sp model.ShowdownPayload
		if err := json.Unmarshal(raw, &sp); err == nil {
			r.handShowdown = sp.Hands
		}
		r.broadcastLocked(model.TypeShowdown, raw)

	case model.TypeSettled:
		if !r.handStartedAt.IsZero() {
			slog.Info("本手节奏", "room", r.code, "hand", r.handSeq,
				"durationMs", time.Since(r.handStartedAt).Milliseconds(),
				"actions", r.handActCount)
			r.handStartedAt = time.Time{}
		}
		r.broadcastLocked(model.TypeSettled, raw)
		r.onSettledLocked(raw)

	case model.TypeError:
		// game 发的错误事件（非法转移等）：广播给全桌（载荷无隐藏数据）。
		r.broadcastLocked(model.TypeError, raw)

	default:
		r.broadcastLocked(ev.Type, raw)
	}

	r.tickBotsLocked()
}

// onSettledLocked 收一手：落结果、记账本、回到等待、清离座位。
func (r *Room) onSettledLocked(raw []byte) {
	r.flushHandLogLocked() // 攒批动作/揭示账先落库，再收手牌
	// 结算摘要以处置前（重买/离席前）的座位状态冻结，供结算回顾展示。
	snap := r.snapshotLocked(0)
	r.lastResult = r.buildHandResultLocked(raw, snap)
	// 可验证发牌揭示（frontend-contract §2）：摊牌后揭示 seed，客户端本地算哈希与固证比对。
	if r.handSeedCommit != "" {
		r.broadcastLocked(model.TypeSeedReveal, model.SeedRevealPayload{
			Seed: strconv.FormatInt(r.handSeed, 10),
		})
		r.seedRevealed = true // 摊牌后 snapshot.seed 可见（之前 null）
	}
	if r.handID != 0 {
		if err := r.st.FinishHand(r.handID, string(raw)); err != nil {
			slog.Warn("收手牌失败", "room", r.code, "err", err)
		}
	}
	// 双账本落库（§1.4）：以 game 账面为准，scores 表做持久审计。
	// chips/points 为全局字段（与视角无关），复用处置前的快照，避免逐座全量重算。
	for i, o := range r.seats {
		if o == nil || !o.joined {
			continue
		}
		if i >= len(snap.Seats) {
			continue
		}
		if err := r.st.UpsertScore(model.ScoreRecord{
			RoomID: r.id, Seat: i,
			Chips: snap.Seats[i].Chips, Points: snap.Seats[i].Points,
		}); err != nil {
			slog.Warn("落账本失败", "room", r.code, "seat", i, "err", err)
		}
	}

	r.status = model.StatusWaiting
	if err := r.st.UpdateRoomStatus(r.id, model.StatusWaiting); err != nil {
		slog.Warn("更新房间状态失败", "room", r.code, "err", err)
	}
	r.handID = 0

	// R2/D19 破产处置（消掉长局筹码集中导致 active<2 开局失败，遗留 R2）：
	//   - bot 破产：自动离席（freeSeat），下一手 beginHand 补新 bot——「座位交 bot」；
	//   - 真人破产：就地重买入座（重买额=初始筹码，仅筹码账、积分不变）——「真人重入重买」。
	//     真人不离席既守住「积分不受影响」，又免掉唯一真人离席触发解散的死局。
	if r.game != nil {
		for i, o := range r.seats {
			if o == nil || !o.joined {
				continue
			}
			if i < len(snap.Seats) && snap.Seats[i].Chips > 0 {
				continue
			}
			if o.isBot {
				slog.Info("破产自动离席(bot)", "room", r.code, "seat", i, "nick", o.nick)
				r.freeSeatLocked(i)
			} else if err := r.game.Rebuy(i); err != nil {
				if errCode(err, "") == game.CodeRebuyExhausted {
					// 重买上限（MAX_REBUYS）用尽 → 自动离席（freeSeat；bot 补位机制复用）。
					slog.Info("破产重买次数用尽，自动离席(真人)", "room", r.code, "seat", i, "nick", o.nick)
					r.freeSeatLocked(i)
				} else {
					slog.Warn("破产重买失败", "room", r.code, "seat", i, "err", err)
				}
			} else {
				slog.Info("破产重买入座(真人)", "room", r.code, "seat", i, "nick", o.nick)
			}
		}
	}

	// 局内离座的座位此时生效（A4.4 人来了可替换的对偶：人走了 bot 接管下一手）。
	for i, o := range r.seats {
		if o != nil && o.pendingLeave {
			r.freeSeatLocked(i)
		}
	}
	r.checkDissolveLocked()
	if r.closed {
		return
	}
	// 重买/离席/破产处置改变了筹码结构：让随后到达的 settle commit 以当前状态重拍，
	// 避免把处置前的旧筹码盖回客户端。
	r.recaptureCommits = 1
	// 对账帧：座位/筹码结构变化（重买/离席/断线回收/破产处置）后广播全量快照。
	r.broadcastSnapshotLocked()
	// 下一手节奏：排程自动开局定时器并广播 nextHand{startAt}（全员 ready 可提前开局）。
	r.scheduleNextHandLocked()
}

// buildHandResultLocked 冻结最近一手的结算摘要（昵称/座位/赢家金额/摊牌牌型）。
func (r *Room) buildHandResultLocked(raw []byte, snap model.SnapshotPayload) *model.HandResult {
	var sp model.SettledPayload
	if err := json.Unmarshal(raw, &sp); err != nil {
		slog.Warn("结算载荷解析失败", "room", r.code, "err", err)
	}
	res := &model.HandResult{
		HandSeq:   r.handSeq,
		EndedAt:   time.Now().UnixMilli(),
		EndReason: "fold_win",
		Seats:     []model.ResultSeat{},
		Rows:      sp.Rows,
		PotWins:   sp.PotWins,
		Showdown:  []model.ShowdownHand{},
	}
	if res.Rows == nil {
		res.Rows = []model.SettleRow{}
	}
	if res.PotWins == nil {
		res.PotWins = map[int]int{}
	}
	if len(r.handShowdown) > 0 {
		res.EndReason = "showdown"
		res.Showdown = r.handShowdown
	}
	for i, o := range r.seats {
		if o == nil || o.isBot {
			if o != nil && o.isBot {
				res.Seats = append(res.Seats, model.ResultSeat{Seat: i, Nick: o.nick, OccupantKind: "bot"})
			}
			continue
		}
		res.Seats = append(res.Seats, model.ResultSeat{Seat: i, Nick: o.nick, OccupantKind: "human"})
	}
	return res
}

// flushHandLogLocked 把本手攒批的动作/揭示账单事务落库（一手一事务，见 store.AppendHandLog）。
// 落库失败只记日志并清空：DB 故障下重试攒批会把旧手的账错挂到新 hand_id 上，宁缺勿错。
func (r *Room) flushHandLogLocked() {
	if len(r.pendingActions) == 0 && len(r.pendingReveals) == 0 {
		return
	}
	if r.handID == 0 {
		slog.Warn("丢弃无归属手牌的攒批账", "room", r.code,
			"actions", len(r.pendingActions), "reveals", len(r.pendingReveals))
	} else if err := r.st.AppendHandLog(r.handID, r.pendingActions, r.pendingReveals); err != nil {
		slog.Error("落动作/揭示批失败", "room", r.code, "err", err)
	}
	r.pendingActions, r.pendingReveals = nil, nil
}

// ===== bot 调度 =====

// tickBotsLocked 重排 bot 定时：轮到 bot（或掉线人类）则延迟出手，人类在线则等。
func (r *Room) tickBotsLocked() {
	if r.botTimer != nil {
		r.botTimer.Stop()
		r.botTimer = nil
	}
	if r.game == nil || r.status != model.StatusPlaying {
		return
	}
	turn := r.turnSeatLocked()
	if turn < 0 || turn >= len(r.seats) {
		return
	}
	occ := r.seats[turn]
	if occ != nil && !occ.isBot && occ.link != nil {
		return // 人类在线，等他出手（超时自动动作由 game 兜底，A3.6）
	}
	r.botGen++
	gen := r.botGen
	delay := time.Duration(r.bot.DelayMs) * time.Millisecond
	r.botTimer = time.AfterFunc(delay, func() { r.botAct(gen) })
}

// turnSeatLocked 取当前行动座位（-1 = 无行动者）：game.TurnSeat 轻量访问，
// 不再经整张快照（原实现每次事件都做一次全量 JSON ser/deser，是性能热点）。
func (r *Room) turnSeatLocked() int {
	if r.game == nil {
		return -1
	}
	return r.game.TurnSeat()
}

// botAct 执行一次 bot（或代打）动作。定时器代际校验防止旧定时器误动。
func (r *Room) botAct(gen int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || gen != r.botGen || r.game == nil || r.status != model.StatusPlaying {
		return
	}
	turn := r.turnSeatLocked()
	if turn < 0 || turn >= len(r.seats) {
		return
	}
	occ := r.seats[turn]
	if occ != nil && !occ.isBot && occ.link != nil {
		return
	}
	s := r.snapshotLocked(turn)
	// 换街/换手即重置本座位再加注计数（botRaisePhase 记录计数对应的下注街）。
	if r.botRaisePhase[turn] != string(s.Phase) {
		r.botRaisePhase[turn] = string(s.Phase)
		r.botRaiseCount[turn] = 0
	}
	act, ok := botAction(s, turn, r.bot, r.botRaiseCount[turn])
	if !ok {
		return
	}
	if err := r.game.Submit(game.Action{Seat: turn, Type: act.Type, Amount: act.Amount}); err != nil {
		// 回退链保证最终只发合法动作（A3.4）。
		for _, fb := range botFallback(s, turn) {
			if fb.Type == act.Type {
				continue
			}
			if err2 := r.game.Submit(game.Action{Seat: turn, Type: fb.Type, Amount: fb.Amount}); err2 == nil {
				slog.Info("bot 动作回退", "room", r.code, "seat", turn,
					"from", fmt.Sprintf("%s(%d)", act.Type, act.Amount), "to", fb.Type)
				break
			}
		}
	} else if act.Type == model.ActRaise {
		r.botRaiseCount[turn]++
	}
}

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
	ErrNotPlaying = errors.New("当前没有进行中的牌局")
	ErrBadEmote   = errors.New("表情 key 非法")
	ErrEmoteCool  = errors.New("表情冷却中，10 秒一次")
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

	id   string // rooms.id（uuid）
	code string // 6 位房间码
	host string // 房主昵称（展示用）
	cfg  model.RoomConfig
	bot  BotParams
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

	// 节奏参数（Timing 注入；零值 = 机制关闭，见 Timing 注释）。
	timing         Timing
	nextHandTimer  *time.Timer // 下一手自动开局定时器
	reapTimer      *time.Timer // 断线/空闲巡检定时器（自续排程）
	emptySince     time.Time   // 无在座人类的起算时刻（空闲房回收 TTL 起点）
	poolFallback   bool        // 主题过滤过窄已回退全库（PoolInfo.fallback 真源）
	seedRevealed   bool        // 本手 seed 已揭示（摊牌后可见，之前 snapshot.seed 为 null）

	stopCh   chan struct{}
	closed   bool
	onDissolve func(*Room) // 解散回调（Manager 摘除索引）
}

// NewRoom 建桌（Manager 调用）。cfg 必须已通过 config 校验；timing 是节奏参数
// （下一手排程/断线回收/空闲房回收/重买上限，零值 = 机制关闭）。
func NewRoom(id, code, host string, cfg model.RoomConfig, turnTimeoutSeconds int, bot BotParams,
	library []engine.Card, st *store.Store, onDissolve func(*Room), timing Timing) *Room {
	r := &Room{
		id:   id,
		code: code,
		host: host,
		cfg:  cfg,
		bot:  bot,
		turnTimeoutSeconds: turnTimeoutSeconds,
		st:      st,
		library: library,
		seats:   make([]*occupant, cfg.Seats),
		status:  model.StatusWaiting,
		emoteAt: make(map[int]time.Time),
		chatAt:  make(map[int]time.Time),
		botRaiseCount: make(map[int]int),
		botRaisePhase: make(map[int]string),
		timing:  timing,
		stopCh:  make(chan struct{}),
		onDissolve: onDissolve,
	}
	r.deckLib = r.computeDeckLib()
	r.scheduleReapLocked() // 巡检（断线回收/空闲房回收）自续排程，Close 时停
	return r
}

// computeDeckLib 算本桌抽盒用卡库（D11 主题池 = 过滤后再分层，frontend-contract §3）：
// 先按作品标注数下限收池（RoomConfig.MinVotes，运行时热度筛选），再走主题过滤：
// - MinVotes > 0 时先 FilterMinVotes；过滤后不足以撑 DeckSize 时回退全库并记日志
//   （与主题回退同语义，防过窄开局失败）；
// - theme 策略且带 themeFilter 时再按过滤项筛卡库；结果不足以撑 DeckSize 时回退全库并记日志。
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
	players := 0
	for _, o := range r.seats {
		if o != nil {
			players++
		}
	}
	return Summary{
		Code: r.code, Host: r.host, AutoReveal: r.cfg.AutoReveal,
		SmallBlind: r.cfg.SmallBlind, BigBlind: r.cfg.BigBlind,
		Seats: r.cfg.Seats, Players: players, Status: r.status,
	}
}

// Join 占座（REST POST /api/rooms/{code}/join）：同昵称复用原座位（断线重连，A4.3），
// 否则取空位；无空位时替换 bot（A4.4「人来了可替换」），全满报错。
func (r *Room) Join(nick string) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.status == model.StatusClosed {
		return -1, ErrRoomClosed
	}
	// 断线重连：同昵称找回原座位。
	for i, o := range r.seats {
		if o != nil && !o.isBot && o.nick == nick {
			return i, nil
		}
	}
	// 空位优先。
	for i, o := range r.seats {
		if o == nil {
			r.seats[i] = &occupant{nick: nick}
			return i, nil
		}
	}
	// 替换 bot：继承座位与在局状态，立即改绑 game 侧昵称。
	for i, o := range r.seats {
		if o.isBot {
			o.isBot = false
			o.nick = nick
			o.ready = false
			o.link = nil
			if o.joined && r.game != nil {
				if err := r.game.Join(i, nick, false); err != nil {
					slog.Warn("替换 bot 后改绑 game 失败", "room", r.code, "seat", i, "err", err)
				}
			}
			return i, nil
		}
	}
	return -1, ErrRoomFull
}

// Attach 挂接 WS 连接并直发全量快照（join 握手成功后；断线重连同样走这里恢复，A4.3）。
func (r *Room) Attach(seat int, link Link) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil {
		return ErrBadSeat
	}
	r.seats[seat].link = link
	r.seats[seat].pendingLeave = false
	r.seats[seat].detachedAt = time.Time{} // 重连成功，断线计时清零
	r.sendLocked(seat, model.TypeSnapshot, r.snapshotLocked(seat))
	r.tickBotsLocked()
	return nil
}

// Detach 摘除 WS 连接（断线）。座位保留，掉线期间由 bot 策略代打；
// 记录断线时刻，超 DISCONNECT_GRACE_SECONDS 由巡检自动离席（reapLocked）。
func (r *Room) Detach(seat int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil {
		return
	}
	r.seats[seat].link = nil
	r.seats[seat].detachedAt = time.Now()
	r.tickBotsLocked()
}

// Ready 准备开局：全员人类准备即开（bot 自动补位，A3.5/A4.4）。每手消耗一次准备。
func (r *Room) Ready(seat int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil || r.seats[seat].isBot {
		return ErrBadSeat
	}
	if r.status != model.StatusWaiting {
		return nil // 局中准备 = 预约下一手，v1 简化为忽略
	}
	r.seats[seat].ready = true
	r.broadcastLocked(model.TypeReadied, model.ReadiedPayload{Seat: seat}) // 准备标记广播（每手重置）
	r.maybeStartLocked()
	return nil
}

// Action 提交下注动作（上行 action；amount 语义 = bet/raise「加到」本轮总投入目标）。
// 非法动作同步回 error 消息（不回显隐藏数据，D7）。
func (r *Room) Action(seat int, a model.ActionPayload) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil {
		return ErrBadSeat
	}
	if r.game == nil {
		return ErrNotPlaying
	}
	err := r.game.Submit(game.Action{Seat: seat, Type: a.Type, Amount: a.Amount})
	if err != nil {
		r.sendErrorLocked(seat, "illegal_action", err.Error())
		return err
	}
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
	if r.game == nil {
		return 0, ErrNotPlaying
	}
	cost, err := r.game.Reveal(game.RevealReq{Seat: seat, CardID: rp.CardID, Scope: rp.Scope})
	if err != nil {
		r.sendErrorLocked(seat, "illegal_reveal", err.Error())
		return 0, err
	}
	return cost, nil
}

// Leave 离座：空闲期立即释放；局内先标记，手牌结束后生效（避免座位中途蒸发）。
func (r *Room) Leave(seat int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil {
		return ErrBadSeat
	}
	if r.status == model.StatusPlaying {
		r.seats[seat].pendingLeave = true
		r.seats[seat].link = nil
		r.tickBotsLocked()
		return nil
	}
	r.freeSeatLocked(seat)
	r.checkDissolveLocked()
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
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil {
		return
	}
	r.sendLocked(seat, model.TypeSnapshot, r.snapshotLocked(seat))
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

// maybeStartLocked 判断提前开局条件（≥1 人类且全部人类已准备）并开第一/下一局：
// 全员 ready 可在 nextHand 排程到点前提前开局（局中 ready 仍忽略，见 Ready）；
// 开局失败不死桌（beginHandLocked 自回滚并广播 error，可重新 ready 开局）。
func (r *Room) maybeStartLocked() {
	if r.status != model.StatusWaiting {
		return
	}
	humans, ready := 0, 0
	for _, o := range r.seats {
		if o != nil && !o.isBot {
			humans++
			if o.ready {
				ready++
			}
		}
	}
	if humans == 0 || ready < humans {
		return
	}
	r.stopNextHandTimerLocked() // 提前开局，取消下一手自动排程
	r.beginHandLocked()
}

// beginHandLocked 开一手牌：补 bot -> 绑定 game 座位 -> 换新牌池 -> 落手牌行 -> Start。
// 死桌防护：装盒/落 hands/Start 任一步失败即回滚半成品并广播 error（bad_state/deck_exhausted 等），
// 状态保持 waiting、绝不滞留 playing，可重新 ready 开局（game.Start 失败不推进状态机，可重试）。
func (r *Room) beginHandLocked() {
	// 0) 换手重置 bot 再加注计数（每手每街独立封顶，见 BotParams.MaxRaises）。
	clear(r.botRaiseCount)
	clear(r.botRaisePhase)

	// 1) 空位 bot 补位（A4.4）。
	for i, o := range r.seats {
		if o == nil {
			r.seats[i] = &occupant{nick: BotNick(i), isBot: true, ready: true}
		}
	}

	// 2) 本手牌盒：优先用后台预生成的下一手牌盒，缺则现抽（回退）。种子在开局成功后才固证。
	deck, seed := r.takeDeckLocked()

	// 3) game 实例：首手 New，之后复用长实例（筹码/积分跨手延续）。
	if r.game == nil {
		gc := GameConfig(r.cfg, r.turnTimeoutSeconds, r.timing.MaxRebuys)
		r.game = game.New(gc, deck)
		go r.run(r.game.Events())
	}

	// 4) 同步 game 座位绑定（人来了可替换：改绑昵称 / 新入座补绑）。
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

	// 5) 换新牌池（长实例每手换盒；可复现性由 hands.deck 落库保证：deck 即回放真源）。
	if err := r.game.SetDeck(deck); err != nil {
		// 装盒失败即中止：此时未落任何房间状态，保持 waiting 可重新 ready 开局。
		slog.Error("game.SetDeck 失败，开局中止", "room", r.code, "err", err)
		r.broadcastErrorLocked(errCode(err, game.CodeBadState), err.Error())
		return
	}

	// 6) 落手牌行（牌池记账，可回放）。失败中止并回滚手序号，保持 waiting 可重新 ready 开局。
	r.handSeq++
	r.actionSeq = 0
	deckJSON, _ := json.Marshal(deck)
	handID, err := r.st.CreateHand(model.HandRecord{
		RoomID: r.id, Seq: r.handSeq, Deck: string(deckJSON),
		Community: "[]", StartedAt: model.Now(),
	})
	if err != nil {
		r.handSeq--
		slog.Error("落手牌行失败，开局中止", "room", r.code, "err", err)
		r.broadcastErrorLocked(game.CodeInternal, err.Error())
		return
	}
	r.handID = handID

	// 7) 状态推进 + 开局（发牌/下注由 game 事件驱动）。
	for _, o := range r.seats {
		if o != nil {
			o.ready = false // 准备每手消耗一次
		}
	}
	if err := r.game.Start(); err != nil {
		// 死桌防护：开局失败不推进状态机不发事件，可重试；回滚半成品（手牌行/手序号/种子），
		// 状态保持 waiting，绝不滞留 playing。错误码复用 game 回执码（bad_state/deck_exhausted）。
		r.rollbackHandLocked(handID)
		slog.Error("开局失败，已回滚", "room", r.code, "err", err)
		r.broadcastErrorLocked(errCode(err, game.CodeBadState), err.Error())
		return
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

	// 8) 本手进行中后台预生成下一手牌盒（seed 独立；未就绪/失败届时回退现抽）。
	go r.prepNextDeck()
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
	r.stopNextHandTimerLocked()
	startAt := time.Now().Add(r.timing.NextHandDelay)
	r.nextHandTimer = time.AfterFunc(r.timing.NextHandDelay, r.onNextHandTick)
	r.broadcastLocked(model.TypeNextHand, model.NextHandPayload{StartAt: startAt.UnixMilli()})
}

// stopNextHandTimerLocked 取消下一手排程（提前开局/关桌时清场）。
func (r *Room) stopNextHandTimerLocked() {
	if r.nextHandTimer != nil {
		r.nextHandTimer.Stop()
		r.nextHandTimer = nil
	}
}

// onNextHandTick 下一手排程到点：active≥2 且有在座人类即自动开局；
// 不足则继续等待（新玩家入座可 ready 开局，下一次排程随下一手 settled 产生）。
func (r *Room) onNextHandTick() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextHandTimer = nil
	if r.closed || r.status != model.StatusWaiting {
		return
	}
	occupied, humans := 0, 0
	for _, o := range r.seats {
		if o == nil {
			continue
		}
		occupied++
		if !o.isBot {
			humans++
		}
	}
	if humans == 0 || occupied < 2 {
		return
	}
	r.beginHandLocked()
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
		return model.SnapshotPayload{
			RoomCode:   r.code,
			AutoReveal: r.cfg.AutoReveal,
			Phase:      model.PhaseWaiting,
			Seats:      seats,
			MySeat:     seat,
			MyCards:    []model.CardData{},
			Community:  []model.CardData{},
			TurnSeat:   -1,
			SmallBlind: r.cfg.SmallBlind,
			BigBlind:   r.cfg.BigBlind,
			RevealRate: r.cfg.RevealRate,
			Reveals:    []model.RevealRecord{},
			ChatEnabled: r.cfg.ChatEnabled,
			Seq:        r.seq, // 快照基线 = 最后事件序号（本帧信封 seq = 基线+1）
			TurnMs:     r.turnTimeoutSeconds * 1000,
			Seed:       nil, // 未开局无「当前手 seed」
			Box:        []model.BoxCard{},
			Pool:       r.poolInfoLocked(),
		}
	}
	raw, err := json.Marshal(r.game.SnapshotFor(seat))
	if err != nil {
		slog.Error("game 快照序列化失败", "room", r.code, "err", err)
		return model.SnapshotPayload{RoomCode: r.code, MySeat: seat, TurnSeat: -1}
	}
	var s model.SnapshotPayload
	if err := json.Unmarshal(raw, &s); err != nil {
		slog.Error("game 快照解析失败", "room", r.code, "err", err)
		return model.SnapshotPayload{RoomCode: r.code, MySeat: seat, TurnSeat: -1}
	}
	s.RoomCode = r.code // game 不知道房间码，room 补
	s.MySeat = seat
	s.ChatEnabled = r.cfg.ChatEnabled
	if r.handSeedCommit != "" { // 本手固证（断线快照恢复后仍可验证，frontend-contract §2）
		sc := r.handSeedCommit
		s.SeedCommit = &sc
	}
	// 契约扩展字段装配（minRaise/turnMs/box/seats[i].rebuys 从 game 只读访问器取；
	// seq/seed/box/pool/ready 以 room 为真源）。
	s.Seq = r.seq // 快照基线 = 信封 seq 的当前值（本帧信封 seq = 基线+1）
	s.MinRaise = r.game.MinRaise()
	s.TurnMs = r.game.TurnMs()
	if r.seedRevealed { // 当前手 seed：摊牌后可见，之前 null
		seed := strconv.FormatInt(r.handSeed, 10)
		s.Seed = &seed
	}
	box := r.game.Box() // 盒名单只含 L1 公开字段（D7/D17）
	s.Box = make([]model.BoxCard, 0, len(box))
	for _, bc := range box {
		s.Box = append(s.Box, model.BoxCard{
			ID: bc.ID, Title: bc.Title, Score: bc.Score, Bucket: bc.Bucket, Year: bc.Year,
		})
	}
	s.Pool = r.poolInfoLocked()
	for i := range s.Seats {
		if i < len(r.seats) && r.seats[i] != nil {
			s.Seats[i].Nick = r.seats[i].nick // room 是昵称真源（game 侧同步可能滞后）
			s.Seats[i].Ready = r.seats[i].ready
			s.Seats[i].Rebuys = r.game.Rebuys(i)
		} else {
			s.Seats[i].Nick = ""
		}
	}
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

	switch ev.Type {
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

	case model.TypeSettled:
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
	// chips/points 为全局字段（与视角无关），取一次快照复用，避免逐座全量重算。
	snap := r.snapshotLocked(0)
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
	// 对账帧：座位/筹码结构变化（重买/离席/断线回收/破产处置）后广播全量快照。
	r.broadcastSnapshotLocked()
	// 下一手节奏：排程自动开局定时器并广播 nextHand{startAt}（全员 ready 可提前开局）。
	r.scheduleNextHandLocked()
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

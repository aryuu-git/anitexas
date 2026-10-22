// Package game 是 AniTexas 的对局状态机:无限注德州的手牌生命周期、下注轮转、
// 主/边池拆分、隐藏模式揭示(REVEAL)与双账本(筹码/积分)结算。
// 一桌一实例、单 goroutine 串行推进(D12);隐藏数据不进任何下行消息(D2/D7),
// 在 SnapshotFor 与事件载荷构造处兜底。玩法规则真源 docs/rules.html v1.0。
package game

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"anitexas/backend/internal/engine"
)

// 动作/操作错误码:Submit/Reveal/Join 等同步回 error 的 Code,ServerRuntime
// 可转成 error 事件下发;任何错误都不得回显隐藏数据(D7)。
const (
	CodeBadState       = "bad_state"        // 阶段/时机不对
	CodeBadSeat        = "bad_seat"         // 座位号非法
	CodeNotInPlay      = "not_in_play"      // 未入座或已离桌
	CodeNotYourTurn    = "not_your_turn"    // 非轮到者
	CodeBadAction      = "bad_action"       // 未知动作类型
	CodeBadAmount      = "bad_amount"       // 金额非法(负数/目标不合法)
	CodeChipOverbet    = "chip_overbet"     // 超额下注(超出自身筹码)
	CodeMinBet         = "min_bet"          // 下注低于最小下注
	CodeMinRaise       = "min_raise"        // 加注低于最小加注
	CodeNoBet          = "no_bet"           // 无注可跟/无注可加
	CodeCheckFacingBet = "check_facing_bet" // 面对下注不能过牌
	CodeNotYourCard    = "not_your_card"    // 对手底牌不可揭示(D2)
	CodeBadCard        = "bad_card"         // 非本手的牌
	CodeBadScope       = "bad_scope"        // 可见范围非法
	CodeDeckExhausted  = "deck_exhausted"   // 牌堆余量不足一手牌
	CodeRebuyExhausted = "rebuy_exhausted"  // 重买次数用尽(MAX_REBUYS)
	CodeInternal       = "internal"
)

// Action 是一次下注动作。Amount 语义:bet/raise 为「加到」本轮总投入的目标值,
// call/check/fold/allin 忽略(由服务端按规则自动结算投入)。
type Action struct {
	Seat   int
	Type   string // check|bet|call|raise|fold|allin
	Amount int
}

// RevealReq 是一次揭示请求。自己的底牌可 private,公共牌只能 public,
// 对手底牌一律拒绝(D2)。v1 成本恒 0,账照记(§1.3/D4)。
type RevealReq struct {
	Seat   int
	CardID int64
	Scope  string // private(仅自己)| public(全桌)
}

// CardView 是牌面的下行视角(§1.1 L1/L2)。隐藏规则(D14 唯一模式):未揭示牌的
// Elements 为 nil,序列化后整体不含 elements 字段(§2 原则 2 / D7)。
type CardView struct {
	ID       int64            `json:"id"`
	Title    string           `json:"title"`
	Score    float64          `json:"score"`
	Bucket   float64          `json:"bucket"`
	Year     int              `json:"year"`
	Elements []engine.Element `json:"elements,omitempty"`
}

// monogram 取作品名首字(空名取空串,D10 生成封面用)。
func monogram(title string) string {
	for _, r := range title {
		return string(r)
	}
	return ""
}

// MarshalJSON 补上 monogram,并把要素序列化为线上小写键 {class,value}
// (engine.Element 无 tag,直接序列化是 {Class,Value},与线上不符);
// Elements 为 nil 时 elements 字段整体省略(隐藏数据零泄露,D7)。
func (c CardView) MarshalJSON() ([]byte, error) {
	w := struct {
		ID       int64         `json:"id"`
		Title    string        `json:"title"`
		Score    float64       `json:"score"`
		Bucket   float64       `json:"bucket"`
		Year     int           `json:"year"`
		Monogram string        `json:"monogram"`
		Elements []WireElement `json:"elements,omitempty"`
	}{
		ID: c.ID, Title: c.Title, Score: c.Score, Bucket: c.Bucket,
		Year: c.Year, Monogram: monogram(c.Title), Elements: wireElements(c.Elements),
	}
	return json.Marshal(w)
}

// Config 是一桌的建房配置(环境变量名对齐 deploy/anitexas.env.example)。
// D14:揭示机制是唯一模式;AutoReveal=true 只是开局把全部牌标记为已揭示
// (初始可见性状态),Reveal 校验/记账/快照隐藏规则不变。
type Config struct {
	Seats, SmallBlind, BigBlind, StartChips, DeckSize, RevealFee int
	TurnTimeoutMs                                                int    // 行动倒计时(毫秒);<=0 表示不启用超时自动动作
	MaxRebuys                                                    int    // 每座位重买上限(MAX_REBUYS);<=0 不限次
	AutoReveal                                                   bool   // 开局即全部揭示(默认 false:未揭示不下发要素)
	DeckStrategy                                                 string // "stratified" 分层随机(默认) | "theme" 主题池
}

// seatState 是座位的对局内状态(筹码/积分为跨手延续的两本账,§1.4)。
type seatState struct {
	inPlay     bool // 在局(已入座)
	isBot      bool
	nick       string
	chips      int           // 筹码账
	points     int           // 积分账(跨手延续)
	hole       []engine.Card // 本手底牌(最多 2 张)
	bet        int           // 本轮总投入
	committed  int           // 本手总投入(进池)
	folded     bool
	allIn      bool
	acted      bool // 本轮是否已动作(快照「是否已行动」)
	canRaise   bool // 本轮是否仍可加注(短全下加注后置 false)
	revealCost int  // 本手累计揭示成本
	rebuys     int  // 本座位累计重买次数(破产重买上限判定;新入座重新计)
}

// Game 是一桌对局状态机。写操作只发生在表 goroutine(D12:单 goroutine 串行推进),
// g.mu 仅保护内部状态被 SnapshotFor 等并发读。
type Game struct {
	cfg     Config
	deck    []engine.Card // 一桌牌堆(切好的整副,Game 只吃现成 deck)
	deckPos int           // 发牌游标:一手牌消耗 2*人数+5 张(一手内不重复发牌,A3.3)

	// 手牌生命周期(见 state.go 转移表)
	state   string
	street  string // betting 阶段的下注街
	handSeq int    // 手牌序号,从 1 起
	button  int    // 庄家位(-1 表示本手未定)
	sbSeat  int
	bbSeat  int
	dealt   []int // 本手发过底牌的座位(结算行范围)

	seats      []seatState
	pot        int          // 本手注池 = Σ committed
	currentBet int          // 本轮最高总投入
	minRaise   int          // 最小加注增量
	pending    map[int]bool // 本轮仍欠动作的座位
	turn       int          // 当前行动座位(-1 = 无)
	deadline   time.Time    // 行动截止(零值 = 未开倒计时)
	timerGen   uint64       // 倒计时代数,防过期定时器误触

	board      []engine.Card // 本手公共牌(发牌期从牌堆取出,共 5 张)
	community  []engine.Card // 已亮出的公共牌(未翻牌不出现在任何下行消息)
	runoutFlag bool          // 本手已进入全下直发(供快照 runout 表达)

	reveals        []RevealRecord         // 本手揭示记录(结算汇入积分账)
	publicRevealed map[int64]bool         // 已揭示且全桌可见的牌(不可逆,D3)
	revPrivate     map[int64]map[int]bool // 已私看的牌:牌 id -> 可见座位

	// 表 goroutine 命令队列与事件流
	mu     sync.Mutex
	cond   *sync.Cond // 仅用于 Close 唤醒,主循环走 channel
	evBuf  []Event    // 单条命令的事件暂存,保序后统一下发
	cmds   chan gameCmd
	events chan Event
	done   chan struct{} // 关闭信号
	closed chan struct{} // 表 goroutine 已退出
}

// gameCmd 是入队的命令:fn 只在表 goroutine 执行,resp 带回同步结果。
type gameCmd struct {
	fn   func() error
	resp chan error
}

// New 建一桌对局:cfg 建房配置、deck 为切好的整副牌(SampleDeck 产物)。
// 不启动任何牌局;Start() 才开局。Events() 的消费者必须及时排空事件流。
func New(cfg Config, deck []engine.Card) *Game {
	if cfg.Seats < 2 {
		cfg.Seats = 2
	}
	g := &Game{
		cfg:            cfg,
		deck:           append([]engine.Card(nil), deck...),
		state:          PhaseWaiting,
		button:         -1,
		turn:           -1,
		seats:          make([]seatState, cfg.Seats),
		pending:        map[int]bool{},
		publicRevealed: map[int64]bool{},
		revPrivate:     map[int64]map[int]bool{},
		cmds:           make(chan gameCmd, 256),
		events:         make(chan Event, 4096),
		done:           make(chan struct{}),
		closed:         make(chan struct{}),
	}
	for i := range g.seats {
		g.seats[i].inPlay = false
	}
	go g.loop()
	return g
}

// Events 返回事件流出端(信封 t 由 ServerRuntime 依 Type 赋值,seq 由房间分配)。
// 缓冲 4096;消费者停摆会反压表 goroutine,必须及时排空。
func (g *Game) Events() <-chan Event { return g.events }

// Close 停表 goroutine(测试/关桌用);幂等。
func (g *Game) Close() {
	select {
	case <-g.done:
		return
	default:
		close(g.done)
	}
	<-g.closed
}

// call 入队一条命令并在表 goroutine 执行,同步返回结果。
func (g *Game) call(fn func() error) error {
	resp := make(chan error, 1)
	c := gameCmd{fn: fn, resp: resp}
	select {
	case g.cmds <- c:
	case <-g.done:
		return errors.New("对局已关闭")
	}
	select {
	case err := <-resp:
		return err
	case <-g.done:
		return errors.New("对局已关闭")
	}
}

// loop 是表 goroutine:串行消费命令并处理超时自动动作(D12)。
func (g *Game) loop() {
	defer close(g.closed)
	for {
		var timerC <-chan time.Time
		var timer *time.Timer
		var gen uint64
		var seat int
		g.mu.Lock()
		if !g.deadline.IsZero() && g.turn >= 0 {
			d := time.Until(g.deadline)
			if d < 0 {
				d = 0
			}
			timer = time.NewTimer(d)
			timerC = timer.C
			gen, seat = g.timerGen, g.turn
		}
		g.mu.Unlock()
		select {
		case <-g.done:
			if timer != nil {
				timer.Stop()
			}
			return
		case c := <-g.cmds:
			if timer != nil {
				timer.Stop()
			}
			g.runCmd(c.fn, c.resp)
		case <-timerC:
			g.mu.Lock()
			changed := g.onTimeout(gen, seat)
			evs := g.flushEvents()
			var commit *CommitPayload
			if changed {
				commit = g.captureCommitLocked()
			}
			g.mu.Unlock()
			g.emitAll(evs)
			if commit != nil {
				g.emitAll([]Event{{Type: EventCommit, Payload: commit}})
			}
		}
	}
}

// runCmd 在表 goroutine 执行命令:状态写入持 g.mu,事件先于返回值下发
// (同命令内事件保序;调用方返回时其事件已入流)。
func (g *Game) runCmd(fn func() error, resp chan error) {
	g.mu.Lock()
	err := fn()
	evs := g.flushEvents()
	// v2 事务输出：成功命令在锁内捕获全部视角快照，与事件同批交给 room 顺序投影。
	// 失败命令不推进状态，不产生 commit（room 只回退回执）。
	var commit *CommitPayload
	if err == nil && (g.handSeq > 0 || g.state != PhaseWaiting) {
		// 开局前的 Join/SetDeck 不产生可见提交，避免「playing+waiting+第 0 手」的假帧。
		commit = g.captureCommitLocked()
	}
	g.mu.Unlock()
	g.emitAll(evs)
	if commit != nil {
		g.emitAll([]Event{{Type: EventCommit, Payload: commit}})
	}
	if resp != nil {
		resp <- err
	}
}

// captureCommitLocked 捕获本事务的不可变状态投影（调用方持 g.mu）。
// Snapshots 下标即座位号；隐藏数据已由 snapshotLocked 按视角裁剪。
func (g *Game) captureCommitLocked() *CommitPayload {
	snaps := make([]Snapshot, 0, g.cfg.Seats)
	for seat := 0; seat < g.cfg.Seats; seat++ {
		snaps = append(snaps, g.snapshotLocked(seat))
	}
	return &CommitPayload{Snapshots: snaps}
}

// flushEvents 取走并清空事件暂存(调用方持 g.mu)。
func (g *Game) flushEvents() []Event {
	evs := g.evBuf
	g.evBuf = nil
	return evs
}

// emitAll 按序把事件推入流出端(阻塞背压;消费者必须及时排空)。
func (g *Game) emitAll(evs []Event) {
	for _, ev := range evs {
		select {
		case g.events <- ev:
		case <-g.done:
			return
		}
	}
}

// emit 暂存一条事件(调用方持 g.mu;同一条命令内的事件保序)。
func (g *Game) emit(typ string, payload any) {
	g.evBuf = append(g.evBuf, Event{Type: typ, Payload: payload})
}

// emitErr 暂存一条错误事件。
func (g *Game) emitErr(code, msg string) {
	g.emit(EventError, &ErrorPayload{Code: code, Msg: msg})
}

// Join 入座:v1 无账号,房间码 + 昵称(D9)。中途入座只参与下一手。
// 在局中的手牌不可入座(座位数固定,发牌中途不加人)。
func (g *Game) Join(seat int, nick string, isBot bool) error {
	return g.call(func() error {
		if seat < 0 || seat >= g.cfg.Seats {
			return fmt.Errorf("%s: 座位号非法", CodeBadSeat)
		}
		s := &g.seats[seat]
		if s.inPlay {
			return fmt.Errorf("%s: 座位已有人", CodeBadSeat)
		}
		if g.state == PhaseDealing {
			return fmt.Errorf("%s: 发牌期不可入座", CodeBadState)
		}
		*s = seatState{inPlay: true, isBot: isBot, nick: nick,
			chips: g.cfg.StartChips, points: 0, canRaise: true}
		return nil
	})
}

// Leave 离桌:手中未弃牌则即刻弃牌(可能触发结算),积分/筹码随座位清空。
func (g *Game) Leave(seat int) error {
	return g.call(func() error {
		if seat < 0 || seat >= g.cfg.Seats {
			return fmt.Errorf("%s: 座位号非法", CodeBadSeat)
		}
		s := &g.seats[seat]
		if !s.inPlay {
			return fmt.Errorf("%s: 未入座", CodeNotInPlay)
		}
		if g.state == PhaseBetting && g.inHand(&g.seats[seat]) && !s.folded {
			// 离桌强制弃牌:临时借走行动权,生效路径与普通弃牌完全一致
			// (可能即刻触发弃牌赢结算);失败则原样归还行动权,状态不变。
			old := g.turn
			g.turn = seat
			if err := g.applyAction(Action{Seat: seat, Type: "fold"}); err != nil {
				g.turn = old
				return err
			}
		}
		*s = seatState{inPlay: false}
		return nil
	})
}

// SetDeck 换一副切好的牌(开新桌/洗牌重切用);仅 Waiting/Settled 可换。
func (g *Game) SetDeck(deck []engine.Card) error {
	return g.call(func() error {
		if g.state != PhaseWaiting && g.state != PhaseSettled {
			return fmt.Errorf("%s: 对局进行中不可换牌", CodeBadState)
		}
		g.deck = append([]engine.Card(nil), deck...)
		g.deckPos = 0
		return nil
	})
}

// Rebuy 破产重买入座（R2/D19：重买额=初始筹码，仅筹码账、积分不受影响）。
// 破产后就地重买把筹码补回初始额、积分保持不变，并计入座位 rebuys；
// 超过 cfg.MaxRebuys 上限拒绝（rebuy_exhausted），计数与筹码均不动。
// bot 破产直接换新 bot（不走此）。
func (g *Game) Rebuy(seat int) error {
	return g.call(func() error {
		if seat < 0 || seat >= g.cfg.Seats {
			return fmt.Errorf("%s: 座位号非法", CodeBadSeat)
		}
		s := &g.seats[seat]
		if g.cfg.MaxRebuys > 0 && s.rebuys >= g.cfg.MaxRebuys {
			return fmt.Errorf("%s: 重买次数已达上限 %d", CodeRebuyExhausted, g.cfg.MaxRebuys)
		}
		s.rebuys++
		s.chips = g.cfg.StartChips // 只动筹码，points 不碰
		return nil
	})
}

// Start 开一手牌(Waiting/Settled -> Dealing -> Betting)。
// 开局失败(时机不对/人数不足/牌堆余量不足)同步回 error(bad_state/deck_exhausted)
// 且状态机不推进(失败保持原阶段)、可重试;不再发 error 事件,
// 回执 code 由 ServerRuntime 转成 error 事件下发(与 Submit/Join 同规)。
func (g *Game) Start() error {
	return g.call(g.doStart)
}

// Submit 提交下注动作。金额非法/非轮到者/阶段不对同步回 error 且不推进状态。
func (g *Game) Submit(a Action) error {
	return g.call(func() error { return g.applyAction(a) })
}

// Reveal 揭示一张牌:校验时机/归属/范围,记 reveal 账,发 revealed 事件。
// 成本 = cfg.RevealFee(v1 恒 0,账照记,§1.3/D4)。返回本次记账成本。
func (g *Game) Reveal(r RevealReq) (int, error) {
	var cost int
	err := g.call(func() error {
		var err error
		cost, err = g.applyReveal(r)
		return err
	})
	return cost, err
}

// doStart 开一手牌:选座、轮庄、发牌、扣盲注、进下注期、发起行动倒计时。
// 校验(时机/人数/牌堆)全在 Waiting->Dealing 转移前完成,失败同步回 error 且
// 状态机不推进(保持原阶段、可重试)。只能在表 goroutine 内调用(调用方持 g.mu)。
func (g *Game) doStart() error {
	if g.state != PhaseWaiting && g.state != PhaseSettled {
		return actionErr(CodeBadState, fmt.Sprintf("阶段 %s 不可开局", g.state))
	}
	active := g.eligibleSeats()
	if len(active) < 2 {
		return actionErr(CodeBadState, "对局玩家不足 2 人")
	}
	need := 2*len(active) + 5
	if g.deckPos+need > len(g.deck) {
		return actionErr(CodeDeckExhausted, "牌堆余量不足一手牌")
	}
	if err := g.transition(PhaseDealing); err != nil {
		return actionErr(CodeBadState, err.Error())
	}
	g.handSeq++
	// 重置每手字段(筹码/积分跨手延续)
	for i := range g.seats {
		s := &g.seats[i]
		s.hole, s.bet, s.committed = nil, 0, 0
		s.folded, s.allIn, s.acted, s.canRaise = false, false, false, true
		s.revealCost = 0
	}
	g.pot, g.currentBet, g.minRaise = 0, 0, g.cfg.BigBlind
	g.pending = map[int]bool{}
	g.community, g.board = nil, nil
	g.runoutFlag = false
	g.reveals = nil
	g.publicRevealed = map[int64]bool{}
	g.revPrivate = map[int64]map[int]bool{}
	g.dealt = nil
	g.deadline, g.timerGen = time.Time{}, g.timerGen+1

	// 庄家轮转:下一手交给庄家后的第一个在局玩家(首手 = 座位最小的在局玩家)
	g.button = g.nextEligible(g.button)
	// 盲注位:两人桌庄家下小盲;多人桌庄家后依次小盲、大盲
	if len(active) == 2 {
		g.sbSeat = g.button
		g.bbSeat = g.nextEligible(g.button)
	} else {
		g.sbSeat = g.nextEligible(g.button)
		g.bbSeat = g.nextEligible(g.sbSeat)
	}

	// 发底牌:两轮轮转(庄家下家起),公共牌取 5 张备用(逐街亮出)
	start := g.nextEligible(g.button)
	startIdx := g.seatIndex(active, start)
	pos := g.deckPos
	for r := 0; r < 2; r++ {
		for i := 0; i < len(active); i++ {
			s := active[(startIdx+i)%len(active)]
			g.seats[s].hole = append(g.seats[s].hole, g.deck[pos])
			pos++
		}
	}
	g.board = append([]engine.Card(nil), g.deck[pos:pos+5]...)
	pos += 5
	g.deckPos = pos
	// D14:AutoReveal 桌开局即把全部牌(底牌+公共牌)标记为已揭示,
	// 只是初始可见性状态,后续揭示校验/记账逻辑不变。
	if g.cfg.AutoReveal {
		for _, s := range active {
			for _, c := range g.seats[s].hole {
				g.publicRevealed[c.ID] = true
			}
		}
		for _, c := range g.board {
			g.publicRevealed[c.ID] = true
		}
	}
	for _, s := range active {
		g.dealt = append(g.dealt, s)
		g.emit(EventDealt, &DealtPayload{Seat: s, Cards: g.cardViews(s, g.seats[s].hole)})
	}

	// 盲注入池(带入受筹码限制;小盲/大盲全下带入同样合法)
	g.postBlind(g.sbSeat, g.cfg.SmallBlind)
	g.postBlind(g.bbSeat, g.cfg.BigBlind)
	g.currentBet = maxInt(g.seats[g.sbSeat].bet, g.seats[g.bbSeat].bet)

	// 进下注期:preflop 由大盲后第一家行动(两人桌 = 庄家/小盲先动)
	// (Dealing->Betting 恒合法,失败为理论不可达的防御分支,同步回 internal)
	if err := g.transition(PhaseBetting); err != nil {
		return actionErr(CodeInternal, err.Error())
	}
	g.street = StreetPreflop
	for _, s := range active {
		if !g.seats[s].allIn {
			g.pending[s] = true
		}
	}
	g.turn = g.nextPending(g.bbSeat)
	if len(g.pending) == 0 {
		// 防御:盲注即把在局者全下光(无欠动作者)——直发公共牌进摊牌,避免滞留
		g.runout()
		return nil
	}
	g.startTurnTimer()
	return nil
}

// postBlind 扣盲注入池(带入 min(盲注, 筹码);筹码扣完即全下)。
func (g *Game) postBlind(seat, blind int) {
	s := &g.seats[seat]
	amount := minInt(blind, s.chips)
	s.chips -= amount
	s.bet += amount
	s.committed += amount
	g.pot += amount
	if s.chips == 0 {
		s.allIn = true
	}
}

// eligibleSeats 返回可参与一手牌的座位(在局且有筹码),升序。
func (g *Game) eligibleSeats() []int {
	out := []int{}
	for i := range g.seats {
		if g.seats[i].inPlay && g.seats[i].chips > 0 {
			out = append(out, i)
		}
	}
	return out
}

// seatIndex 返回 seat 在 seats 切片中的下标,不存在返回 0。
func (g *Game) seatIndex(seats []int, seat int) int {
	for i, s := range seats {
		if s == seat {
			return i
		}
	}
	return 0
}

// nextEligible 返回 from 之后(座位号环回)的下一个可参与座位;
// from < 0 时返回座位最小的可参与座位。无可用座位返回 -1。
func (g *Game) nextEligible(from int) int {
	for i := 1; i <= g.cfg.Seats; i++ {
		s := (from + i) % g.cfg.Seats
		if from < 0 {
			s = (i - 1) % g.cfg.Seats
		}
		if g.seats[s].inPlay && g.seats[s].chips > 0 {
			return s
		}
	}
	return -1
}

// nextPending 返回 from 之后(座位号环回)的下一个欠动作座位,无则 -1。
func (g *Game) nextPending(from int) int {
	for i := 1; i <= g.cfg.Seats; i++ {
		s := (from + i) % g.cfg.Seats
		if g.pending[s] {
			return s
		}
	}
	return -1
}

// startTurnTimer 为当前行动者开倒计时(超时自动动作,§4.2);
// TurnTimeoutMs <= 0 不启用。每次换行动者 timerGen +1 防过期定时器误触。
func (g *Game) startTurnTimer() {
	g.timerGen++
	if g.turn < 0 || g.cfg.TurnTimeoutMs <= 0 {
		g.deadline = time.Time{}
		return
	}
	g.deadline = time.Now().Add(time.Duration(g.cfg.TurnTimeoutMs) * time.Millisecond)
}

// stopTurnTimer 撤销倒计时(行动/结算后)。
func (g *Game) stopTurnTimer() {
	g.timerGen++
	g.deadline = time.Time{}
}

// deadlinePtr 返回下行用的截止时间戳(Unix 毫秒);无行动/无倒计时返回 nil。
func (g *Game) deadlinePtr() *int64 {
	if g.deadline.IsZero() || g.turn < 0 {
		return nil
	}
	ms := g.deadline.UnixMilli()
	return &ms
}

// turnPtr 返回下行用的行动座位号(无行动者 = -1,仍以非 nil 下发)。
func (g *Game) turnPtr() *int {
	t := g.turn
	return &t
}

// minRaisePtr 返回下行用的最小加注增量(服务端权威,恒非 nil)。
func (g *Game) minRaisePtr() *int {
	m := g.minRaise
	return &m
}

// onTimeout 超时自动动作(表 goroutine 定时回调):本轮有注 -> 弃牌,无注 -> 过牌。
// gen 校验防止过期定时器在换行动者后误触。
func (g *Game) onTimeout(gen uint64, seat int) bool {
	if gen != g.timerGen || seat != g.turn {
		return false
	}
	if g.state != PhaseBetting || g.turn < 0 {
		return false
	}
	s := &g.seats[g.turn]
	typ := "check"
	if s.bet < g.currentBet {
		typ = "fold"
	}
	if err := g.applyAction(Action{Seat: seat, Type: typ}); err != nil {
		g.emitErr(CodeInternal, "超时自动动作失败: "+err.Error())
		return false
	}
	return true
}

// cardViews 构造 viewer 视角的牌面序列(隐藏规则在此兜底):
// explicit 恒含要素;hidden 仅已揭示(公私)的牌含要素,nil 则整体省略(D2/D7)。
func (g *Game) cardViews(viewer int, cards []engine.Card) []CardView {
	out := make([]CardView, 0, len(cards))
	for _, c := range cards {
		v := CardView{ID: c.ID, Title: c.Title, Score: c.Score, Bucket: c.Bucket, Year: c.Year}
		if g.elementsVisible(viewer, c.ID) {
			v.Elements = c.Elements
		}
		out = append(out, v)
	}
	return out
}

// elementsVisible 判断 viewer 能否看到某张牌的 L2 要素。
// 揭示机制是唯一模式(D14):仅已揭示的牌可见(公私范围按 §1.3);
// AutoReveal 桌开局即把全部牌标记为已揭示,故恒可见。
func (g *Game) elementsVisible(viewer int, cardID int64) bool {
	if g.publicRevealed[cardID] {
		return true
	}
	return g.revPrivate[cardID][viewer]
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

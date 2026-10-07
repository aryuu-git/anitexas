package game

// SeatState 是快照里的座位状态(昵称/筹码/积分/状态/本轮注,§4.2)。
// JSON 形状与 ServerRuntime 的 model.SnapshotPayload.seats 逐字一致。
type SeatState struct {
	Seat      int    `json:"seat"`
	Nick      string `json:"nick"`
	Chips     int    `json:"chips"`  // 筹码账
	Points    int    `json:"points"` // 积分账(跨手延续)
	Bet       int    `json:"bet"`    // 本轮注
	Folded    bool   `json:"folded"`
	Acted     bool   `json:"acted"`     // 本轮是否已行动
	IsDealer  bool   `json:"isDealer"`
	HoleCount int    `json:"holeCount"` // 已发底牌张数
}

// Snapshot 是按视角构造的全桌快照(JSON 直发 WS;§4.2)。
// JSON 形状与 ServerRuntime 的 model.SnapshotPayload 逐字一致(roomCode 由房间补);
// 契约扩展字段 minRaise/turnMs/box/seats[i].rebuys 由 room 经只读访问器
// (MinRaise/TurnMs/Box/Rebuys)装配,不进本结构。
// 隐藏字段规则(D7)在 cardViews/reveals 过滤处兜底:
// 对手底牌永不出现在任何视角(D2),未揭示牌的 elements 不进任何序列化结果。
type Snapshot struct {
	AutoReveal bool           `json:"autoReveal"`
	Phase      string         `json:"phase"` // waiting|preflop|flop|turn|river|showdown|settled(发牌期并入 preflop)
	HandSeq    int            `json:"handSeq"`
	Seats      []SeatState    `json:"seats"`
	MySeat     int            `json:"mySeat"`
	MyCards    []CardView     `json:"myCards"`   // 自己的底牌(视角过滤后)
	Community  []CardView     `json:"community"` // 已亮出的公共牌
	Pot        int            `json:"pot"`
	CurrentBet int            `json:"currentBet"`
	TurnSeat   int            `json:"turnSeat"` // 行动者(-1 = 无)
	Deadline   *int64         `json:"deadline"` // 倒计时截止(Unix 毫秒;无倒计时 = null)
	SmallBlind int            `json:"smallBlind"`
	BigBlind   int            `json:"bigBlind"`
	RevealRate int            `json:"revealRate"` // 单张揭示成本(v1 恒 0)
	Reveals    []RevealRecord `json:"reveals"`    // 已揭示记录(私看仅本人可见)
}

// SnapshotFor 构造 viewer 视角的全桌快照。MyCards/Community 的要素按视角
// 过滤(未揭示不含 elements 字段);私看记录只进本人快照(D7)。
func (g *Game) SnapshotFor(viewer int) Snapshot {
	g.mu.Lock()
	defer g.mu.Unlock()

	snap := Snapshot{
		AutoReveal: g.cfg.AutoReveal,
		Phase:      g.phaseLocked(),
		HandSeq:    g.handSeq,
		Seats:      make([]SeatState, 0, g.cfg.Seats),
		MySeat:     viewer,
		MyCards:    []CardView{},
		Community:  g.cardViews(viewer, g.community),
		Pot:        g.pot,
		CurrentBet: g.currentBet,
		TurnSeat:   g.turn,
		Deadline:   g.deadlinePtr(),
		SmallBlind: g.cfg.SmallBlind,
		BigBlind:   g.cfg.BigBlind,
		RevealRate: g.cfg.RevealFee,
		Reveals:    []RevealRecord{},
	}
	if viewer >= 0 && viewer < g.cfg.Seats && g.inHand(&g.seats[viewer]) {
		snap.MyCards = g.cardViews(viewer, g.seats[viewer].hole)
	}
	for i := range g.seats {
		s := &g.seats[i]
		snap.Seats = append(snap.Seats, SeatState{
			Seat:      i,
			Nick:      s.nick,
			Chips:     s.chips,
			Points:    s.points,
			Bet:       s.bet,
			Folded:    s.folded,
			Acted:     s.acted,
			IsDealer:  i == g.button && g.handSeq > 0,
			HoleCount: len(s.hole),
		})
	}
	for _, rec := range g.reveals {
		if rec.Scope == "public" || rec.Seat == viewer {
			snap.Reveals = append(snap.Reveals, rec)
		}
	}
	return snap
}

// TurnSeat 返回当前行动座位（-1 = 无行动者）。轻量访问器：供 room 的 bot 调度/事件转发
// 取「轮到谁」而不必构造整张快照（避免每个事件一次全量快照的 JSON ser/deser）。
func (g *Game) TurnSeat() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.turn
}

// BoxCard 是牌盒名单的公开牌面（D17）：只有 L1 公开字段，绝不带 elements 等
// 隐藏要素（D7）。盒名单是公开名单（不揭示持牌/发牌信息），room 装配 snapshot.box 用。
type BoxCard struct {
	ID     int64   `json:"id"`
	Title  string  `json:"title"`
	Score  float64 `json:"score"`
	Bucket float64 `json:"bucket"`
	Year   int     `json:"year"`
}

// MinRaise 返回当前最小加注增量（服务端权威：raise 的 target 须 ≥ currentBet+MinRaise，
// 全下豁免）。room 装配 snapshot.minRaise 用。
func (g *Game) MinRaise() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.minRaise
}

// TurnMs 返回本桌行动时限（毫秒，= Config.TurnTimeoutMs；<=0 不启用超时自动动作）。
// room 装配 snapshot.turnMs 用。cfg 建桌后只读，无并发写。
func (g *Game) TurnMs() int { return g.cfg.TurnTimeoutMs }

// Box 返回本手牌盒公开名单（D17，room 装配 snapshot.box 用）：只含 L1 公开字段，
// 不含 elements 等隐藏要素（D7）；返回副本，调用方改写不影响内部状态。
func (g *Game) Box() []BoxCard {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]BoxCard, 0, len(g.deck))
	for _, c := range g.deck {
		out = append(out, BoxCard{
			ID: c.ID, Title: c.Title, Score: c.Score, Bucket: c.Bucket, Year: c.Year,
		})
	}
	return out
}

// Rebuys 返回座位累计重买次数（room 装配 snapshot.seats[i].rebuys 用；
// 非法座位返回 0）。
func (g *Game) Rebuys(seat int) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	if seat < 0 || seat >= g.cfg.Seats {
		return 0
	}
	return g.seats[seat].rebuys
}

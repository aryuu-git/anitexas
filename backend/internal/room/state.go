package room

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"anitexas/backend/internal/game"
	"anitexas/backend/internal/model"
)

// v2 权威状态帧（docs/experience-handoff/02-state-contract.md）：
// room 在锁内把 game 的每次成功事务投影为一份全座位快照，分配单调递增的
// room revision，并给每个在线座位下发按视角裁剪的 state 帧。events 只用于
// 文字历史/音效/动画，不参与权威归约；receipts 只发给命令发起者。

const (
	stateReasonJoin     = "join"
	stateReasonResync   = "resync"
	stateReasonMutation = "mutation"

	// recentEventLimit 是快照内 recentEvents 的保留条数（刷新后恢复文字历史）。
	recentEventLimit = 40
	// receiptCacheLimit 是每座位保留的命令回执条数（去重窗口）。
	receiptCacheLimit = 64
)

// pendingEvent 是尚未被状态帧带走的过程事件；onlySeat>=0 表示只发给该座位
// （dealt 底牌、private 揭示，避免隐私事件扩散）。
type pendingEvent struct {
	ev       model.ExperienceEvent
	onlySeat int
}

// nextRevisionLocked 分配下一个房间可见状态版本。
func (r *Room) nextRevisionLocked() int64 {
	r.revision++
	return r.revision
}

// applyCommitLocked 应用 game 一次成功事务的全座位快照：替换 latest、递增 revision、
// 下发 state 帧（reason=mutation）。
func (r *Room) applyCommitLocked(p *game.CommitPayload) {
	if p == nil || len(p.Snapshots) == 0 {
		return
	}
	if r.recaptureCommits > 0 {
		// 结算后 room 侧会立即做破产重买/离席，game commit 里是处置前的旧筹码，
		// 此时以 game 当前状态重拍，避免把旧筹码盖回客户端。
		r.recaptureCommits--
		r.captureFromGameLocked()
	} else {
		snaps := make([]model.SnapshotPayload, 0, len(p.Snapshots))
		for i := range p.Snapshots {
			snaps = append(snaps, r.toModelSnapshotLocked(i, p.Snapshots[i]))
		}
		r.latestSnapshots = snaps
		r.latestValid = true
	}
	r.nextRevisionLocked()
	r.emitStateLocked(stateReasonMutation)
}

// captureFromGameLocked 从 game 当前状态重拍全座位快照（结算处置后使用）。
func (r *Room) captureFromGameLocked() {
	if r.game == nil {
		r.latestValid = false
		return
	}
	views := r.game.SnapshotAll()
	snaps := make([]model.SnapshotPayload, len(r.seats))
	for i := range r.seats {
		if i < len(views) {
			snaps[i] = r.toModelSnapshotLocked(i, views[i])
		}
	}
	r.latestSnapshots = snaps
	r.latestValid = true
}

// refreshStateLocked 在 room 级变化（准备/离席/重连/回收）后重拍状态并下发新 revision。
func (r *Room) refreshStateLocked() {
	r.captureFromGameLocked()
	r.nextRevisionLocked()
	r.emitStateLocked(stateReasonMutation)
}

// refreshOthersLocked 只把房间级变化发给其他在线座位（新连接自己随后收 join 帧），
// 不清空待发事件/回执，避免新座位的 dealt 私密事件被提前消费。
func (r *Room) refreshOthersLocked(exceptSeat int) {
	r.captureFromGameLocked()
	r.nextRevisionLocked()
	for i := range r.seats {
		if i == exceptSeat || r.seats[i] == nil || r.seats[i].link == nil {
			continue
		}
		r.sendStateLocked(i, stateReasonMutation, nil, nil)
	}
}

// emitStateLocked 把当前 revision 的状态帧发给全部在线座位，并清空待发事件与回执。
func (r *Room) emitStateLocked(reason string) {
	for i := range r.seats {
		occ := r.seats[i]
		if occ == nil || occ.link == nil {
			continue
		}
		evs := make([]model.ExperienceEvent, 0, len(r.pendingEvents))
		for _, pe := range r.pendingEvents {
			if pe.onlySeat >= 0 && pe.onlySeat != i {
				continue
			}
			evs = append(evs, pe.ev)
		}
		r.sendStateLocked(i, reason, evs, r.pendingReceipts[i])
	}
	r.pendingEvents = nil
	clear(r.pendingReceipts)
}

// sendStateToSeatLocked 只给一个座位下发状态帧（join/resync/单条回执）。
func (r *Room) sendStateToSeatLocked(seat int, reason string, events []model.ExperienceEvent, receipts []model.CommandReceipt) {
	if seat < 0 || seat >= len(r.seats) || r.seats[seat] == nil || r.seats[seat].link == nil {
		return
	}
	r.sendStateLocked(seat, reason, events, receipts)
}

// sendStateLocked 构造并发送一个座位视角的 state 帧。
func (r *Room) sendStateLocked(seat int, reason string, events []model.ExperienceEvent, receipts []model.CommandReceipt) {
	st := r.stateForSeatLocked(seat)
	st.Seq = r.seq
	if events == nil {
		events = []model.ExperienceEvent{}
	}
	if receipts == nil {
		receipts = []model.CommandReceipt{}
	}
	for i := range receipts {
		if receipts[i].Status == "applied" && receipts[i].AppliedRevision == nil {
			rev := r.revision
			receipts[i].AppliedRevision = &rev
		}
	}
	frame := model.StateFrame{
		ProtocolVersion: 2,
		RoomCode:        r.code,
		RoomInstanceID:  r.id,
		Revision:        r.revision,
		ServerNow:       time.Now().UnixMilli(),
		Reason:          reason,
		State:           st,
		Events:          events,
		Receipts:        receipts,
	}
	r.sendLocked(seat, model.TypeState, frame)
}

// stateForSeatLocked 取某座位视角的权威状态：优先使用事务快照，无快照时实时构造。
func (r *Room) stateForSeatLocked(seat int) model.SnapshotPayload {
	if r.latestValid && seat >= 0 && seat < len(r.latestSnapshots) {
		s := r.latestSnapshots[seat]
		r.decorateLocked(seat, &s)
		return s
	}
	return r.snapshotLocked(seat)
}

// decorateLocked 用 room 真源补齐快照中的房间级字段（昵称/准备/连接/生命周期/
// 结算摘要/过程历史），并写入 v2 字段。
func (r *Room) decorateLocked(seat int, s *model.SnapshotPayload) {
	s.RoomCode = r.code
	s.MySeat = seat
	s.ChatEnabled = r.cfg.ChatEnabled
	s.MinRaise = r.gameMinRaise()
	s.TurnMs = r.gameTurnMs()
	if r.handSeedCommit != "" {
		sc := r.handSeedCommit
		s.SeedCommit = &sc
	} else {
		s.SeedCommit = nil
	}
	if r.seedRevealed {
		seed := fmt.Sprintf("%d", r.handSeed)
		s.Seed = &seed
	} else {
		s.Seed = nil
	}
	s.Box = r.boxLocked()
	s.Pool = r.poolInfoLocked()

	for i := range s.Seats {
		if i < len(r.seats) && r.seats[i] != nil {
			o := r.seats[i]
			s.Seats[i].Nick = o.nick
			s.Seats[i].Ready = o.ready
			s.Seats[i].OccupantKind = "human"
			if o.isBot {
				s.Seats[i].OccupantKind = "bot"
				s.Seats[i].Connection = "not_applicable"
			} else if o.link != nil && o.detachedAt.IsZero() {
				s.Seats[i].Connection = "online"
			} else {
				s.Seats[i].Connection = "offline"
			}
			s.Seats[i].PendingLeave = o.pendingLeave
			if r.game != nil {
				s.Seats[i].Rebuys = r.game.Rebuys(i)
			}
		} else {
			s.Seats[i].Nick = ""
			s.Seats[i].OccupantKind = "empty"
			s.Seats[i].Connection = "not_applicable"
			s.Seats[i].PendingLeave = false
		}
	}
	s.RoomInstanceID = r.id
	s.Revision = r.revision
	s.RoomStatus = r.status
	s.NextHandAt = r.nextHandAt
	s.NextHandPolicy = r.cfg.NextHandPolicy
	s.Readiness = r.readinessLocked()
	s.ViewerStatus = "seated"
	s.RemovalReason = nil
	s.Participation = r.participationLocked(seat)
	s.LastResult = r.lastResult
	s.RecentEvents = r.recentEventsCopyLocked()
	humans, bots := r.humanBotCountsLocked()
	s.RoomKind = r.cfg.RoomKind
	s.BotPolicy = r.cfg.BotPolicy
	s.TargetHumanCount = r.cfg.TargetHumanCount
	s.HostSeat = r.hostSeat
	s.IsHost = r.isHostLocked(seat)
	s.HumanCount = humans
	s.BotCount = bots
	s.CanStart, s.StartBlockedReason = r.startStatusLocked()
	if s.LegalActions == nil {
		s.LegalActions = []string{}
	}
	if s.Reveals == nil {
		s.Reveals = []model.RevealRecord{}
	}
}

// gameMinRaise / gameTurnMs 在 game 未就绪时返回零值（decorate 可能早于开局）。
func (r *Room) gameMinRaise() int {
	if r.game == nil {
		return 0
	}
	return r.game.MinRaise()
}

func (r *Room) gameTurnMs() int {
	if r.game == nil {
		return r.turnTimeoutSeconds * 1000
	}
	return r.game.TurnMs()
}

// boxLocked 装配盒名单（game 未就绪时为空）。
func (r *Room) boxLocked() []model.BoxCard {
	out := []model.BoxCard{}
	if r.game == nil {
		return out
	}
	for _, bc := range r.game.Box() {
		out = append(out, model.BoxCard{
			ID: bc.ID, Title: bc.Title, Score: bc.Score, Bucket: bc.Bucket, Year: bc.Year,
		})
	}
	return out
}

// readinessLocked 计算本次开局阻塞项（排除 bot/空座/局内离座者）。
func (r *Room) readinessLocked() model.Readiness {
	out := model.Readiness{
		EligibleSeats: []int{},
		ReadySeats:    []int{},
		Blockers:      []model.ReadyBlocker{},
	}
	for i, o := range r.seats {
		if o == nil || o.isBot || o.pendingLeave {
			continue
		}
		out.EligibleSeats = append(out.EligibleSeats, i)
		if o.ready {
			out.ReadySeats = append(out.ReadySeats, i)
			continue
		}
		reason := "unready"
		if o.link == nil {
			reason = "offline"
		}
		out.Blockers = append(out.Blockers, model.ReadyBlocker{Seat: i, Reason: reason})
	}
	return out
}

// participationLocked 给出接收者本手的参局状态。
func (r *Room) participationLocked(seat int) string {
	if r.status != model.StatusPlaying {
		return "not_started"
	}
	if seat >= 0 && seat < len(r.seats) && r.seats[seat] != nil {
		if r.game != nil {
			for _, ss := range r.game.SnapshotFor(seat).Seats {
				if ss.Seat == seat && ss.InHand {
					return "in_hand"
				}
			}
		}
	}
	return "waiting_next_hand"
}

// recentEventsCopyLocked 返回过程历史副本。
func (r *Room) recentEventsCopyLocked() []model.ExperienceEvent {
	out := make([]model.ExperienceEvent, len(r.recentEvents))
	copy(out, r.recentEvents)
	return out
}

// recordGameEventLocked 把一条 game 事件转成 v2 过程事件并暂存（不改变权威状态）。
func (r *Room) recordGameEventLocked(ev game.Event) {
	if ev.Type == game.EventCommit {
		return
	}
	payload := map[string]any{}
	if ev.Payload != nil {
		raw, err := json.Marshal(ev.Payload)
		if err == nil {
			_ = json.Unmarshal(raw, &payload)
		}
	}
	r.eventSeq++
	ee := model.ExperienceEvent{
		EventID:    fmt.Sprintf("%s-%d-%d", r.id, r.handSeq, r.eventSeq),
		HandSeq:    r.handSeq,
		Phase:      r.currentPhaseLocked(),
		Kind:       ev.Type,
		OccurredAt: time.Now().UnixMilli(),
		Payload:    payload,
	}
	if seat, ok := payload["seat"].(float64); ok {
		s := int(seat)
		ee.Seat = &s
	}
	only := -1
	switch ev.Type {
	case model.TypeDealt:
		if ee.Seat != nil {
			only = *ee.Seat
		}
	case model.TypeRevealed:
		if scope, _ := payload["scope"].(string); scope == model.ScopePrivate && ee.Seat != nil {
			only = *ee.Seat
		}
	}
	r.pendingEvents = append(r.pendingEvents, pendingEvent{ev: ee, onlySeat: only})
	// 私密事件（自己发到的底牌、private 揭示）只随本座位帧下发，绝不进共享历史：
	// recentEvents 会原样发给每个座位，带 cards/elements 的载荷进历史即等于公开底牌。
	if only < 0 {
		r.recentEvents = append(r.recentEvents, ee)
		if len(r.recentEvents) > recentEventLimit {
			r.recentEvents = r.recentEvents[len(r.recentEvents)-recentEventLimit:]
		}
	}
}

// currentPhaseLocked 取当前阶段（waiting 快照用）。
func (r *Room) currentPhaseLocked() string {
	if r.game == nil {
		return model.PhaseWaiting
	}
	return string(r.game.SnapshotFor(0).Phase)
}

// ===== 命令确认（requestId 去重、expected 校验、回执）=====

// lookupReceiptLocked 查命令回执缓存（同一 requestId 重试不重复执行）。
func (r *Room) lookupReceiptLocked(seat int, requestID string) (model.CommandReceipt, bool) {
	if requestID == "" {
		return model.CommandReceipt{}, false
	}
	m := r.receipts[seat]
	if m == nil {
		return model.CommandReceipt{}, false
	}
	rc, ok := m[requestID]
	return rc, ok
}

// rememberReceiptLocked 记录命令回执（每座位保留有限条）。
func (r *Room) rememberReceiptLocked(seat int, rc model.CommandReceipt) {
	if rc.RequestID == "" {
		return
	}
	m := r.receipts[seat]
	if m == nil {
		m = make(map[string]model.CommandReceipt)
		r.receipts[seat] = m
	}
	if len(m) >= receiptCacheLimit {
		clear(m) // 超窗口直接清空：旧回执重放会被当作新命令（可接受）
	}
	m[rc.RequestID] = rc
}

// validateMetaLocked 校验 v2 命令元数据（房间实例/手序/可见版本）。
func (r *Room) validateMetaLocked(meta model.CommandMeta) error {
	if meta.RoomInstanceID != "" && meta.RoomInstanceID != r.id {
		return errStaleState
	}
	if meta.ExpectedHandSeq != 0 && meta.ExpectedHandSeq != r.handSeq {
		return errStaleState
	}
	if meta.ExpectedRevision != 0 && meta.ExpectedRevision != r.revision {
		return errStaleState
	}
	return nil
}

// rejectCommandLocked 回执一条被拒绝的命令：error 消息 + rejected receipt（同一 revision）。
func (r *Room) rejectCommandLocked(seat int, requestID, code, msg string) {
	r.sendErrorLocked(seat, code, msg)
	if requestID == "" {
		return
	}
	c := code
	rc := model.CommandReceipt{RequestID: requestID, Status: "rejected", Code: &c}
	r.rememberReceiptLocked(seat, rc)
	r.sendStateToSeatLocked(seat, stateReasonMutation, nil, []model.CommandReceipt{rc})
}

// replayReceiptLocked 重放一条已缓存的回执（幂等重试）。
func (r *Room) replayReceiptLocked(seat int, rc model.CommandReceipt) {
	r.sendStateToSeatLocked(seat, stateReasonMutation, nil, []model.CommandReceipt{rc})
}

// queueAppliedReceiptLocked 把 applied 回执挂到下一次状态帧（commit 帧带 appliedRevision）。
func (r *Room) queueAppliedReceiptLocked(seat int, requestID string) {
	if requestID == "" {
		return
	}
	rc := model.CommandReceipt{RequestID: requestID, Status: "applied"}
	r.rememberReceiptLocked(seat, rc)
	r.pendingReceipts[seat] = append(r.pendingReceipts[seat], rc)
}

var errStaleState = fmt.Errorf("stale_state: 房间状态已更新，请按最新状态重试")

// logStateErr 记录状态帧构造异常（不打断牌局）。
func logStateErr(roomCode string, err error) {
	if err != nil {
		slog.Warn("状态帧构造失败", "room", roomCode, "err", err)
	}
}

// Package api 是传输网关：REST 管理面（§4.4）+ WebSocket 对局面（/ws，§5），
// 消息编解码与信封对齐 internal/model。隐藏数据纪律（D7）：本包不查询未揭示要素，
// 只透传 game 已按视角裁剪的载荷。
package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"

	"anitexas/backend/internal/config"
	"anitexas/backend/internal/model"
	"anitexas/backend/internal/room"
	"anitexas/backend/internal/store"
)

// Deps 是网关依赖（cmd/server 装配）。
type Deps struct {
	Cfg     *config.Config
	Rooms   *room.Manager
	Store   *store.Store
	Tickets *TicketStore
}

// NewRouter 装配 chi 路由：REST + /ws + CORS。
func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(d.cors)

	r.Get("/api/health", d.handleHealth)
	r.Post("/api/rooms", d.handleCreateRoom)
	r.Get("/api/rooms", d.handleListRooms)
	r.Get("/api/rooms/{code}", d.handlePreviewRoom)
	r.Post("/api/rooms/{code}/join", d.handleJoinRoom)
	r.Get("/api/cards/{id}", d.handleGetCard)

	r.Get("/ws", d.handleWS)
	return r
}

// ===== REST DTO =====

// createRoomReq 是建房参数（可选字段缺省回 ROOM_DEFAULT_*）。
type createRoomReq struct {
	Nick string `json:"nick"`
	// CreateRequestID 是建房幂等键：同 id 重复提交返回同一房间（防双击建两桌）。
	CreateRequestID string             `json:"createRequestId"`
	AutoReveal      *bool              `json:"autoReveal"` // D14：true = 开局全揭示
	Seats           *int               `json:"seats"`
	SmallBlind      *int               `json:"smallBlind"`
	BigBlind        *int               `json:"bigBlind"`
	Chips           *int               `json:"chips"`
	RevealRate      *int               `json:"revealRate"`
	DeckStrategy    *string            `json:"deckStrategy"`
	DeckSize        *int               `json:"deckSize"`
	MinVotes        *int               `json:"minVotes"`    // 作品标注数下限（评分人数；0=不过滤）
	ChatEnabled     *bool              `json:"chatEnabled"` // 房主聊天开关（缺省 true）
	ThemeFilter     *model.ThemeFilter `json:"themeFilter"` // deckStrategy=theme 时携带
	// ===== 第二轮房间策略 =====
	RoomKind         *string `json:"roomKind"`         // friend | practice
	BotPolicy        *string `json:"botPolicy"`        // off | fill
	TargetHumanCount *int    `json:"targetHumanCount"` // 期望参局人数
	NextHandPolicy   *string `json:"nextHandPolicy"`   // manual | automatic
}

// roomDTO 是房间对外形态（建房响应与列表条目同形）。
type roomDTO struct {
	Code       string `json:"code"`
	Host       string `json:"host"`
	AutoReveal bool   `json:"autoReveal"` // D14：true = 开局全揭示
	Seats      int    `json:"seats"`
	SmallBlind int    `json:"smallBlind"`
	BigBlind   int    `json:"bigBlind"`
	RevealRate int    `json:"revealRate"`
	Players    int    `json:"players"`
	Status     string `json:"status"`
	// ===== v2 预览扩展（加入确认页）=====
	Phase      string `json:"phase"`
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

// joinRoomReq 是入座参数（v2：凭 resumeToken 恢复身份、joinRequestId 幂等）。
type joinRoomReq struct {
	Nick           string `json:"nick"`
	ResumeToken    string `json:"resumeToken"`
	JoinRequestID  string `json:"joinRequestId"`
	RoomInstanceID string `json:"roomInstanceId"`
}

// joinRoomResp 是入座响应：ticket 供 WS join 握手（一次性，D9）。
type joinRoomResp struct {
	Ticket         string  `json:"ticket"`
	Seat           int     `json:"seat"`
	Room           roomDTO `json:"room"`
	ParticipantID  string  `json:"participantId"`
	ResumeToken    string  `json:"resumeToken"`
	RoomInstanceID string  `json:"roomInstanceId"`
}

// ===== REST handlers =====

// handleHealth 健康检查（GET /api/health）。
func (d Deps) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleCreateRoom 建房（POST /api/rooms）：配置覆盖 ROOM_DEFAULT_* 后校验，返回房间码。
func (d Deps) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	var req createRoomReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "请求体不是合法 JSON")
		return
	}
	cfg := d.Cfg.RoomDefaults // 逐字段覆盖，缺省即 ROOM_DEFAULT_*
	if req.AutoReveal != nil {
		cfg.AutoReveal = *req.AutoReveal
	}
	if req.Seats != nil {
		cfg.Seats = *req.Seats
	}
	if req.SmallBlind != nil {
		cfg.SmallBlind = *req.SmallBlind
	}
	if req.BigBlind != nil {
		cfg.BigBlind = *req.BigBlind
	}
	if req.Chips != nil {
		cfg.Chips = *req.Chips
	}
	if req.RevealRate != nil {
		cfg.RevealRate = *req.RevealRate
	}
	if req.DeckStrategy != nil {
		cfg.DeckStrategy = strings.ToLower(*req.DeckStrategy)
	}
	if req.DeckSize != nil {
		cfg.DeckSize = *req.DeckSize
	}
	if req.MinVotes != nil {
		cfg.MinVotes = *req.MinVotes
	}
	if req.ChatEnabled != nil {
		cfg.ChatEnabled = *req.ChatEnabled
	}
	if req.ThemeFilter != nil {
		cfg.ThemeFilter = req.ThemeFilter
	}
	if req.RoomKind != nil {
		cfg.RoomKind = strings.ToLower(*req.RoomKind)
	}
	if req.BotPolicy != nil {
		cfg.BotPolicy = strings.ToLower(*req.BotPolicy)
	}
	if req.TargetHumanCount != nil {
		cfg.TargetHumanCount = *req.TargetHumanCount
	}
	if req.NextHandPolicy != nil {
		cfg.NextHandPolicy = strings.ToLower(*req.NextHandPolicy)
	}
	cfg = model.NormalizeRoomConfig(cfg)
	if err := config.ValidateRoomDefaults(cfg); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_config", err.Error())
		return
	}
	host := strings.TrimSpace(req.Nick)
	if host == "" {
		host = "牌手"
	}
	room, err := d.Rooms.CreateRoomIdempotent(cfg, host, req.CreateRequestID)
	if err != nil {
		slog.Error("建房失败", "err", err)
		writeErr(w, http.StatusInternalServerError, "create_failed", "建房失败")
		return
	}
	writeJSON(w, http.StatusCreated, toRoomDTO(room))
}

// handlePreviewRoom 加入前预览（GET /api/rooms/{code}）：只读房间概要，不发 ticket。
func (d Deps) handlePreviewRoom(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(chi.URLParam(r, "code"))
	rm, ok := d.Rooms.Get(code)
	if !ok {
		writeErr(w, http.StatusNotFound, "room_not_found", "房间不存在或已解散")
		return
	}
	writeJSON(w, http.StatusOK, toRoomDTO(rm))
}

// handleListRooms 房间列表（GET /api/rooms）。
func (d Deps) handleListRooms(w http.ResponseWriter, r *http.Request) {
	summaries := d.Rooms.List()
	rooms := make([]roomDTO, 0, len(summaries))
	for _, s := range summaries {
		rooms = append(rooms, summaryToDTO(s, d.Cfg.RoomDefaults.RevealRate))
	}
	writeJSON(w, http.StatusOK, map[string]any{"rooms": rooms})
}

// handleJoinRoom 入座（POST /api/rooms/{code}/join）：占座 + 签发 WS ticket。
// 同昵称重复入座 = 断线重连复用原座位（A4.3）。
func (d Deps) handleJoinRoom(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(chi.URLParam(r, "code"))
	rm, ok := d.Rooms.Get(code)
	if !ok {
		writeErr(w, http.StatusNotFound, "room_not_found", "房间不存在或已解散")
		return
	}
	var req joinRoomReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "请求体不是合法 JSON")
		return
	}
	nick := strings.TrimSpace(req.Nick)
	if nick == "" {
		writeErr(w, http.StatusBadRequest, "bad_nick", "昵称不可为空")
		return
	}
	if len([]rune(nick)) > 12 {
		writeErr(w, http.StatusBadRequest, "bad_nick", "昵称最长 12 字")
		return
	}
	seat, participantID, resumeToken, err := rm.JoinIdentity(nick, req.ResumeToken, req.JoinRequestID, req.RoomInstanceID)
	if err != nil {
		status := http.StatusConflict
		codeName := "join_failed"
		switch err {
		case room.ErrRoomClosed:
			status = http.StatusGone
			codeName = "room_closed"
		case room.ErrNickTaken:
			status = http.StatusConflict
			codeName = "nick_taken"
		case room.ErrRoomFull:
			status = http.StatusConflict
			codeName = "room_full"
		}
		writeErr(w, status, codeName, err.Error())
		return
	}
	ticket := d.Tickets.Issue(code, seat, nick)
	writeJSON(w, http.StatusOK, joinRoomResp{
		Ticket:         ticket,
		Seat:           seat,
		Room:           toRoomDTO(rm),
		ParticipantID:  participantID,
		ResumeToken:    resumeToken,
		RoomInstanceID: rm.ID(),
	})
}

// handleGetCard 牌面 L1 信息（GET /api/cards/{id}）：永不包含隐藏要素（D7）。
func (d Deps) handleGetCard(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "牌 id 不是整数")
		return
	}
	c, err := d.Store.GetCard(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "card_not_found", "牌不存在")
		return
	}
	// L1 裁剪：Elements 留空 + omitempty = 字段根本不出现在响应里（D7 不下发）。
	writeJSON(w, http.StatusOK, model.CardData{
		ID: c.ID, Title: c.Title, Score: c.Score,
		Bucket: c.Bucket, Year: c.Year, Monogram: c.Monogram,
	})
}

// ===== helpers =====

// toRoomDTO 汇总房间对外形态。
func toRoomDTO(rm *room.Room) roomDTO {
	s := rm.Summary()
	return summaryToDTO(s, rm.Config().RevealRate)
}

// summaryToDTO 从大厅条目组装对外形态。
func summaryToDTO(s room.Summary, revealRate int) roomDTO {
	return roomDTO{
		Code: s.Code, Host: s.Host, AutoReveal: s.AutoReveal, Seats: s.Seats,
		SmallBlind: s.SmallBlind, BigBlind: s.BigBlind,
		RevealRate: revealRate, Players: s.Players, Status: s.Status,
		Phase: s.Phase, HandSeq: s.HandSeq, HumanCount: s.HumanCount,
		BotCount: s.BotCount, Joinable: s.Joinable,
		RoomKind: s.RoomKind, BotPolicy: s.BotPolicy,
		TargetHumanCount: s.TargetHumanCount, NextHandPolicy: s.NextHandPolicy,
		HostSeat: s.HostSeat,
	}
}

// writeJSON 写 JSON 响应。
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Warn("写响应失败", "err", err)
	}
}

// writeErr 写错误响应（{code,msg}，与 WS error 载荷同形，不回显隐藏数据，D7）。
func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, model.ErrorPayload{Code: code, Msg: msg})
}

// cors 注入跨域头。CORS_ALLOWED_ORIGINS 为空 = 同源部署（nginx 同域反代）不发 CORS 头；
// 非空则只放行列出的来源。WS 升级同源校验见 ws.go checkOrigin。
func (d Deps) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && d.originAllowed(origin, r.Host) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// originAllowed 判断来源是否放行：列出的来源精确匹配；未配置时放行同源（与请求 Host 一致）。
func (d Deps) originAllowed(origin, reqHost string) bool {
	if len(d.Cfg.CORSOrigins) > 0 {
		for _, o := range d.Cfg.CORSOrigins {
			if o == origin {
				return true
			}
		}
		return false
	}
	return strings.EqualFold(originHost(origin), reqHost)
}

// originHost 取 Origin 头里的 host 部分（粗粒度同源判断，WS 升级另有完整校验）。
func originHost(origin string) string {
	// Origin 形如 scheme://host[:port]
	if i := strings.Index(origin, "://"); i >= 0 {
		origin = origin[i+3:]
	}
	if i := strings.IndexByte(origin, '/'); i >= 0 {
		origin = origin[:i]
	}
	return origin
}

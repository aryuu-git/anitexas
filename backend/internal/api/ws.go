package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"anitexas/backend/internal/model"
	"anitexas/backend/internal/room"
)

// writeTimeout 是单条下行消息的写超时（每连接 write deadline）。
// 写不动即断开：Send 侧同为满缓冲断开的慢消费者策略，断开后重连走全量快照恢复（A4.3）。
const writeTimeout = 10 * time.Second

// wsClient 是一个 WS 连接：读泵（上行分发）+ 写泵（下行投递，非阻塞）。
type wsClient struct {
	conn *websocket.Conn
	send chan []byte
	kill chan struct{}
	once sync.Once

	room *room.Room
	seat int
	nick string
	// ticket 是本连接核销占用的入场券（防顶号）；连接断开经 TicketStore.Release 释放，
	// 原客户端 TTL 内可重连核销（A4.3）。
	ticket string
}

// Send 实现 room.Link：非阻塞投递。写缓冲打满视为慢消费者，直接断开
// ——重连走快照恢复（A4.3），比拖住整桌可靠。
func (c *wsClient) Send(msg []byte) {
	select {
	case c.send <- msg:
	default:
		c.close()
	}
}

// close 关闭连接（幂等）。
func (c *wsClient) close() {
	c.once.Do(func() {
		close(c.kill)
		_ = c.conn.Close()
	})
}

// writePump 写泵：串行写全部下行消息。
func (c *wsClient) writePump() {
	defer c.close()
	for {
		select {
		case <-c.kill:
			return
		case msg := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		}
	}
}

// handleWS 是 /ws 网关（§5）：升级 -> join 握手（ticket 校验）-> 事件分发。
// 断线重连 = 重新握手，Attach 直发全量快照恢复（A4.3）。
func (d Deps) handleWS(w http.ResponseWriter, r *http.Request) {
	up := websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			return origin == "" || d.originAllowed(origin, r.Host)
		},
	}
	conn, err := up.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade 已写错误响应
	}
	c := &wsClient{
		conn: conn,
		send: make(chan []byte, 64),
		kill: make(chan struct{}),
		seat: -1,
	}
	go c.writePump()
	defer func() {
		if c.room != nil {
			c.room.DetachLink(c.seat, c) // 连接代际保护：旧连接关闭不踢掉新连接
		}
		if c.ticket != "" {
			d.Tickets.Release(c.ticket) // 断开释放券占用：TTL 内可重连核销（防顶号兼顾重连）
		}
		c.close()
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return // 对端断开/出错：上面 defer 负责收尾
		}
		env, err := model.DecodeEnvelope(data)
		if err != nil {
			c.sendPreJoinError("bad_envelope", "不是合法的消息信封")
			continue
		}
		if c.room == nil {
			if env.T != model.TypeJoin {
				c.sendPreJoinError("need_join", "请先发送 join 握手")
				continue
			}
			if err := d.handleJoin(c, env); err != nil {
				code := "join_failed"
				if errors.Is(err, ErrTicketInUse) {
					code = model.CodeTicketInUse // 防顶号：原连接活跃期间同 ticket 不可再核销
				}
				c.sendPreJoinError(code, err.Error())
				return // 握手失败即断开（一次性 ticket 纪律）
			}
			continue
		}
		d.dispatch(c, env)
	}
}

// handleJoin 处理 join 握手：ticket 核销（绑定 roomCode/nick/seat）+ 挂接 + 快照。
func (d Deps) handleJoin(c *wsClient, env model.Envelope) error {
	var p model.JoinPayload
	if err := env.Decode(&p); err != nil {
		return err
	}
	seat, err := d.Tickets.Consume(p.Ticket, p.RoomCode, p.Nick)
	if err != nil {
		return err
	}
	c.ticket = p.Ticket // 核销即绑定本连接（防顶号；断开时 Release）
	rm, ok := d.Rooms.Get(p.RoomCode)
	if !ok {
		d.Tickets.Release(p.Ticket) // 握手未完成即释放，允许 TTL 内重试
		return room.ErrRoomClosed
	}
	if err := rm.Attach(seat, c); err != nil {
		d.Tickets.Release(p.Ticket)
		return err
	}
	c.room = rm
	c.seat = seat
	c.nick = p.Nick
	slog.Info("WS 入座", "room", p.RoomCode, "seat", seat, "nick", p.Nick)
	return nil
}

// dispatch 分发上行消息（join 之后）。
func (d Deps) dispatch(c *wsClient, env model.Envelope) {
	switch env.T {
	case model.TypeReady:
		var p model.ReadyPayload
		if err := env.Decode(&p); err != nil {
			c.room.SendError(c.seat, "bad_ready", "ready 载荷不合法")
			return
		}
		if err := c.room.ReadyWithMeta(c.seat, p.CommandMeta); err != nil {
			// 拒绝回执由 room 内部发（带 requestId 时附 rejected receipt）；
			// 座位已释放等无回执路径必须兜底回错，否则客户端 pending 永久挂起。
			if errors.Is(err, room.ErrBadSeat) {
				c.room.SendError(c.seat, "bad_seat", err.Error())
			}
			return
		}

	case model.TypeCancelReady:
		var p model.CancelReadyPayload
		if err := env.Decode(&p); err != nil {
			c.room.SendError(c.seat, "bad_cancel_ready", "cancelReady 载荷不合法")
			return
		}
		_ = c.room.CancelReadyWithMeta(c.seat, p.CommandMeta)

	case model.TypeStart:
		var p model.StartPayload
		if err := env.Decode(&p); err != nil {
			c.room.SendError(c.seat, "bad_start", "start 载荷不合法")
			return
		}
		_ = c.room.StartGame(c.seat, p)

	case model.TypeAddBot:
		var p model.AddBotPayload
		if err := env.Decode(&p); err != nil {
			c.room.SendError(c.seat, "bad_add_bot", "addBot 载荷不合法")
			return
		}
		_ = c.room.AddBot(c.seat, p)

	case model.TypeRemoveBot:
		var p model.RemoveBotPayload
		if err := env.Decode(&p); err != nil {
			c.room.SendError(c.seat, "bad_remove_bot", "removeBot 载荷不合法")
			return
		}
		_ = c.room.RemoveBot(c.seat, p)

	case model.TypeSetTarget:
		var p model.SetTargetPayload
		if err := env.Decode(&p); err != nil {
			c.room.SendError(c.seat, "bad_set_target", "setTarget 载荷不合法")
			return
		}
		_ = c.room.SetTarget(c.seat, p)

	case model.TypeNextPolicy:
		var p model.NextPolicyPayload
		if err := env.Decode(&p); err != nil {
			c.room.SendError(c.seat, "bad_next_policy", "nextHandPolicy 载荷不合法")
			return
		}
		_ = c.room.SetNextHandPolicy(c.seat, p)

	case model.TypeAction:
		var p model.ActionPayload
		if err := env.Decode(&p); err != nil {
			c.room.SendError(c.seat, "bad_action", "action 载荷不合法")
			return
		}
		// 非法动作的 error 回执由 room 内部发（seq 与事件同源）。
		_ = c.room.Action(c.seat, p)

	case model.TypeReveal:
		var p model.RevealPayload
		if err := env.Decode(&p); err != nil {
			c.room.SendError(c.seat, "bad_reveal", "reveal 载荷不合法")
			return
		}
		_, _ = c.room.Reveal(c.seat, p)

	case model.TypeLeave:
		var p model.LeavePayload
		if err := env.Decode(&p); err != nil {
			c.room.SendError(c.seat, "bad_leave", "leave 载荷不合法")
			return
		}
		if err := c.room.LeaveWithMeta(c.seat, p.CommandMeta); err != nil {
			// 拒绝回执由 room 内部发；ErrBadSeat 无回执路径需兜底。
			if errors.Is(err, room.ErrBadSeat) {
				c.room.SendError(c.seat, "bad_seat", err.Error())
			}
			return
		}
		// 离座后本连接不再持有座位：否则座位被他人接替时，旧连接仍能以该 seat
		// 弃牌/全下/揭示（room 只校验座位非空，不校验连接归属）。后续消息按未握手处理。
		c.seat = -1
		c.room = nil

	case model.TypePing:
		// 心跳保活：WS 层 ping/pong 由协议栈处理，应用层 ping 不需回执（§5 下行无 pong）。

	case model.TypeResync:
		// 快照修复（A4.3）：断线重连或客户端状态漂移时补全量；v2 可带待核对 requestId。
		var p model.ResyncPayload
		_ = env.Decode(&p)
		c.room.ResyncWithMeta(c.seat, p.RequestID)

	case model.TypeEmote:
		// 表情（D15）：key 白名单 + 10 秒/座位冷却由 room 校验，成功即全桌广播 emoted。
		var p model.EmotePayload
		if err := env.Decode(&p); err != nil {
			c.room.SendError(c.seat, "bad_emote", "emote 载荷不合法")
			return
		}
		if err := c.room.Emote(c.seat, p.Key); err != nil {
			c.room.SendError(c.seat, "emote_failed", err.Error())
		}

	case model.TypeSay:
		// 聊天（frontend-contract §1，与 emote 同构）：chatEnabled / 长度 / 节流由 room 校验，
		// 成功即全桌广播 said；失败回 chat_disabled / chat_too_long。
		var p model.SayPayload
		if err := env.Decode(&p); err != nil {
			c.room.SendError(c.seat, "bad_say", "say 载荷不合法")
			return
		}
		if err := c.room.Say(c.seat, p.Text); err != nil {
			code := "say_failed"
			switch err {
			case room.ErrChatDisabled:
				code = model.CodeChatDisabled
			case room.ErrChatTooLong:
				code = model.CodeChatTooLong
			}
			c.room.SendError(c.seat, code, err.Error())
		}

	case model.TypeJoin:
		c.room.SendError(c.seat, "already_joined", "同一连接不重复握手")

	default:
		c.room.SendError(c.seat, "bad_type", "未知消息类型: "+env.T)
	}
}

// sendPreJoinError 握手前的错误回执。seq 固定 1：
// 前端乱序过滤基线从 0 起（≤ 基线即丢），1 必达；成功握手后的消息以 room 的
// 房间级序号（≥1 且 snapshot 恒采纳）继续递增，不会被基线误杀。
func (c *wsClient) sendPreJoinError(code, msg string) {
	env, err := model.NewEnvelope(model.TypeError, 1, model.ErrorPayload{Code: code, Msg: msg})
	if err != nil {
		return
	}
	b, err := json.Marshal(env)
	if err != nil {
		return
	}
	select {
	case c.send <- b:
	default:
	}
}

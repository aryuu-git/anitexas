// Command server 是 AniTexas 游戏服务入口：装配 config -> store -> room -> api，
// 并负责优雅退出（关 WS、停对局、关库）。
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"anitexas/backend/internal/api"
	"anitexas/backend/internal/config"
	"anitexas/backend/internal/room"
	"anitexas/backend/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "anitexas-server:", err)
		os.Exit(1)
	}
}

// run 装配并启动服务，阻塞到 SIGINT/SIGTERM 后优雅退出。
func run() error {
	// 1) 配置：读取 + 启动校验（端口范围/路径非空/枚举合法，坏配置拒绝上线）。
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	setupLogger(cfg.LogLevel)
	slog.Info("配置就绪", "env", cfg.Environment, "listen", cfg.ListenAddr(),
		"db", cfg.DBPath, "cards", cfg.CardsPath)

	// 2) 存储：SQLite（WAL）+ 卡池载入（CARDS_PATH -> cards 表）。
	st, err := store.Open(cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()
	n, err := st.LoadCardsFromJSON(cfg.CardsPath)
	if err != nil {
		return fmt.Errorf("载入卡池: %w", err)
	}
	slog.Info("卡池载入完成", "path", cfg.CardsPath, "count", n)

	// 3) 大厅与房间调度。
	rooms, err := room.NewManager(st, room.ManagerOptions{
		RoomDefaults:       cfg.RoomDefaults,
		TurnTimeoutSeconds: cfg.TurnTimeoutSeconds,
		Bot:                room.DefaultBotParams(),
		Timing: room.Timing{
			NextHandDelay:   time.Duration(cfg.NextHandDelaySeconds) * time.Second,
			DisconnectGrace: time.Duration(cfg.DisconnectGraceSeconds) * time.Second,
			IdleTTL:         time.Duration(cfg.IdleRoomTTLMinutes) * time.Minute,
			MaxRebuys:       cfg.MaxRebuys,
		},
	})
	if err != nil {
		return err
	}

	// 4) HTTP/WS 网关。
	handler := api.NewRouter(api.Deps{
		Cfg:     cfg,
		Rooms:   rooms,
		Store:   st,
		Tickets: api.NewTicketStore(2 * time.Minute),
	})
	srv := &http.Server{
		Addr:              cfg.ListenAddr(),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// 5) 启动 + 优雅退出：SIGINT/SIGTERM -> 停接新连接 -> 关 WS 对局 -> 关库。
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errCh := make(chan error, 1)
	go func() {
		slog.Info("服务已启动", "addr", cfg.ListenAddr())
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		slog.Info("收到退出信号，开始优雅退出")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Warn("HTTP 关闭超时", "err", err)
	}
	rooms.Close() // 停全部对局事件循环（WS 连接随 Shutdown/断开释放，Detach 已摘座位）
	slog.Info("服务已退出")
	return nil
}

// setupLogger 按 LOG_LEVEL 配置 slog。
func setupLogger(level string) {
	var lv slog.Level
	switch strings.ToLower(level) {
	case config.LevelDebug:
		lv = slog.LevelDebug
	case config.LevelWarn:
		lv = slog.LevelWarn
	case config.LevelError:
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: lv})))
}

package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"anitexas/backend/internal/model"
)

// newTestStore 打开一个临时库。
func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "anitexas.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// fixtureCardsJSON 是迷你卡池产物（结构与管线 cards.json 逐字一致）。
const fixtureCardsJSON = `[
 {"id":51,"title":"CLANNAD","score":8.4,"bucket":8.5,"year":2007,"type":"游戏改","monogram":"C","votes":12345,
  "elements":[{"class":1,"value":"石原立也"},{"class":2,"value":"京都动画"},{"class":4,"value":"2007"}]},
 {"id":485,"title":"凉宫春日的忧郁","score":8.2,"bucket":8.0,"year":2006,"type":"轻改","monogram":"凉","votes":6789,
  "elements":[{"class":1,"value":"石原立也"},{"class":3,"value":"SOS团"}]}
]`

// TestCardsLoadAndGet cards 表：启动从 CARDS_PATH 载入 + 读取（要素 JSON 往返）。
func TestCardsLoadAndGet(t *testing.T) {
	s := newTestStore(t)
	path := filepath.Join(t.TempDir(), "cards.json")
	if err := os.WriteFile(path, []byte(fixtureCardsJSON), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	n, err := s.LoadCardsFromJSON(path)
	if err != nil {
		t.Fatalf("LoadCardsFromJSON() error = %v", err)
	}
	if n != 2 {
		t.Fatalf("载入张数 = %d, want 2", n)
	}
	if cnt, _ := s.CountCards(); cnt != 2 {
		t.Errorf("CountCards() = %d, want 2", cnt)
	}

	c, err := s.GetCard(51)
	if err != nil {
		t.Fatalf("GetCard(51) error = %v", err)
	}
	if c.Title != "CLANNAD" || c.Score != 8.4 || c.Bucket != 8.5 || c.Year != 2007 ||
		c.Type != "游戏改" || c.Monogram != "C" || c.Votes != 12345 {
		t.Errorf("GetCard(51) = %+v", c)
	}
	if len(c.Elements) != 3 || c.Elements[0] != (model.Element{Class: 1, Value: "石原立也"}) ||
		c.Elements[2] != (model.Element{Class: 4, Value: "2007"}) {
		t.Errorf("elements 往返失败: %+v", c.Elements)
	}
	if c.UpdatedAt == "" {
		t.Error("UpdatedAt 应在载入时生成")
	}

	// 替换式加载幂等：重跑不重复、不残留。
	if _, err := s.LoadCardsFromJSON(path); err != nil {
		t.Fatalf("二次 LoadCardsFromJSON() error = %v", err)
	}
	if cnt, _ := s.CountCards(); cnt != 2 {
		t.Errorf("重载后 CountCards() = %d, want 2", cnt)
	}

	all, err := s.AllCards()
	if err != nil {
		t.Fatalf("AllCards() error = %v", err)
	}
	if len(all) != 2 || all[0].ID != 51 || all[1].ID != 485 {
		t.Errorf("AllCards() = %+v", all)
	}
	if _, err := s.GetCard(9999); err == nil {
		t.Error("GetCard 不存在的 id 应报错")
	}
}

// TestRoomsCRUD rooms 表：建/查/列/状态更新。
func TestRoomsCRUD(t *testing.T) {
	s := newTestStore(t)
	cfg := model.RoomConfig{AutoReveal: false, Seats: 4, SmallBlind: 1, BigBlind: 2, Chips: 200,
		RevealRate: 0, DeckStrategy: "stratified", DeckSize: 78}
	cfgJSON, _ := json.Marshal(cfg)

	rec := model.RoomRecord{ID: "r-1", Code: "ABCDEF", Config: string(cfgJSON), Status: "waiting", CreatedAt: model.Now()}
	if err := s.CreateRoom(rec); err != nil {
		t.Fatalf("CreateRoom() error = %v", err)
	}
	// code 唯一约束。
	if err := s.CreateRoom(rec); err == nil {
		t.Error("重复房间码应报错")
	}

	got, err := s.GetRoomByCode("ABCDEF")
	if err != nil {
		t.Fatalf("GetRoomByCode() error = %v", err)
	}
	if got.ID != "r-1" || got.Status != "waiting" || got.Config != string(cfgJSON) {
		t.Errorf("GetRoomByCode() = %+v", got)
	}

	list, err := s.ListRooms()
	if err != nil || len(list) != 1 {
		t.Fatalf("ListRooms() = %+v, err=%v", list, err)
	}

	if err := s.UpdateRoomStatus("r-1", "closed"); err != nil {
		t.Fatalf("UpdateRoomStatus() error = %v", err)
	}
	if got, _ := s.GetRoomByCode("ABCDEF"); got.Status != "closed" {
		t.Errorf("状态更新失败: %+v", got)
	}
	if err := s.UpdateRoomStatus("nope", "closed"); err == nil {
		t.Error("更新不存在房间应报错")
	}
}

// TestActionLogReplay hands/actions/reveal_log 三表：动作日志追加式，一手牌可回放重建。
func TestActionLogReplay(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateRoom(model.RoomRecord{ID: "r-1", Code: "ABCDEF", Config: "{}", Status: "playing", CreatedAt: model.Now()}); err != nil {
		t.Fatalf("CreateRoom() error = %v", err)
	}

	handID, err := s.CreateHand(model.HandRecord{
		RoomID: "r-1", Seq: 1,
		Deck: `[{"id":51},{"id":485}]`, Community: "[]",
		StartedAt: model.Now(),
	})
	if err != nil {
		t.Fatalf("CreateHand() error = %v", err)
	}

	// 一手一事务批量提交（动作/揭示攒批 append）：乱序 seq 写入也按 seq 回放。
	actions := []model.ActionRecord{
		{HandID: handID, Seq: 1, Seat: 0, Type: "bet", Amount: 2, At: model.Now()},
		{HandID: handID, Seq: 2, Seat: 1, Type: "call", Amount: 2, At: model.Now()},
		{HandID: handID, Seq: 3, Seat: 2, Type: "fold", Amount: 0, At: model.Now()},
		{HandID: handID, Seq: 4, Seat: 0, Type: "check", Amount: 0, At: model.Now()},
		{HandID: handID, Seq: 6, Seat: 1, Type: "allin", Amount: 100, At: model.Now()},
		{HandID: handID, Seq: 5, Seat: 0, Type: "call", Amount: 100, At: model.Now()},
	}
	reveals := []model.RevealLogRecord{
		{HandID: handID, CardID: 51, Seat: 0, Scope: "private", Cost: 0, At: model.Now()},
		{HandID: handID, CardID: 485, Seat: 1, Scope: "public", Cost: 0, At: model.Now()},
	}
	if err := s.AppendHandLog(handID, actions, reveals); err != nil {
		t.Fatalf("AppendHandLog() error = %v", err)
	}
	// 空批是 no-op（不产生空事务）。
	if err := s.AppendHandLog(handID, nil, nil); err != nil {
		t.Fatalf("AppendHandLog(空批) error = %v", err)
	}

	if err := s.UpdateHandCommunity(handID, `[{"id":51},{"id":485}]`); err != nil {
		t.Fatalf("UpdateHandCommunity() error = %v", err)
	}
	result := `{"rows":[{"seat":0,"chipsDelta":104}]}`
	if err := s.FinishHand(handID, result); err != nil {
		t.Fatalf("FinishHand() error = %v", err)
	}

	// 回放包：deck/公共牌/结果 + 动作按 seq 有序 + 揭示账按落账序。
	log, err := s.ReplayHand(handID)
	if err != nil {
		t.Fatalf("ReplayHand() error = %v", err)
	}
	if log.Hand.Seq != 1 || log.Hand.Deck != `[{"id":51},{"id":485}]` ||
		log.Hand.Community != `[{"id":51},{"id":485}]` || log.Hand.Result != result ||
		log.Hand.EndedAt == "" {
		t.Errorf("回放 hand = %+v", log.Hand)
	}
	if len(log.Actions) != 6 {
		t.Fatalf("动作条数 = %d, want 6", len(log.Actions))
	}
	for i, a := range log.Actions {
		if a.Seq != i+1 {
			t.Errorf("动作应按 seq 有序: idx=%d seq=%d", i, a.Seq)
		}
	}
	if log.Actions[4].Type != "call" || log.Actions[5].Type != "allin" {
		t.Errorf("回放顺序错误: %+v", log.Actions[4:])
	}
	if len(log.Reveals) != 2 || log.Reveals[0].Scope != "private" || log.Reveals[1].CardID != 485 {
		t.Errorf("揭示账 = %+v", log.Reveals)
	}

	hands, err := s.ListHands("r-1")
	if err != nil || len(hands) != 1 || hands[0].ID != handID {
		t.Errorf("ListHands() = %+v, err=%v", hands, err)
	}
	if _, err := s.ReplayHand(9999); err == nil {
		t.Error("不存在的手牌回放应报错")
	}
}

// TestScoresLedger scores 表：双账本 upsert（无则插、有则覆盖）。
func TestScoresLedger(t *testing.T) {
	s := newTestStore(t)
	if err := s.UpsertScore(model.ScoreRecord{RoomID: "r-1", Seat: 0, Chips: 200, Points: 0}); err != nil {
		t.Fatalf("UpsertScore() error = %v", err)
	}
	if err := s.UpsertScore(model.ScoreRecord{RoomID: "r-1", Seat: 1, Chips: 200, Points: 0}); err != nil {
		t.Fatalf("UpsertScore() error = %v", err)
	}
	// 覆盖式更新（结算后以最新账面为准）。
	if err := s.UpsertScore(model.ScoreRecord{RoomID: "r-1", Seat: 0, Chips: 304, Points: 42}); err != nil {
		t.Fatalf("UpsertScore() 更新 error = %v", err)
	}

	sc, err := s.GetScore("r-1", 0)
	if err != nil {
		t.Fatalf("GetScore() error = %v", err)
	}
	if sc.Chips != 304 || sc.Points != 42 || sc.UpdatedAt == "" {
		t.Errorf("GetScore() = %+v", sc)
	}
	all, err := s.ListScores("r-1")
	if err != nil || len(all) != 2 || all[0].Seat != 0 || all[1].Seat != 1 {
		t.Errorf("ListScores() = %+v, err=%v", all, err)
	}
}

// TestReopenPersistence WAL 落盘：关库重开数据仍在（部署重启不丢账）。
func TestReopenPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "anitexas.db")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if err := s.CreateRoom(model.RoomRecord{ID: "r-1", Code: "ABCDEF", Config: "{}", Status: "waiting", CreatedAt: model.Now()}); err != nil {
		t.Fatalf("CreateRoom() error = %v", err)
	}
	if err := s.UpsertScore(model.ScoreRecord{RoomID: "r-1", Seat: 3, Chips: 180, Points: -2}); err != nil {
		t.Fatalf("UpsertScore() error = %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen error = %v", err)
	}
	defer s2.Close()
	if got, err := s2.GetRoomByCode("ABCDEF"); err != nil || got.ID != "r-1" {
		t.Errorf("重开后房间丢失: %+v, err=%v", got, err)
	}
	if sc, err := s2.GetScore("r-1", 3); err != nil || sc.Chips != 180 || sc.Points != -2 {
		t.Errorf("重开后账本丢失: %+v, err=%v", sc, err)
	}
}

# 改造实施报告

基线 HEAD：`2a95351`（docs: 新增体验重构方案与实施交接文档）
本轮完成状态：工作区未提交（T0–T7 代码 + T8 自动化与本文档）
本次变更范围：后端 v2 权威状态帧与命令回执、前端归约/视图模型、首页与加入流程、准备室、对局四区与合法操作区、结算与上手回顾、mock 桌对齐、相关测试。
本地运行步骤与 URL（未在本轮执行真实联调，原因见「未解决问题」）：
- 后端：`cd backend && $env:PORT=8081; go run ./cmd/server`
- 前端：`cd frontend && npm run dev`，地址 `http://localhost:5373/anitexas/`
- 配置项以 `backend/internal/config/config.go` 为准：`PORT`（默认 8081）、`CARDS_PATH`（默认 `data/cards.json`）、`ROOM_DEFAULT_*`、`TURN_TIMEOUT_SECONDS`、`NEXT_HAND_DELAY_SECONDS`、`MAX_REBUYS` 等。

## 任务结果

| ID | 结果 | 文件与说明 |
|---|---|---|
| T0 | 完成 | 以 `state_v2_test.go`、`betting_test.go`、`snapshot_test.go` 锁定开局/换街/结算基线；记录「增量事件拼状态」与「结算摘要必须随帧恢复」两处断点。 |
| T1 | 完成 | `backend/internal/game/{game,events,snapshot,betting,settle}.go`、`room/room.go`、`room/state.go`、`model/ws.go`：v2 `StateFrame`（protocolVersion=2、roomInstanceId、revision、serverNow）、按视角裁剪、结算摘要冻结。 |
| T2 | 完成 | `api/ws.go`、`room/room.go`：命令 requestId/expectedRevision、applied/rejected/unknown 回执、`legalActions/callAmount/minRaiseTo/maxRaiseTo/timeoutAction`、参与状态与准备度。 |
| T3 | 完成 | `api/{router,ticket,ws}.go`、`room/{room,manager}.go`：预览摘要、创建/加入幂等、恢复凭据与原子复核；`JoinIdentity` 同昵称无凭据拒绝。 |
| T4 | 完成 | `frontend/src/api/{types,client,roomState,experienceState,identity,nickname}.ts`、`hooks/useRoomSocket.ts`、`mockDesk.ts`：v2 帧归约、revision/实例门控、pending 核对、纯视图模型；mock 桌最后一手摘要保留到下一手结算。 |
| T5 | 完成 | `pages/LobbyPage.tsx`、`features/lobby/JoinFlow.tsx`、`features/room/RoomWaitingView.tsx`：昵称、预设、统一加入、准备室、复制邀请。 |
| T6 | 完成 | `pages/RoomPage.tsx`、`components/controls/{ActionBar,QuickBet}.tsx`、`features/room/{PhaseProgress,ActionHistory}.tsx`：四区布局、阶段进度、权威状态文案、只按 `legalActions` 渲染的操作区、最近 3 条公开动作、窄屏吸底。 |
| T7 | 完成 | `components/ResultPanel.tsx` + RoomPage：本人筹码/积分净变化与结束原因首屏、`potWins` 合计获奖名单、折叠牌型/账本、准备反馈、自动下一手真实秒数、只读「上手结果」、关闭不发 ready、焦点恢复。 |
| T8 | 部分 | 自动化补齐、报告完成；真实双客户端走查与 11 张截图未执行（本机缺少 `data/cards.json`，真实后端无法启动），详见下文。 |

## 验证证据

| 场景 | 结果 | 命令、日志或截图路径 |
|---|---|---|
| S01 单真人 ready、机器人补齐 | 自动化覆盖 | `TestStateFrameOpening`（开局帧 handSeq/阶段/2 张本人底牌/dealt 事件/座位 occupantKind）；mockDesk「ready 开局」（盲注、底池、turnSeat=3） |
| S02 换街 bet=0、acted 重置、currentBet=0 | 部分覆盖 | `TestBettingLegality`（收轮进 flop、行动权轮转）、`TestMinRaiseUpdatesAndPayload`（换街 minRaise 重置）；未逐字段断言席位 bet=0 |
| S03 一次动作连续 runout + settled | 自动化覆盖 | `TestAllInRunout`（直发 3 条街、单次 showdown/settled、公共牌 5 张）；`TestMinRaiseUpdatesAndPayload`（flop+turn+river 各 1 次） |
| S04 结算后刷新/重连恢复 | 部分覆盖 | `TestStateFrameProgressionAndResult`（结算帧带 lastResult + nextHandAt）；`roomState.test.ts`「lastResult 仅在 showdown/settled 投影」「新一手不残留结算面板」；未跑真实 socket 重连 |
| S05 delayed/duplicate/旧连接 | 自动化覆盖 | `TestCommandMetaRejectsStaleAndDedupes`（stale 拒绝、重放不推进 revision）；`roomState.test.ts`「低 revision 丢弃」「实例变化清空旧私牌/聊天/回执」 |
| S06 A pending 不被 B 事件解除 | 未单独自动化 | 设计上 pending 仅由本人回执/核对结束清除；等待真实双客户端走查验证 |
| S07 回执丢失重复 requestId | 自动化覆盖 | `TestCommandMetaRejectsStaleAndDedupes`（同 requestId 只执行一次，仅重放回执） |
| S08 已下注 10、剩余 90；短全下不重开加注 | 部分覆盖 | `TestMinRaiseUpdatesAndPayload`（短全下不改 minRaise、不可再加注）；`legalActions/maxRaiseTo` 字段有契约但无专项断言 |
| S09 昵称相同/恢复凭据/回收座位 | 部分覆盖 | `TestJoinIdentityNickTakenAndResume` + `api/ticket_test.go`；座位回收后不可恢复未专项覆盖 |
| S10 创建/加入响应丢失同 ID 重试 | 部分覆盖 | `TestJoinIdentityNickTakenAndResume`（同 joinRequestId 复用座位）；建房响应丢失重试未专项覆盖 |
| S11 preview 后座位或 joinMode 改变 | 未自动化 | 需真实 REST 并发复核；本轮未执行 |
| S12 fold_win/平分/多人获奖 | 自动化覆盖 | `game/pot_test.go`（多层边池 potWins）、`settle_test.go`；`ResultPanel.test.tsx`（多人 `winner-row`、不标唯一赢家） |
| S13 私看/弃牌未公开/历史不含隐藏牌 | 自动化覆盖 | `TestHiddenFieldsNotSerialized`、`TestBoxListOmitsHiddenFields`、`TestRevealValidation`；`ActionHistory.test.tsx`（dealt/private revealed 不入历史） |
| S14 手动/自动策略与取消排程 | 自动化覆盖 | `TestNextHandAutoStartAndReadyEarly`；`ResultPanel.test.tsx`（自动秒数、归零文案、手动模式文案） |
| S15 新人未参与本手/重买上限移除 | 自动化覆盖 | `TestRebuyCapExhaustedLeaves`、`TestDisconnectRecyclePlayingMarksPendingLeave`；`experienceState.test.ts`（waitingNextHand/removed 文案） |
| S16 Start/超时/Detach/Close 并发 | 部分覆盖 | `TestA63ConcurrencySoak`、`TestStartFailureNoDeadTableAndRecover`；`go test -race` 本机不可用 |
| 双客户端真实走查 | 未执行 | 本机 `data/cards.json` 缺失，真实后端无法启动；mock 桌仅用于前端自动化，不作为真人联机证据 |
| 视口 1366×768 / 390×844 | 未执行 | 待真实走查时截图确认（代码已改为牌桌横向滚动、操作区窄屏吸底，无整页缩放） |

命令结果：
- `frontend: npm test` → 29 个测试文件、183 个测试全部通过。
- `frontend: npm run build` → `tsc` + `vite build` 成功，产物输出到 `data/dist/`。
- `backend: go test ./...` → `api` / `config` / `engine` / `room` / `store` 通过；`game` 仅 `TestA63Benchmarks` 失败：`read cards.json: open ../../../data/cards.json: The system cannot find the path specified`（性能基准依赖管线产物，非业务逻辑失败）。
- `backend: go test -race ./internal/room ./internal/game ./internal/api` → 未执行成功：`go: -race requires cgo; enable cgo by setting CGO_ENABLED=1`（Windows 工具链无 cgo）。并发验证以 `TestA63ConcurrencySoak` 等非 race 用例替代，不能声称「已通过 race」。

## 协议与行为变更

- 新增 v2 权威状态帧：`state` 下行携带 `protocolVersion=2`、`roomInstanceId`、`revision`、`serverNow`、完整 `state`、过程 `events` 与命令 `receipts`；客户端以帧为唯一真源，旧增量事件仅在未收到 v2 帧时兼容。
- 命令确认：上行可带 `requestId` / `expectedRevision`；回执状态 `applied | rejected | unknown`，重复 requestId 不重复执行；pending 只由本人回执或核对结束解除。
- 操作区唯一依据服务端 `legalActions`；`amount` 语义为「下注到/加注到」的本轮总投入目标；`maxRaiseTo = 本轮已投入 + 剩余筹码`；短码跟注主按钮实际发送 `allin`。
- 结算首屏本人优先；获奖名单按 `potWins` 合计（可多人），牌力排名与筹码获奖分开标注；关闭结果不发 ready，查看「上手结果」为只读投影（`lastResult`），新一手开始时自动收起回顾。
- mock 桌修正：`lastResult` 保留到下一手结算（此前新一手即清空，导致「上手结果」入口缺失）。
- `Button` 修正：`loading` 始终锁住点击（此前显式传 `disabled={false}` 会让 loading 失效）。
- 全下直发阶段进度：四轮统一标记完成并显示「全下发牌」，不再出现「当前街 + 后续已完成」的矛盾顺序。
- 默认预设、规则算法与樱墨视觉未改动；未新增候补、取消准备、暂停参局、房主强制开局按钮。

## 未解决问题

1. 真实双客户端走查未执行。原因：仓库 `data/` 下只有 `dist/`，缺少后端启动所需的 `data/cards.json`；本轮未生成/覆盖用户数据。影响：S06、S11、S09 部分分支及 1366×768 / 390×844 视口尚未获得真人证据。下一步：由用户提供卡池产物或允许从既有管线生成后，按交付计划第 4 节用两个独立浏览器上下文走查并补 11 张截图。
2. `go test ./...` 中 `TestA63Benchmarks` 因缺少 `data/cards.json` 失败；其余包通过。
3. `go test -race` 在 Windows 无 cgo 环境不可用，仅以既有并发用例替代，不能视为 race 已验证。
4. 服务端 `recentEvents` 目前不包含 `readied` 类型（前端历史白名单可显示但服务端未广播），准备动作只体现在座位 `ready` 状态与准备度摘要中。

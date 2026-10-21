# 状态与协议实施契约（拟新增 v2）

本文中的 v2 类型、接口与字段是实施目标，当前代码尚未具备。命名可以随项目惯例统一调整，语义和验收不变量不能各自解释。现有 wire 类型位置是 `backend/internal/model/ws.go`，不是 protocol.go。

## 1. 选定方案：权威状态帧 + 过程事件

每次可见的游戏/房间状态事务结束后，发一帧针对接收者裁剪的完整状态；同帧可带过程事件。前端以 state 替换权威数据，events 仅用于文字历史、音效和动画，不再增减筹码或推算阶段。

取舍：本项目最多 9 座，首先降低双端归约和恢复复杂度，接受状态帧比当前增量大。box 等大字段可在确认性能问题后做带版本缓存；首版不得为了优化使刷新无法恢复。不能每秒广播完整帧，倒计时由绝对截止时间本地计算。

```ts
// SnapshotV2 保留现有 SnapshotPayload 的业务字段，扩展如下。
interface StateFrame {
  t: 'state'
  protocolVersion: 2
  roomCode: string
  roomInstanceId: string       // 每次创建房间的唯一标识，重建同码也不同
  revision: number             // 房间状态版本；不是每位接收者的发送序号
  serverNow: number            // epoch ms
  reason: 'join' | 'resync' | 'mutation'
  state: SnapshotV2            // 必须是此 revision 对应的完整、按视角裁剪状态
  events: ExperienceEvent[]    // 同事务按发生顺序；恢复帧为 []，不重播旧动画
  receipts: CommandReceipt[]   // 只给命令所属玩家
}

interface SnapshotV2 /* extends existing SnapshotPayload */ {
  // 既有的 roomCode/phase/handSeq/seats/mySeat/myCards/community/pot 等全部保留
  roomStatus: 'waiting' | 'playing' | 'closed'
  nextHandAt: number | null
  nextHandPolicy: 'manual' | 'automatic' // 反映实际全局配置，不是新建房选项
  readiness: {
    eligibleSeats: number[]    // 阻塞本次开局的真人，由房间层按现规则计算
    readySeats: number[]
    blockers: { seat: number; reason: 'unready' | 'offline' }[]
  }
  viewerStatus: 'seated' | 'removed'
  removalReason: 'left' | 'rebuy_limit' | 'expired' | null
  participation: 'in_hand' | 'waiting_next_hand' | 'not_started'
  legalActions: ActionType[]  // 服务端据 canRaise 等规则给出；非本人行动时 []
  callAmount: number          // 跟齐所需增量，可大于剩余筹码
  minRaiseTo: number | null
  maxRaiseTo: number          // 本轮已下注 + 剩余筹码
  timeoutAction: 'check' | 'fold' | null
  runout: boolean
  lastResult: HandResult | null
  recentEvents: ExperienceEvent[] // 有限历史，按视角过滤；用于刷新恢复文字记录
}
```

补充 seats 字段：`occupantKind: 'empty'|'human'|'bot'`、`connection: 'online'|'offline'|'not_applicable'`、`inHand`、`allIn`、`pendingLeave`。不由前端根据 nick 前缀识别机器人，不根据 chips=0 在所有阶段推算全下。mySeat 对已移除玩家为 -1，UI 显示离席说明而不是永久灰掉的下注栏。

`HandResult`：handSeq、endedAt、endReason（showdown/fold_win）、冻结的参与者 ID/座位/昵称、rows、potWins、规则允许公开的 showdown。昵称与座位在结算时冻结，下一手换人不能使上手获奖者名称变化。最近一手可放内存，进程重启/房间重建后可为空；这不是持久战绩。

`ExperienceEvent`：eventId、handSeq、phase、kind、seat（可空）、occurredAt、结构化 payload。kind 首版限 hand_started/blind_posted/acted/street_opened/showdown/settled/readied/seat_changed/rebuy/next_hand_scheduled/next_hand_cancelled/revealed。acted 带 type、amount（增量）、target（当时本轮总投入）、actor（human/bot/timeout/disconnected）。无需猜测“谁在第几次行动”。隐藏私看事件只能发本人，不能仅把 elements 去掉后广播其存在。

数值字段必须零值可表达：deadline/nextHandAt 等使用明确 null；Go 侧避免 omitempty 使“清除截止时间”变成“未更新”。state 中不混用“缺省沿用旧值”。

## 2. 事务与顺序：必须满足的实现结构

当前 game 在独立 goroutine 处理动作并向 room 发事件；room 也持有 mutex 与定时器。不能在异步 room 消费旧事件时读最新 game 快照，然后把两者当同一时刻。

推荐落点：将 game 每次命令和超时产生的 events 归成不可变 GameUpdate，**在同一次 game 锁保护下捕获对应状态投影**，再发给 room；room 顺序消费 update，叠加准备/连接/排程等房间状态，生成按接收者裁剪的 StateFrame。gameUpdate 携带单调 gameRevision；room 为最终可见事务分配 room revision。

应优先保留现有 game 执行模型，增加事务输出与 room 有序处理；若实现者选择将房间变更集中到 actor 队列，必须说明改动范围和锁迁移，不顺带重写规则引擎。

约束：

1. Start 的开局 state、盲注、底牌、turnSeat、deadline、手数作为同一逻辑提交；commit hash 在任何底牌可见之前发送，沿用发牌固证要求。
2. 一次 action 可能引发换街、连续全下发牌、摊牌和结算。state 是该事务最终状态，events 是同事务过程。不能为播放动画伪造多个可操作下注阶段。
3. room 的 Join/Attach/Detach/Ready/Leave、下一手定时器、断线回收与 gameUpdate 必须有明确总顺序。房间元数据变化与 game 改变存在依赖时，以 gameUpdate 被消费为提交屏障。
4. 初次 Attach/resync 只能读取“最新已提交的 room 投影”，不能越过尚未处理的 gameUpdate 去读更晚的游戏状态。
5. 不在持 room 锁时等待需要 room 消费者才能完成的同步回调。验证 Start、Submit、Close、定时器并发不存在环状等待；Go race 检查只是辅助，仍需定时完成测试。
6. room revision 对一次可见提交递增一次；给多个玩家发同一提交使用相同 revision，各自数据不同。seq 可继续用于传输日志，但前端真源选择依据 roomInstanceId+revision。
7. 连接绑定 generation；旧连接消息无论版本多大都丢弃。相同实例较小 revision 丢弃，相同 revision 可处理尚未收到的命令回执但不重播事件；首次同步即使 revision 相等也可确认 live。
8. revision 跳号可以接受：完整帧可直接恢复。事件历史可能缺一段时标注已同步，不补造动作。

实例改变时清空旧状态/私牌/待处理动作并重新确认身份；不能将旧 roomCode 的凭据绑定到重建同码房间。服务器 epoch/实例变化不当成普通乱序数据。

## 3. 命令确认与重试

下注、准备、揭示、离席带：`requestId`、`roomInstanceId`、`expectedHandSeq`、`expectedRevision`、既有 payload。服务端只允许合法状态执行。

`CommandReceipt` 包含 requestId、status（applied/rejected/unknown）、appliedRevision（可空）、code（可空）。重复同 requestId 同 payload 返回原结果，不再执行；同 ID 不同 payload 拒绝。去重键绑定恢复身份与 roomInstanceId，不仅按座位号；座位被他人继承时不能共享回执。

首版缓存本房间最近 128 个回执/玩家，至少覆盖两手正常恢复窗口；淘汰后返回 unknown，不能当作未执行并重做。有副作用命令 expectedHandSeq 不匹配直接拒绝；revision 不匹配允许保守拒绝 stale_state 并带最新帧，避免靠本地旧操作猜是否合法。聊天/音效偏好等不套下注版本检查。

客户端五秒未确认：pending 改 verifying，发 resync 并携带 pending requestId 查询；不得以任何人的 acted 清除自己的 pending，不得超时后自动重复 action。恢复帧加回执确定已执行/被拒绝；unknown 时展示“结果未能确认，已同步当前牌局”，清除旧提案，只允许根据最新合法状态重新决策，严禁重播旧命令。

## 4. 身份、REST 与加入竞态

现有 ticket 是短期 WS 入场券；同昵称 Join 会复用座位，不足以支撑可靠恢复。新增随机不可预测的 resumeToken，服务端绑定 roomInstanceId、participantId、有效座位生命周期。客户端只在 sessionStorage 按实例保存；不得写 URL、日志或邀请链接。

- 首次 join 建立 participantId 与 resumeToken，返回短期 ticket。昵称重名但无对应凭据返回 nick_taken，不夺取他人身份。
- 有效 resumeToken 可以换新 ticket，即使旧短券过期。离席生效/座位回收/房间销毁后失效，不恢复到已给他人的座位。
- 活跃连接恢复冲突返回 session_in_use。整页刷新时旧连接尚未释放可短暂有限重试，但不能无限重试或顶替活跃玩家。
- Detach 绑定连接 generation；旧连接的延迟 close 不得把新连接置离线。移除时使用 participantId 校验，不只检验 seat。
- 身份过期保留昵称偏好，提示重新加入；不自动 POST 一个新占座请求。

REST 目标：

| 接口 | 行为 |
|---|---|
| GET /api/rooms | 保留现有 status，补 phase、handSeq、humanCount、botCount、availableJoinModes |
| GET /api/rooms/:code | 新增无副作用预览；返回上述摘要、规则、实例、joinRevision，不返回私牌/凭据 |
| POST /api/rooms | 增加客户端 createRequestId，服务端短期幂等：同请求返回同一创建结果，响应丢失重试不重复建房 |
| POST /api/rooms/:code/join | nick、joinMode、expectedInstance、expectedJoinRevision、joinRequestId；原子复核后占座，幂等返回同一参与者 |
| POST /api/rooms/:code/resume | resumeToken 换短券，不依赖昵称认领身份 |

create/join 幂等记录内存保留至少 10 分钟，与房间生命周期协调；同 ID 不同参数返回冲突。记录过期/进程重启后不能承诺请求未执行，客户端显示恢复选择，不静默重建。createRequestId/joinRequestId 保存在会话流程中直到明确成功或用户主动重开流程。

joinRevision 只随影响入座政策/可用座位的变化更新，不能用每次下注都变的 room revision，否则预览确认会频繁失效。`joinMode` 为 waiting_seat / takeover_bot / next_hand_seat；只返回真正实现并验证的模式。当前 Join 优先空位，再替换机器人，因此不能把所有局中加入都写成接替机器人。若无法证明空位局中加入的本手参与语义，本轮暂不暴露该 mode，返回清楚不可加入原因；这属于安全收敛，不是实现观战。

错误码最小集：bad_nick、nick_taken、room_not_found、room_closed、room_full、join_changed、session_expired、session_in_use、stale_state、bad_action、request_conflict、unsupported_protocol。用户文案在前端集中映射；服务端 msg 不作为唯一判断依据。

## 5. 前端视图模型

建议新增 `api/experienceState.ts`，保持纯函数；输入权威 state、session、pending 和本地界面偏好，输出：

```ts
type Screen = 'join' | 'syncing' | 'waitingRoom' | 'table' | 'removed' | 'closed'
type ActionMode = 'none' | 'ready' | 'confirming' | 'verifying'
  | 'myTurn' | 'waitingTurn' | 'folded' | 'allIn' | 'waitingNextHand' | 'settled'
// 输出字段：screen、phaseSteps、statusTitle、statusDetail、nextHint、actionMode、
// actions、blockedReason、waitingNames、resultSummary；控件只消费这些字段。
```

判定优先级：closed/removed → session 未 live → pending confirming/verifying → 未开局准备室 → settled → 不参与本手 → folded → allIn → 本人合法行动 → 等待别人。旧结果可回顾与当前 phase 独立，不由 resultDismissed 改变准备或下一手状态。

金额：callAmount=max(0,currentBet-myBet)；maxRaiseTo=myBet+myChips；additional=target-myBet。minRaiseTo 与 legalActions 以服务端规则为准，尤其短全下没有重开加注权时，不能仅以筹码够用显示 raise。示例：已下注 10、余量 90，合法总目标上限 100，不是 90。

阶段动画和事件历史独立于权威 reducer；`events` 去重按 eventId，不重放恢复帧。UI 倒计时采用 serverNow 校正时差，重新同步校准；0 秒只表示等待服务器，不本地推进。未收到 deadline 的“无限时”显示“无时限”，不能显示红色 0 秒。

## 6. 兼容和替换策略

前后端同时本地改造，v2 客户端 join 声明 protocolVersion=2。服务端不支持时给版本错误，不在没有保证的情况下退回旧增量推算。需要保留 v1 时，在服务端独立适配输出，不能一个客户端同时消费 v1 筹码增量和 v2 状态帧。

同步更新 model、TS 类型、mockDesk、契约文档和测试 fixture。mock 必须生产同形状 v2 帧；开发演示应有显式标识，不能混同真实房间。外部依赖 API 不因此更改，数据文件与规则算法不迁移。

正式发布不属于本轮，但提交说明必须记载协议不兼容点以及需前后端一起更新；不得让滚动部署期间老客户端静默出现错误筹码。

# AniTexas 前端 ↔ 服务端契约字段清单（互动补全，供后续联调）

> 生成者：FrontendInteract（前端先行实现，服务端配套后置）。
> 2026-10-06 增补：对局节奏与对账契约增量（§4–§6，对应 arch §10 D20–D26）；§1–§3 为互动补全期增量。
> 编码约定：WS 信封 `{t, seq, p}` 不变；下文只列**新增/扩展**字段。
> 固证哈希编码：`sha256 = hex( SHA-256(seed 的 UTF-8 字节) )`，**hex 小写**；比对大小写不敏感。

## 1. 聊天（say / said，与 emote / emoted 同构）

| 方向 | 消息 | 载荷 | 说明 |
|---|---|---|---|
| 上行 | `say` | `{ text: string }` | `text` 去空白后 ≤ **120** 字（`CHAT_MAX_LEN`）；客户端节流 **1500ms**/条（`CHAT_THROTTLE_MS`），服务端建议同限校验 |
| 下行 | `said` | `{ seat: number, text: string }` | 广播给全桌（含发言者）；与 `emoted` 同构 |
| 下行(回执) | `error` | `{ code: "chat_disabled" \| "chat_too_long", msg }` | 建议错误码：房主关聊天 / 超长 |

房间配置（`room.config` / REST 建房 body）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `chatEnabled` | `boolean`（默认 `true`） | 房主开放聊天；`false` 时客户端输入框置灰且不上行 |

前端落点：`ChatPanel`（右侧可折叠）；`snapshot.chatEnabled` 采纳房主开关（快照为全量真源）。

## 2. 可验证发牌（commit-reveal）

| 方向 | 消息 | 载荷 | 时机 |
|---|---|---|---|
| 下行 | `seedCommit` | `{ sha256: string }` | 开局发牌时（先承诺） |
| 下行 | `seedReveal` | `{ seed: string }` | 摊牌时（后揭示） |
| 下行(扩展) | `snapshot` | `seedCommit?: string \| null` | 重复下发本手固证（断线快照恢复后仍可验证，A4.3） |

验证语义（客户端本地、无网络）：`SHA-256(seed)` 与 `seedCommit.sha256` 一致 = 发牌前已承诺、摊牌后未篡改。
前端落点：`SeedBadge`（牌桌角落徽章「发牌已固证」+「验证」按钮，通过/失败明确反馈）；新一手 `seedCommit` 到达即清空上一手的 `seedReveal` 与验证结论。

## 3. 主题牌池（D11：主题池 = 过滤后再分层）

REST 建房 body / `room.config`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `deckStrategy` | `"stratified" \| "theme"` | 已有字段（backend/internal/model）；前端补 UI |
| `themeFilter` | `{ kind: "company" \| "year" \| "tag", value: string }` | 仅 `deckStrategy="theme"` 时携带；`kind` 对应要素类：company=公司(class 2)、year=年代(class 4)、tag=标签(class 3)；`value` ≤ 20 字 |

建议服务端语义：`theme` 策略下先按 `themeFilter` 过滤卡池，再走既有分层抽样（`game.SampleDeck`）；
过滤结果不足牌池规模时的降级策略由服务端定（建议回填分层样本并在房内提示）。

前端落点：`DeckStrategyField`（建房表单）；配置随 `createRoom` 透传，mock 桌面同步支持。

## 4. snapshot 增量字段（对局节奏与对账）

| 字段 | 类型 | 说明 |
|---|---|---|
| `seq` | `number` | 快照时最后事件序号基线：客户端丢弃 `seq ≤` 该值的在途旧事件 |
| `minRaise` | `number` | 最小加注增量；raise 目标 ≥ `currentBet + minRaise`（全下豁免） |
| `turnMs` | `number` | 行动时限（毫秒） |
| `seed` | `string \| null` | 当前手 seed，摊牌后可见（此前 `null`；与 `seedCommit` 并存，见 §2） |
| `box` | `BoxCard[]` | D17 本手盒名单 |
| `pool` | `PoolInfo` | 本手牌池信息 |
| `seats[i].ready` | `boolean` | 是否已准备（每手重置） |
| `seats[i].rebuys` | `number` | 本局重买次数（计入 `MAX_REBUYS` 上限） |

类型定义（盒名单不得含隐藏要素，D7 安全基线不变）：

| 类型 | 定义 | 说明 |
|---|---|---|
| `BoxCard` | `{ id, title, score, bucket, year }` | 盒名单条目，只含 L1 公开信息，不得含隐藏要素 |
| `PoolInfo` | `{ strategy: "stratified" \| "theme", theme?: ThemeFilter \| null, poolSize: number, fallback: boolean }` | `theme` 复用 §3 `ThemeFilter`；`fallback=true` 表示主题过滤过窄、已回退全库 |

## 5. 事件增量（minRaise / nextHand / readied / error 码）

| 方向 | 消息 | 载荷 | 说明 |
|---|---|---|---|
| 下行(扩展) | `acted` | `{seat, type, amount, minRaise?: number}` | 载荷新增最小加注增量（服务端权威下发） |
| 下行(扩展) | `flop` / `turn` / `river` | `{cards, minRaise?: number}` | 同上 |
| 下行 | `nextHand` | `{ startAt: number }` | 下一手自动开局时刻（epoch ms，与 `snapshot.deadline` 同口径）；全员 ready 提前开局 |
| 下行 | `readied` | `{ seat: number }` | 座位准备广播（每手重置；局中忽略） |
| 下行(回执) | `error` | `{ code: "rebuy_exhausted" \| "ticket_in_use", msg }` | 新增错误码：重买达上限 `MAX_REBUYS` / ticket 已被活跃连接占用 |

服务端行为（wire 可见部分）：settled 后排程 `nextHand`（`NEXT_HAND_DELAY_SECONDS`，默认 8s，到点在座 ≥ 2 自动开局）；
断线 > `DISCONNECT_GRACE_SECONDS`（默认 300s）自动离席；waiting 无在座人类 > `IDLE_ROOM_TTL_MINUTES`（默认 10 分钟）→ closed；
座位/筹码结构变化（重买、离席、断线回收、破产处置）后广播全量 `snapshot` 对账。

## 6. action 全下（协议已有，前端补按钮）

| 方向 | 消息 | 载荷 | 说明 |
|---|---|---|---|
| 上行 | `action` | `{ type: "allin" }` | `type` 取值本就含 `'allin'`（`ActionType`），本次 ActionBar 补「全下」按钮 |

金额语义：`bet`/`raise` 的 `amount` 为「下注到 / 加注到」的目标总投入（非增量），前端输入按此语义标注；
加注目标需 ≥ `currentBet + minRaise`（全下豁免）。

前端配套落点（本次行为规格）：ActionBar 全下按钮；金额语义「下注到 / 加注到」；键盘快捷键 F/C/A/R；离开回大厅；
结算弹层可关闭 + 离开按钮；断线状态条 + 禁用操作；nextHand 倒计时；牌池抽屉（D17）；私看走确认弹层；
聊天/表情 a11y 与 disabled；移动端 scale 下限 0.6 + 滚动 + 提示条；建房预设 + 高级折叠；房间列表三态。

## 7. 兼容性

- 以上全部为**增量字段**：老服务端不下发 `said`/`seedCommit`/`seedReveal`/`nextHand`/`readied` 时前端静默降级（徽章不渲染、聊天账本为空、下一手倒计时不出），既有流程不受影响。
- `snapshot` 新增字段均可选（`chatEnabled?`、`seedCommit?`、`seq?`、`minRaise?`、`turnMs?`、`seed?`、`box?`、`pool?`、`seats[].ready?`、`seats[].rebuys?`），快照缺省时取默认（`true` / `null` / `0` / 空列表）。

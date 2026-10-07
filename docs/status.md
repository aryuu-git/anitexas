# AniTexas 现状 · 限制 · 规划

> 面向三个月后接手的人。数字均为 **2026-09-30 回仓库实测**（`wc` / 报告文件 / 产物字段），
> 与早期口头快照不符处以本文为准（见 §2 注）。**2026-10-06 流程 + UI 修复**（arch §10 D20–D26）落地后行为口径已同步进本版（§3/§4/§5），行数等计数数字仍是 2026-09-30 口径、未重新计数。玩法规则唯一真源 `docs/rules.html`（规则书 v1.0）；
> 实现蓝图 / 验收标准 / 决策日志 `docs/architecture.md`（下称 arch，`Dn` = arch §10 决策号，`An` = arch §7 验收号）；
> 逐条验收结论 `docs/acceptance-report.md`（下称验收报告）。

## §1 现状（一段话）

**可交付试玩（2026-09-30，验收报告 §0 结论）。** 六模块已集成贯通：纯函数规则引擎（黄金十手 G1–G10 全绿 +
10 万组 fuzz）、无限注对局状态机（多层边池、图约束装盒 SampleDeck、亮牌、双账本）、REST+WS 服务
（SQLite 六表、bot、端口 8081 契约）、樱墨设计系统前端（牌面三态、桌感动效音效、聊天/表情/亮一只/
可验证发牌/主题池表单）、可复现卡池管线（全量卡库 20,423 张，两处对账成立）、部署资产（nginx/systemd/
发布回滚脚本+手册）。集成验收已交付：死锁根因（装盒超线性）修复 62s→18ms、A4.8 隐藏数据零泄露硬验收过
（94 帧 0 泄露）、后端全测/前端构建+42 用例全绿。遗留 R1（SampleDeck 18ms 未达 10ms）不阻碍试玩；
R2 破产处置已收敛（D19/D22：bot 离席、真人就地重买、上限 MAX_REBUYS）。**2026-10-06 流程 + UI 修复已落**（D20–D26）：
下一手自动开局制、断线回收与空闲房回收、重买上限、ticket 防顶号、快照对账帧、minRaise/盒名单下发（兑现 D17）、snapshot seq 基线；
聊天（say/said）与发牌固证（seedCommit/seedReveal）服务端均已落。**进行中**：封面抓取 P8（72 张已落盘）；浅羁绊过热的平衡性调参待做（data/BALANCE.md）。

## §2 交付清单与实测数字

手写代码合计 **约 14,900 行**（早期快照称 13.6k，为后续交付波之前的旧值；以仓库为准）。

| 模块 | 行数（源码 + 测试） | 关键内容 |
|---|---|---|
| backend Go 合计 | 8,316（5,761 + 2,555） | `go build/vet/test ./...` 全绿（验收报告 §1） |
| └ internal/engine | 711（370 + 341） | 规则引擎纯函数（D6）；黄金十手 + `TestCompareFuzz` 10 万组全序 |
| └ internal/game | 3,595（2,263 + 1,332） | 状态机/下注/边池/装盒/揭示/结算 + `a63_bench_test.go` 基准回归网 |
| └ internal/room | 1,591（1,222 + 369） | 其中 `room.go` **823 行单文件**（待拆，见 §4）；`botselfplay_test.go`（2 局自对局，D18）+ `a63_soak_test.go`（10 桌并发） |
| └ internal/store | 811（551 + 260） | SQLite 六表（cards/rooms/hands/actions/reveal_log/scores） |
| └ internal/api | 571 | REST 路由 + WS 网关 + ticket |
| └ internal/config / model / cmd/server | 503 / 413 / 121 | 配置校验、消息类型（含 G3 修复）、入口 |
| frontend/src | 4,775（4,198 + 577） | vitest 8 文件 **42 用例全绿**（CardFace/BettingBar/EmoteBar/ChatPanel/SeedBadge/DeckStrategyField/roomState/seed） |
| scripts（Python） | 1,300 | build_cards 601 / simulate_balance 361 / calibrate 186 / verify_hands 152 |
| deploy | 520 | README 手册 210 / deploy-server.sh 114 / nginx.conf 76 / env.example 42 / rollback 41 / systemd 37 |

数据产物与验收产物（实测）：

| 产物 | 数字 | 出处 |
|---|---|---|
| `data/cards.json` | **20,423 张** / 587,307 行 / 7.8 MiB；字段 `id,title,score,bucket,year,type,monogram,elements`（**尚无 `cover` 字段**，P8 未落） | JSON 实测 |
| 准入对账 | 692,161 = 淘汰 671,738 + 通过 20,423 ✓；标注 185,830 = 筛掉 157,475 + 保留 28,355 ✓ | `data/pipeline-report.md` P1–P4 |
| 黄金十手 | G1–G10 在全量卡库上复算 ALL OK；引擎测试 + fuzz 全绿 | pipeline-report P5 / 验收报告 §2 |
| 校准 | T₁=50 建议维持（边际平坦）；T₂ 建议暂不筛（最高频「搞笑」仅占帧 5.4%） | `data/CALIBRATION.md` |
| 平衡模拟 | 10,000 手（pool 78, seed 20260929）：有组率 100%、tier≥7 达 91.7%，8/10 档偏离目标区间 | `data/BALANCE.md` |
| 集成验收 | **可以交付试玩**；A4.8 硬验收 94 帧 0 泄露；A6.3：Best7 53µs / 快照 ≈µs / SampleDeck 18–25ms（R1）/ 10 桌并发无泄漏 | `docs/acceptance-report.md`（204 行） |
| 封面映射 | bangumi-data 8,897 条目 / 8,380 带 MAL 映射 | `C:/Users/chenjincan/Downloads/bak/bangumi-data-dist.json` |
| 封面图 | `data/covers/` **72 张已落盘**（P8 进行中；Jikan 故障时改走 MAL og:image 兜底） | 目录实测 |

## §3 机制要点速览

- **牌面信息三层**（arch §1）：L1 公开（封面/名/评分/档位，D1）→ L2 隐藏（五类要素：监督1/公司2/标签3/年份4/原作类型5）→ L3 摊牌（对手底牌要素，D2）。
- **单一揭示模式**（D14）：「明示」不是模式，只是建房开关 `autoReveal`（默认 false=隐藏开局，true=开局全揭示）。
- **REVEAL**：点自己的牌（私看或当众亮一只，D15）/ 公共牌（只能当众）；不可逆（D3）；费率 v1=0 只记账（D4）；对手底牌不可点（D2）。
- **双账本**（D15）：筹码（德州输赢）+ 积分（牌型分 + 羁绊加成 − Σ揭示成本），互不干扰。
- **隐藏数据不下发**（D7）：`hidden` 下未揭示要素服务端**根本不查询**，不进任何下行消息（含错误回执）；A4.8 帧级取证 94 帧 0 泄露（验收报告 §5）。
- **每手新盒**（D11/D16）：`game.SampleDeck` 分层 + 图约束装盒（档位等额 × 组牌类最大余数法，pipeline-report P6 有口径），无黄金保送；同 seed 同盒。装盒工作量确定性封顶（G2 修复，无计时器保可复现）。
- **盒名单公开**（D17）：本局参赛作品明牌，要素仍走揭示；算概率 = 卡名知识 + 已揭示要素。
- **发牌固证（commit-reveal）**：`seedCommit`=SHA-256(seed)（hex 小写）、摊牌 `seedReveal`，前端本地验证已交付（`frontend/src/api/seed.ts`、`components/SeedBadge.tsx`）；服务端 `seedCommit`/`seedReveal` **已落**（`model/ws.go`），`snapshot.seed` 摊牌后可见、与 `seedCommit` 并存供断线后验证。
- **互动层**（D15）：聊天（`ChatPanel`）、快捷表情 8 选 1、10 秒/座位冷却（`TypeEmote`）、亮一只、结算仪式、Web Audio 音效——前端已交付，聊天服务端中转（`say`/`said`）**已落**。
- **WS 协议**（arch §5）：上行 join/ready/action/reveal/emote/say/leave/ping/resync；下行 snapshot/dealt/flop/turn/river/acted/revealed/showdown/settled/emoted/said/seedCommit/seedReveal/nextHand/readied/error。前端契约细目 `docs/frontend-contract.md`。
- **对局节奏与回收**（D20–D22）：settled 后排程 `nextHand`（`NEXT_HAND_DELAY_SECONDS`，默认 8s），到点在座 ≥ 2 自动开局、全员 ready 提前开局（局中 ready 忽略、ready 每手重置）；断线 > `DISCONNECT_GRACE_SECONDS`（默认 300s）自动离席（playing 标 `pendingLeave` 收手生效）；waiting 且无在座人类 > `IDLE_ROOM_TTL_MINUTES`（默认 10 分钟）→ closed；破产真人就地重买、上限 `MAX_REBUYS`（默认 3，达上限自动离席）。开局流水任一步失败回/保持 waiting + error 广播，绝不滞留 playing（死桌防护）。
- **对账与防顶号**（D23–D26）：座位/筹码结构变化（重买、离席、断线回收、破产处置）后广播全量 `snapshot`；`snapshot` 带 `seq` 基线（客户端丢弃在途旧事件）、`minRaise`、`turnMs`、`seed`、`box`（D17 盒名单兑现）、`pool` 与 `seats[].ready/rebuys`；ticket 核销绑定连接，被活跃连接占用时同 ticket 再核销回 `ticket_in_use`，断线 TTL 内可重连核销。

## §4 限制与已知问题

**产品**
- 无账号体系：房间码 + 昵称 + 一次性 ticket（D9）；JWT/账号为预留升级路径。
- 揭示费率 v1=0，只记账不扣分（D4）；积分数值规则未调优。
- **R2 破产处置已收敛**（D19/D22；原「破产不补位」为验收报告 §10 的旧结论）：筹码归零 bot 离席、真人就地重买（重买额=初始筹码、仅筹码账，计入 `seats[].rebuys`），达上限 `MAX_REBUYS`（默认 3）自动离席；长局 `active < 2` 开局失败已消除。
- v1 不做：赛季/排行榜/战绩持久化展示、移动端原生（arch §0 边界表）。

**工程**
- **R1 SampleDeck 未达 10ms 硬指标**（验收报告 §10）：实测 18–25ms（已从病态 62s 优化约 3400×，根因=装盒超线性 G2）；剩余瓶颈为全库 `sharedElements` 扫描（D16 要求全量卡库定组牌类），达标需 `sharedElements`/`build()`/`poolFor` 由 O(库) 改 O(盒)。发牌 18ms 对人不可感知，可玩性无碍。
- `room/room.go` 823 行单文件待拆（房间生命周期/座位/准备开局全在一个文件）。
- 前端 mock 演示桌 630 行（`api/mockCards.ts` 288 + `api/mockDesk.ts` 342）：离线演示用假服务端，**必须与真协议手同步**，是漂移风险点。
- 原「聊天与发牌固证服务端未落」限制**已消除**（`say`/`said`/`seedCommit`/`seedReveal` 均已实现，见 §3）；主题池仍仅表单与数据结构，A2.4 换配置出池未实测（后置）。
- 本次新增环境配置项（部署契约 `deploy/anitexas.env.example`，与 `TURN_TIMEOUT_SECONDS` 同一契约、改名即破部署）：`NEXT_HAND_DELAY_SECONDS`（默认 8）、`DISCONNECT_GRACE_SECONDS`（默认 300）、`IDLE_ROOM_TTL_MINUTES`（默认 10）、`MAX_REBUYS`（默认 3）。
- A5 视觉走查（A5.1–A5.6）与部分浏览器联调（A4.1/A4.2/A4.4/A4.7）**未验**，见验收报告 §6/§8 人工清单；bot 首选动作偶走 `botFallback` 兜底（R3，仅智能度问题）。

**数据**（根因多在 dump 元数据质量，见 pipeline-report「遗留问题」）
- 69% 准入卡 0 有效标签（14,085/20,423；dump tags 每卡仅 top11 + T₁=50 截断）；成组主要靠年份/类型/监督/公司。
- 公司要素覆盖仅 33%（6,722/20,423）；标签覆盖 6,338/20,423。
- **浅羁绊过热**（BALANCE 10,000 手）：「原作类型=其他」是兜底桶（库占 34%、盒内 50%）人人相撞，叠加 T₂ 未启用，tier≥7 达 91.7%（目标区间上限合计仅 9.2%，balance_targets.json v1）；剥离类 4/5 后独奏率 86.3%——深羁绊反而稀缺。三旋钮见 §5。
- 标签黑名单 v1 有漏网人名/公司名；原作文本推断未识别 946 条归「其他」。

**环境**
- 与 karuta 同机共存：端口 8081、nginx 独立 server_name（**禁 `_` 兜底**，D13）；改端口须三处同步（env/nginx/脚本探活）。
- bangumi 图床内网不通；真封面走 MAL（D10），Jikan 取图故障时降级 og:image 兜底，缺图再降级首字生成封面。
- Windows 沙箱无法演练符号链接原子切换与 `nginx -t`；A6.2 部署演练、百局 soak/压测需 Linux 目标机（D18 已后置）。

## §5 规划路线图

**近期（2026-09-30）**
| 事项 | 状态 | 落点 |
|---|---|---|
| 流程 + UI 修复：下一手自动开局、断线/空闲房回收、重买上限、ticket 防顶号、快照对账帧、minRaise/盒名单下发（兑现 D17）、seq 基线；聊天/发牌固证服务端落地（D20–D26） | **已交付**（2026-10-06） | arch §5/§10 / `docs/frontend-contract.md` |
| 集成验收链：死锁修复 → 全量测试 → A4.8 零泄露断言 → `acceptance-report.md` | **已交付**（可交付试玩；死锁根因=装盒超线性，62s→18ms） | 验收报告 §0/§5/§9 |
| A6.3 性能实测（Best7/快照/SampleDeck/10 桌并发） | **已交付**（两项达标、SampleDeck 遗留 R1；临时测速文件已删，转 `a63_*_test.go` 回归网） | 验收报告 §7 |
| 前端互动补全：聊天、可验证发牌、主题池表单、测试补强 | **已交付**（8 文件 42 用例） | `docs/frontend-contract.md` |
| 封面抓取 P8：bangumi-data 映射 → Jikan/og:image → `data/covers/` + cards.json 加 `cover` 字段 | **进行中**（72 张已落盘，Jikan 故障走 MAL og:image 兜底） | arch §4.6 P8 / D10 |

**中期**
- R1 收敛：SampleDeck 由 O(库) 改 O(盒)（增量/索引），达 <10ms 硬指标。
- 平衡调参三旋钮（依 BALANCE 建议）：①「其他」不产类型要素的敏感性实验（需规则定夺，牵动 G7）②装盒档位等额→等额/比例混合 ③T₁ 下调 20 / 配额向深羁绊类倾斜。
- MC equity bot（蒙特卡洛，依赖 D17 盒名单）替代启发式 bot。
- 人工验收清单执行（验收报告 §8）：真人一局 A3.5 / 拔网线 A4.3 / Linux 部署演练 A6.2 / A5 视觉走查 / 双浏览器联调。

**远期**
- Elo 赛季积分、旁观席/成就/献花；主题池 UI 联调与 A2.4 换配置出池实测（D11）。
- 百局 soak 与压测（D18 后置压力项）；bot 首选智能度优化（R3）。
- 账号体系（ticket→JWT 升级路径，D9）；引擎 WASM 化给前端做提示（D6 预留）。
- 数据侧根治：dump meta 补「其他」拆细、标签黑名单 v2 随 calibrate 高频清单补录。

## §6 关键文件索引（读哪里找什么）

| 要找什么 | 读哪里 |
|---|---|
| 玩法规则（牌型/比较链/边界/参数表） | `docs/rules.html`（8 节：概览/牌面/要素五类/牌型排行榜/比较链/边界规则/对局流程/参数）+ `docs/rules.png` |
| 架构、WS 协议、SQLite 表、WBS、验收 A1–A6、决策 D1–D26 | `docs/architecture.md` |
| **逐条验收结论、A4.8 取证、A6.3 实测、遗留 R1–R5** | `docs/acceptance-report.md` |
| 前端契约（消息/组件/状态归约细目） | `docs/frontend-contract.md` |
| 牌型判定/全序比较 | `backend/internal/engine/{hand,group,compare,eval7,card}.go`；黄金夹具 `engine/testdata/golden.json`（由 `scripts/golden_hands.json` 固化） |
| 对局生命周期/边池/装盒配额 | `backend/internal/game/{game,state,betting,pot,deck,box,reveal,settle}.go`（game.go 641 行主循环；G2 装盒封顶在 box.go/deck.go） |
| 房间/座位/bot | `backend/internal/room/{room,bot,manager,code,gamecfg}.go`（room.go 823 行） |
| 消息类型与编解码 | `backend/internal/model/ws.go`（类型常量）、`backend/internal/api/ws.go`（网关）、`frontend/src/api/types.ts` |
| 性能基准/并发 soak 回归 | `backend/internal/game/a63_bench_test.go`、`backend/internal/room/a63_soak_test.go`、`backend/internal/room/botselfplay_test.go` |
| 表结构 DDL | `backend/internal/store/db.go` |
| 卡池管线与口径 | `scripts/build_cards.py`（P1–P8）；报告 `data/pipeline-report.md`（含 P6 装盒配额口径） |
| 校准/平衡依据 | `data/CALIBRATION.md`（T₁/T₂）、`data/BALANCE.md`（频率/热源/调优建议）、`scripts/{calibrate,simulate_balance}.py`、`scripts/{tag_blacklist.txt,balance_targets.json}` |
| 前端对局桌/事件归约 | `frontend/src/pages/RoomPage.tsx`、`frontend/src/api/roomState.ts`（含聊天/固证态） |
| 离线演示桌（mock） | `frontend/src/api/{mockCards,mockDesk}.ts`（630 行） |
| 可验证发牌 | `frontend/src/api/seed.ts` + `frontend/src/components/SeedBadge.tsx` |
| 部署与回滚 | `deploy/README.md`（§2 构建 → §3 发布 → §5 回滚 → §7 演练验收）、`deploy/{nginx.conf,anitexas.env.example,systemd/anitexas.service,scripts/*.sh}` |
| A4.8 泄露取证脚本（一次性产物） | `C:/Users/chenjincan/Downloads/bak/{anitexas-e2e.mjs,e2e-a48-result.json,e2e-frames-debug.json}` |

## §7 决策日志索引（D1–D26，全文见 architecture.md §10）

| # | 一句话 | # | 一句话 |
|---|---|---|---|
| D1 | 评分恒公开（下注依据） | D14 | 明示/隐藏合并为单一揭示模式，「明示」降级为 `autoReveal` 开关 |
| D2 | 对手底牌要素不可点，摊牌才亮 | D15 | 互动层：亮一只牌/表情/结算仪式，音效 Web Audio 合成 |
| D3 | 展开不可逆 | D16 | 废除黄金锚点强制入盒：卡库=全量合格牌，牌盒=运行时 SampleDeck |
| D4 | 揭示费率 v1=0 只记账，扣分策略后置 | D17 | 盒名单对玩家公开（算牌前提），要素仍走揭示 |
| D5 | 技术栈与 karuta 同栈（Go/chi/WS/SQLite + React/TS/Vite/Tailwind） | D18 | 验收抽验从简：bot 自对局 2 局即验收，百局 soak 与压测后置 |
| D6 | 引擎独立纯函数包（可测、可 WASM） | D19 | 破产处置：bot 离席、真人可重入重买（仅筹码账） |
| D7 | 服务端权威 + 隐藏数据不查询不下发 | D20 | 下一手自动开局制：ready 只做提前通道；开局失败绝不滞留 playing |
| D8 | SQLite（WAL）而非外部数据库 | D21 | 断线回收 + 空闲房回收（300s / 10min 双时限） |
| D9 | v1 无账号：房间码 + 昵称（ticket 预留升级） | D22 | 重买上限 `MAX_REBUYS`（默认 3，达上限自动离席），R2 收敛 |
| D10 | 封面分层：MAL/Jikan 抓取缓存为主，首字生成封面兜底 | D23 | ticket 防顶号：核销绑定连接，占用回 `ticket_in_use` |
| D11 | 牌盒默认分层随机（档位×要素配额、固定 seed），主题池做配置 | D24 | 快照对账帧：座位/筹码结构变化后广播全量 `snapshot` |
| D12 | 一桌一 goroutine 串行推进状态机 | D25 | `minRaise`/盒名单随快照与事件下发（兑现 D17） |
| D13 | 与 karuta 同机：8081 端口 + 独立 server_name（禁 `_`） | D26 | `snapshot` 携 `seq` 基线，丢弃在途旧事件 |

---
*本文是快照不是真源：机制与协议以 `docs/rules.html` / `docs/architecture.md` 为准，验收结论以 `docs/acceptance-report.md` 为准，数字以仓库实测为准（本版实测 2026-09-30）。*

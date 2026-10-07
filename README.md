# AniTexas — 动画 × 德州扑克变体

在线多人「动画德州」：用动画作品卡凑**要素羁绊**的德州变体。隐藏模式下要素要花钱展开（预留扣分），
认得出作品的人不用花这个钱——信息差就是牌技。

- 玩法规则唯一真源：[docs/rules.html](docs/rules.html)（规则书 v1.0：牌型 G1–G10、比较链、边界规则、参数表）
- 实现蓝图与验收标准：[docs/architecture.md](docs/architecture.md)（模块拆解 / WS 协议 / SQLite 表 / WBS / A1–A6）

## 目录结构

```
anitexas/
├── docs/          # 规则书 rules.html + 校准图 rules.png + 架构 architecture.md + fonts/
├── scripts/       # 离线卡池管线（Python）：build_cards.py / calibrate.py / verify_hands.py
├── backend/       # Go 后端（自包含 module）：engine 纯函数引擎 / game 状态机 / room / api / store
├── frontend/      # React 前端（自包含 package）：大厅 / 对局桌 / 樱墨设计 token
├── deploy/        # 部署资产：nginx.conf / systemd / anitexas.env.example / 发布回滚脚本 + 手册
├── data/          # 一切产物（gitignore）：cards.json、anitexas.db、二进制、dist
└── README.md
```

## 快速开始

前置：Go 1.27 · Node 26 · Python 3.14（数据源 dump 见 [docs/architecture.md](docs/architecture.md) §0）。

```bash
# 1) 卡池管线：dump → data/cards.json（同 dump 同配置可复现，固定 seed）
python scripts/build_cards.py

# 2) 后端
cd backend
go build ./...
go run ./cmd/server          # 起服；端口/路径等环境变量见 deploy/anitexas.env.example

# 3) 前端（另开终端）
cd frontend
npm install
npm run dev                  # 开发
npm run build                # 生产构建 → data/dist
```

产物统一落 `data/`（`cards.json` / `anitexas.db` / 二进制 / `dist`）；`/api` 与 `/ws` 由 vite dev
代理到 `localhost:8081`（协议见 architecture.md §4.4 / §5）。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/rules.html](docs/rules.html) | 规则书：玩法规则的唯一真源 |
| [docs/architecture.md](docs/architecture.md) | 架构蓝图：模块拆解、协议、表结构、验收标准 |
| [deploy/README.md](deploy/README.md) | 部署与回滚手册（构建 → 安装 → 启动 → 验证 → 回滚） |

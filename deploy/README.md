# anitexas 部署与回滚手册

> 照抄可执行。服务名 `anitexas`；产物统一落 `data/`（线上数据根 `/data/anitexas`）。
> 接口契约见 [../docs/architecture.md](../docs/architecture.md) §4.4（REST `/api/*`、WS `/ws`），
> 存储表结构见 §4.5（SQLite WAL）。本文只管部署、验证与回滚。

## 0. 部署布局

```
/opt/anitexas/
├── current -> releases/<version>     # 原子发布指针（nginx root 与二进制共用，前后端同版本）
├── previous -> releases/<old>        # 上一个版本，供回滚（deploy-oneclick.sh --rollback）
├── releases/<version>/
│   ├── anitexas-server               # Go 二进制（backend/cmd/server）
│   ├── cards.json                    # 卡池产物（scripts/build_cards.py 的 P6 产出）
│   └── dist/                         # 前端产物（npm run build → data/dist，打包时拷入）
└── shared/
    └── anitexas.env                  # 环境变量（模板见 anitexas.env.example）

/data/anitexas/                       # 可写数据根（systemd ReadWritePaths）
├── anitexas.db                       # SQLite（WAL）
└── backups/                          # 发布前自动 DB 备份
```

## 与 karuta 同机共存（单 :80 · 子路径）

一台机器、一个公网 IP、**只有一个 nginx `:80`**，三站按路径分：

| 路径 | 归属 | 说明 |
|---|---|---|
| `= /`（裸根） | 门户 | `/opt/aryuu-portal/portal.html`（刻意避开 karuta SPA 回退用的 `/index.html`） |
| `/anitexas/` | anitexas | 前端（vite `base=/anitexas/`）；`/anitexas/api/`→8081、`/anitexas/ws`→8081 |
| 其余全部 | karuta | 前端 dist + `/api/` `/ws/` `/uploads/` → 8080（含线上既有的 `/karuta` 301） |

端口各归其位：**对外 nginx 80**；anitexas 后端 **8081**（`shared/anitexas.env` 的 `PORT`）；karuta 后端 **8080**。

注意：

1. **nginx 由 portal 仓库统一维护**，唯一部署件 = `others/aryuu-portal-nginx/nginx-single80-subpath.conf`
   （替换服务器整个 `server {}`）。anitexas 仓库**不再单独提供 nginx 配置**，避免两份 server 块抢 :80 兜底位。
2. 纯 IP 访问没有域名可分流 → **不要新开第二个 `listen 80; server_name _;`**（谁先加载谁吃流量，且 `nginx -t` 不报错，属静默误路由）。要加站点就加子路径。
3. 改 anitexas 的**对外路径** = 改 vite `base` + portal nginx 的对应 location；改**后端端口** = 改
   `shared/anitexas.env` 的 `PORT` 与 portal nginx 的 `proxy_pass`（两处一致）。

## 1. 前置准备

**用 §3 的一键脚本时，下面 1)–3) 会自动完成**（幂等）；只在手工部署时才需要照做：

```bash
# 系统用户与目录
sudo useradd --system --home /opt/anitexas --shell /usr/sbin/nologin anitexas
sudo mkdir -p /opt/anitexas/{releases,shared} /data/anitexas/backups
sudo chown -R anitexas:anitexas /opt/anitexas /data/anitexas

# 环境变量（模板也随发布包一起带；手工时从仓库拷）
sudo cp deploy/anitexas.env.example /opt/anitexas/shared/anitexas.env
sudo chown anitexas:anitexas /opt/anitexas/shared/anitexas.env
sudo chmod 600 /opt/anitexas/shared/anitexas.env
sudo vi /opt/anitexas/shared/anitexas.env

# systemd 单元（模板也随发布包一起带）
sudo cp deploy/systemd/anitexas.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable anitexas
```

nginx 不在本仓库：按 [../aryuu-portal-nginx](../aryuu-portal-nginx)（相对 `others/`）的
`nginx-single80-subpath.conf` 部署（`nginx -t && sudo systemctl reload nginx`）。

## 2. 构建发布包（开发机 / CI）

前置：Go 1.27 / Node 26 / Python 3.14；数据源 dump 见根 README「数据真源」。
打包器：`deploy/scripts/build-release.sh`（与 karuta 的同名脚本同口径：只负责构建 + 打包）。

```bash
# 一把打包：默认版本 <UTC 日期>-1，交叉编译 linux/amd64
./deploy/scripts/build-release.sh                 # 产出 anitexas-2026.10.05-1.tar.zst(+.sha256)
./deploy/scripts/build-release.sh 2026.10.05-3    # 指定版本号

# 需要重建卡池时（要 dump，慢；默认只要求 data/cards.json 已存在）
BUILD_CARDS=1 ./deploy/scripts/build-release.sh 2026.10.05-3

# 赶时间跳过测试（不推荐）
SKIP_TESTS=1 ./deploy/scripts/build-release.sh
```

脚本做的事：

1. 校验 `data/cards.json` 存在（`BUILD_CARDS=1` 时先跑 `python scripts/build_cards.py`）；
2. `go test ./...` + 前端 `vitest run`（`SKIP_TESTS=1` 跳过）；
3. `npm run build` → `data/dist`；`CGO_ENABLED=0 GOOS=linux GOARCH=amd64` 交叉编译 → `release/anitexas-server`；
4. 组装 `release/`：`anitexas-server` + `cards.json` + `dist/` + `VERSION` + `anitexas.service` + `anitexas.env.example`
   （后两件供一键脚本首装引导）；
5. 打成 `anitexas-<版本>.tar.zst` 并出同名 `.sha256`。

把 `anitexas-<版本>.tar.zst` + 同名 `.sha256` 上传到服务器（与 §3 的脚本同目录），进入发布。

> Windows Git Bash 下若 `tar` 不支持 zstd，用系统自带的 GNU tar：
> `TAR=/c/Windows/System32/tar.exe ./deploy/scripts/build-release.sh 2026.10.05-3`（脚本会自动探测，失败会给出提示）。

## 3. 发布（唯一方式：上传「包 + 脚本」，一键部署）

把这两个文件丢到服务器**同一个目录**（如 `/tmp` 或 `/opt/anitexas`）：

- 发布包 `anitexas-<版本>.tar.zst`（连同同名 `.sha256`）
- 脚本 `deploy/scripts/deploy-oneclick.sh`

```bash
chmod +x deploy-oneclick.sh
sudo ./deploy-oneclick.sh                                    # 自动找同目录的 anitexas-*.tar.zst
sudo ./deploy-oneclick.sh /tmp/anitexas-2026.10.05-1.tar.zst # 或显式指定包路径
sudo ./deploy-oneclick.sh --rollback                         # 一键回滚到上一版本
```

首次运行会**自动引导**（幂等）：创建 `anitexas` 用户、`/opt/anitexas/{releases,shared}`、
`/data/anitexas/backups`、安装 `anitexas.service`、并从包内模板生成 `shared/anitexas.env`。
之后每次执行 = 发布一版：

1. 校验 sha256（同目录有 `.sha256` 时）；
2. 解包到 `releases/<version>`，校验 `anitexas-server` / `cards.json` / `dist/index.html` 齐全；
3. 备份 SQLite（优先 `sqlite3 .backup`，退而 `python3`）；
4. `current` 原子指向新版本（`previous` 记录旧版本）；
5. `systemctl restart anitexas`；
6. 探活 `GET /api/health`（30×1s），不就绪**自动回滚到 `previous`** 并以非零退出。

> 前提：nginx 已按「单 :80 子路径」配好（见 §0 表与 [../aryuu-portal-nginx](../aryuu-portal-nginx)）；
> 本脚本只管应用本身（二进制 / 卡池 / 前端）。

## 4. 启动与验证

```bash
# 首次部署后启动；日常发布由脚本 restart，无需手动
sudo systemctl start anitexas
sudo systemctl status anitexas

# 后端直连（内网 8081）
curl -fsS http://127.0.0.1:8081/api/health

# 冒烟：建房拿房间码（REST §4.4：POST /api/rooms，配置全默认）
curl -fsS -X POST http://127.0.0.1:8081/api/rooms \
  -H 'Content-Type: application/json' -d '{}'

# 经 nginx 的外网链路（单 :80 子路径）
curl -fsS http://127.0.0.1/anitexas/api/health
curl -fsS http://<IP>/anitexas/api/health          # 从外部机器验证

# WebSocket 升级头联通性（应返回 101 Switching Protocols）
curl -i -sS --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  http://127.0.0.1/anitexas/ws | sed -n 1p

# 前端壳可达（应 200，引用 /anitexas/assets/…）
curl -sI http://127.0.0.1/anitexas/ | sed -n 1p
```

最终验收走一遍真实对局：浏览器开 `http://<IP>/anitexas/` → 大厅建房（房间码）→ 第二浏览器入座 →
准备开局 → 打完一手看结算面板（A3.5 / A4.1 场景）。

## 5. 回滚

```bash
# 一键回滚到上一个 release（current ← previous，重启 + 探活）
sudo ./deploy-oneclick.sh --rollback
```

手动回滚到指定版本：

```bash
ls /opt/anitexas/releases/            # 列出可回滚版本
sudo ln -sfn /opt/anitexas/releases/<version> /opt/anitexas/current
sudo systemctl restart anitexas
curl -fsS http://127.0.0.1:8081/api/health
```

数据回滚（仅当发布引入数据问题时才做；正常回滚**不动 DB**——
§4.5 的牌局数据是动作日志追加式，新旧版本结构兼容）：

```bash
sudo systemctl stop anitexas
sudo -u anitexas rm -f /data/anitexas/anitexas.db-wal /data/anitexas/anitexas.db-shm
sudo -u anitexas sqlite3 /data/anitexas/backups/<备份文件> ".backup /data/anitexas/anitexas.db"
sudo systemctl start anitexas
```

回滚范围说明：`current` 一次切换二进制、卡池产物（`cards.json` 随包走）、前端 dist，
保证三者同版本；环境变量（`shared/anitexas.env`）不随发布包走，改配置属独立变更。

## 6. 日常运维

```bash
# 日志（journald，见 systemd 单元）
journalctl -u anitexas -f
journalctl -u anitexas --since today | grep -i error

# 手动 DB 备份
sudo -u anitexas sqlite3 /data/anitexas/anitexas.db \
  ".backup /data/anitexas/backups/anitexas-$(date -u +%Y%m%dT%H%M%SZ).db"

# 配置变更（改 env 后重启生效）
sudo vi /opt/anitexas/shared/anitexas.env
sudo systemctl restart anitexas

# 旧版本：deploy-oneclick.sh 会自动清理，保留最近 ANITEXAS_KEEP(默认5) 份 + current/previous
ls -dt /opt/anitexas/releases/*
```

## 7. 演练验收（A6.2）

部署资产的验收判定：**完整演练一次「发布 → 验证 → 回滚 → 验证」**——
按 §2–§4 发布任一版本并通过 §4 全部验证项，再按 §5 一键回滚且 `GET /api/health` 恢复。

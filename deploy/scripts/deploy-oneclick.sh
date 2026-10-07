#!/usr/bin/env bash
# =============================================================================
# anitexas 一键部署（在服务器上以 root 运行）——「包 + 本脚本」两个文件就够
#
# 流程：校验发布包 → 首次自动引导(用户/目录/单元/env) → 解到 releases/<版本>
#       → 备份 SQLite → 原子切 current → 重启 → 探活 /api/health → 失败自动回滚
#
# 用法（把 anitexas-<版本>.tar.zst(+.sha256) 与本脚本放同一目录）：
#   sudo ./deploy-oneclick.sh                 # 自动找同目录的 anitexas-*.tar.zst
#   sudo ./deploy-oneclick.sh /tmp/anitexas-2026.10.05-1.tar.zst
#   sudo ./deploy-oneclick.sh --rollback      # 一键回滚到 previous
#
# 可覆盖的环境变量（不确定就别设）：
#   ANITEXAS_APP_ROOT   默认 /opt/anitexas
#   ANITEXAS_DATA_ROOT  默认 /data/anitexas
#   ANITEXAS_SERVICE    默认 anitexas
#   ANITEXAS_READY_URL  默认 http://127.0.0.1:8081/api/health
#   ANITEXAS_KEEP       保留的历史 release 份数（默认 5）
#   SKIP_VERIFY=1       跳过 sha256 校验
#
# 前置：nginx 已按「单 :80 三站合一（/anitexas/ 子路径）」配好；本脚本只管应用本身。
# =============================================================================
set -Eeuo pipefail

APP_ROOT="${ANITEXAS_APP_ROOT:-/opt/anitexas}"
DATA_ROOT="${ANITEXAS_DATA_ROOT:-/data/anitexas}"
SERVICE="${ANITEXAS_SERVICE:-anitexas}"
READY_URL="${ANITEXAS_READY_URL:-http://127.0.0.1:8081/api/health}"
KEEP="${ANITEXAS_KEEP:-5}"
DB_PATH="$DATA_ROOT/anitexas.db"
BACKUP_DIR="$DATA_ROOT/backups"

WORK_DIR=""
CURRENT_TARGET=""

c_info() { printf '\033[36m>>\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[32mOK\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m!!\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31mXX\033[0m %s\n' "$*" >&2; }
die()    { c_err "$*"; exit 1; }

cleanup() {
  local rc=$?
  [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]] && rm -rf "$WORK_DIR" || true
  exit $rc
}
trap cleanup EXIT

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then sed -n '2,26p' "$0"; exit 0; fi
[[ ${EUID:-$(id -u)} -eq 0 ]] || die "请用 root 运行：sudo $0"

# ---------------------------------------------------------------------------
# 回滚模式：current ← previous，重启 + 探活
# ---------------------------------------------------------------------------
wait_ready() {
  local i
  for i in $(seq 1 30); do
    curl -fsS --max-time 2 "$READY_URL" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

if [[ "${1:-}" == "--rollback" ]]; then
  [[ -L "$APP_ROOT/previous" ]] || die "没有可回滚的 previous（$APP_ROOT/previous 不存在）"
  PREV="$(readlink -f "$APP_ROOT/previous")"
  CUR=""; [[ -L "$APP_ROOT/current" ]] && CUR="$(readlink -f "$APP_ROOT/current")"
  ln -s "$PREV" "$APP_ROOT/current.next"
  mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
  [[ -n "$CUR" ]] && ln -sfn "$CUR" "$APP_ROOT/previous"
  systemctl restart "$SERVICE"
  if wait_ready; then c_ok "已回滚到 $(basename "$PREV")"; else die "回滚后探活失败"; fi
  exit 0
fi

# ---------------------------------------------------------------------------
# 0) 找发布包
# ---------------------------------------------------------------------------
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" ]]; then
  CANDIDATES=()
  for d in "$SELF_DIR" "$PWD"; do
    [[ -d "$d" ]] || continue
    while IFS= read -r f; do [[ -n "$f" ]] && CANDIDATES+=("$f"); done \
      < <(find "$d" -maxdepth 1 -name 'anitexas-*.tar.zst' 2>/dev/null | sort)
  done
  [[ ${#CANDIDATES[@]} -gt 0 ]] || die "没找到发布包：把 anitexas-*.tar.zst 放到脚本同目录，或作为参数传入"
  ARCHIVE="${CANDIDATES[-1]}"
  [[ ${#CANDIDATES[@]} -gt 1 ]] && c_warn "找到多个发布包，用最后一个：$ARCHIVE"
fi
[[ -f "$ARCHIVE" ]] || die "发布包不存在：$ARCHIVE"

# ---------------------------------------------------------------------------
# 1) 校验 sha256（同名 .sha256 存在就核对）
# ---------------------------------------------------------------------------
if [[ "${SKIP_VERIFY:-0}" != "1" && -f "$ARCHIVE.sha256" ]]; then
  EXPECTED="$(awk '{print $1}' "$ARCHIVE.sha256" | head -1 | tr 'A-Z' 'a-z')"
  ACTUAL="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
  [[ "$EXPECTED" == "$ACTUAL" ]] || die "校验和不匹配（期望 $EXPECTED 实际 $ACTUAL）"
  c_ok "校验和通过：${ACTUAL:0:16}..."
else
  c_warn "未做校验和核对（缺 $ARCHIVE.sha256）"
fi

# ---------------------------------------------------------------------------
# 2) 解包到暂存，判定版本 + 校验三件套
# ---------------------------------------------------------------------------
command -v tar >/dev/null 2>&1 || die "缺少 tar"
WORK_DIR="$(mktemp -d /tmp/anitexas-deploy-XXXXXX)"
tar --zstd -xf "$ARCHIVE" -C "$WORK_DIR" 2>/dev/null || die "解包失败（缺 zstd 支持？yum install -y zstd）"

VERSION="$(cat "$WORK_DIR/VERSION" 2>/dev/null || true)"
if [[ -z "$VERSION" ]]; then
  VERSION="$(basename "$ARCHIVE" | sed -E 's/^anitexas-(.*)\.tar\.zst$/\1/')"
fi
case "$VERSION" in *[!A-Za-z0-9._-]*|'') die "版本号非法：$VERSION" ;; esac

[[ -f "$WORK_DIR/anitexas-server" ]] || die "包内缺 anitexas-server"
[[ -f "$WORK_DIR/cards.json" ]]      || die "包内缺 cards.json"
[[ -f "$WORK_DIR/dist/index.html" ]] || die "包内缺 dist/index.html"
RELEASE_DIR="$APP_ROOT/releases/$VERSION"
[[ -e "$RELEASE_DIR" ]] && die "该版本已存在：$RELEASE_DIR（换个版本号或先删旧目录）"
c_info "版本：$VERSION → $RELEASE_DIR"

# ---------------------------------------------------------------------------
# 3) 首次引导（幂等）：用户 / 目录 / env / systemd 单元
# ---------------------------------------------------------------------------
if ! id -u anitexas >/dev/null 2>&1; then
  c_info "创建系统用户 anitexas"
  useradd --system --home "$APP_ROOT" --shell /usr/sbin/nologin anitexas
fi
mkdir -p "$APP_ROOT/releases" "$APP_ROOT/incoming" "$APP_ROOT/shared" "$BACKUP_DIR"
chown -R anitexas:anitexas "$APP_ROOT" "$DATA_ROOT"

ENV_FILE="$APP_ROOT/shared/anitexas.env"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$WORK_DIR/anitexas.env.example" ]]; then
    c_info "写入环境变量模板：$ENV_FILE（按需再改）"
    cp "$WORK_DIR/anitexas.env.example" "$ENV_FILE"
  else
    c_warn "包内无 anitexas.env.example，写入最小可用 env"
    cat > "$ENV_FILE" <<EOF
APP_ENV=production
BIND_ADDR=127.0.0.1
PORT=8081
LOG_LEVEL=info
CORS_ALLOWED_ORIGINS=
DATA_DIR=$DATA_ROOT
DB_PATH=$DB_PATH
CARDS_PATH=$APP_ROOT/current/cards.json
ROOM_DEFAULT_AUTO_REVEAL=false
ROOM_DEFAULT_SEATS=4
ROOM_DEFAULT_SMALL_BLIND=1
ROOM_DEFAULT_BIG_BLIND=2
ROOM_DEFAULT_CHIPS=200
ROOM_DEFAULT_DECK_STRATEGY=stratified
ROOM_DEFAULT_DECK_SIZE=78
ROOM_DEFAULT_MIN_VOTES=2000
ROOM_DEFAULT_REVEAL_FEE=0
TURN_TIMEOUT_SECONDS=30
EOF
  fi
  chown anitexas:anitexas "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  c_ok "环境变量已存在，保留不动：$ENV_FILE"
fi

UNIT=/etc/systemd/system/$SERVICE.service
if [[ ! -f "$UNIT" ]]; then
  [[ -f "$WORK_DIR/anitexas.service" ]] || die "包内缺 anitexas.service（请用新版 build-release.sh 重打包）"
  c_info "安装 systemd 单元：$UNIT"
  cp "$WORK_DIR/anitexas.service" "$UNIT"
  systemctl daemon-reload
  systemctl enable "$SERVICE"
fi

# ---------------------------------------------------------------------------
# 4) 落盘 release + 备份 DB
# ---------------------------------------------------------------------------
mkdir -p "$RELEASE_DIR"
cp -a "$WORK_DIR/." "$RELEASE_DIR/"
chmod 0755 "$RELEASE_DIR/anitexas-server"
chown -R anitexas:anitexas "$RELEASE_DIR"
c_ok "release 已落盘"

if [[ -f "$DB_PATH" ]]; then
  DB_BAK="$BACKUP_DIR/anitexas.db.$(date -u +%Y%m%dT%H%M%SZ)-$VERSION"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" ".backup '$DB_BAK'"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$DB_PATH" "$DB_BAK" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1]); dst = sqlite3.connect(sys.argv[2]); src.backup(dst); dst.close(); src.close()
PY
  else
    cp -p "$DB_PATH" "$DB_BAK" 2>/dev/null || true
    c_warn "无 sqlite3/python3，用 cp 备份（WAL 期间可能不一致）"
  fi
  chown anitexas:anitexas "$DB_BAK" 2>/dev/null || true
  c_ok "数据库已备份：$DB_BAK"
else
  c_warn "数据库不存在（首装正常），跳过：$DB_PATH"
fi

# ---------------------------------------------------------------------------
# 5) 切 current → 重启 → 探活（失败回滚）
# ---------------------------------------------------------------------------
[[ -L "$APP_ROOT/current" ]] && CURRENT_TARGET="$(readlink -f "$APP_ROOT/current")"
if [[ -n "$CURRENT_TARGET" ]]; then ln -sfn "$CURRENT_TARGET" "$APP_ROOT/previous"; fi
ln -s "$RELEASE_DIR" "$APP_ROOT/current.next"
mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
c_ok "current → $(basename "$RELEASE_DIR")"

rollback() {
  c_warn "回滚中…"
  if [[ -n "$CURRENT_TARGET" ]]; then
    ln -s "$CURRENT_TARGET" "$APP_ROOT/current.next"
    mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
    systemctl restart "$SERVICE" || true
    c_warn "已回滚到 $(basename "$CURRENT_TARGET")（DB 未改动）"
  else
    c_warn "无上一版本可回滚（首装失败，请检查日志）"
  fi
}

c_info "重启 $SERVICE"
if ! systemctl restart "$SERVICE"; then rollback; die "重启失败，已回滚"; fi
if wait_ready; then
  c_ok "健康检查通过：$(curl -fsS --max-time 2 "$READY_URL" 2>/dev/null || true)"
else
  c_err "30s 内 $READY_URL 未就绪，最近日志："
  journalctl -u "$SERVICE" -n 20 --no-pager || true
  rollback
  die "部署失败，已回滚"
fi

# ---------------------------------------------------------------------------
# 6) 清理旧 release（保留最近 KEEP 份 + current/previous 指向的）
# ---------------------------------------------------------------------------
if [[ "$KEEP" =~ ^[0-9]+$ && "$KEEP" -gt 0 ]]; then
  KEEP_LIST=()
  [[ -n "$CURRENT_TARGET" ]] && KEEP_LIST+=("$(basename "$CURRENT_TARGET")")
  KEEP_LIST+=("$(basename "$(readlink -f "$APP_ROOT/current")")")
  while IFS= read -r d; do
    n="$(basename "$d")"
    for k in "${KEEP_LIST[@]}"; do [[ "$n" == "$k" ]] && continue 2; done
    c_info "清理旧 release：$n"
    rm -rf "$d"
  done < <(find "$APP_ROOT/releases" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -r | tail -n +$((KEEP+1)))
fi

printf '\n'
c_ok "部署完成：$VERSION"
c_info "验证：curl -fsS $READY_URL"
c_info "外网：http://<IP>/anitexas/（nginx 需为单 :80 子路径那份）"
c_info "回滚：sudo $0 --rollback"

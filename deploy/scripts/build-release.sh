#!/usr/bin/env bash
# =============================================================================
# anitexas 打发布包（在开发机/CI 上运行，产物交给服务器上的 deploy-oneclick.sh）
#
# 产出（落在仓库根目录）：
#   anitexas-<版本>.tar.zst          整包：anitexas-server + cards.json + dist/ + VERSION
#   anitexas-<版本>.tar.zst.sha256   校验和（deploy-oneclick.sh 会核对）
#
# 用法：
#   ./build-release.sh                 # 版本号默认 <日期>-1，如 2026.10.05-1
#   ./build-release.sh 2026.10.05-3    # 指定版本号（写进发布包 VERSION）
#
# 环境变量：
#   SKIP_TESTS=1    跳过 go test / 前端单测（赶时间时用，不推荐）
#   BUILD_CARDS=1   先跑 scripts/build_cards.py 重建 data/cards.json（需 dump，慢）
#   TAR=...         指定带 zstd 的 tar（Windows Git Bash 下用 /c/Windows/System32/tar.exe）
#   GOOS/GOARCH     交叉编译目标（默认 linux/amd64，与线上一致）
#
# 与 karuta 的分工一致：本脚本只管「构建 + 打包」，服务器侧的原子切换/探活/回滚
# 由 deploy/scripts/deploy-oneclick.sh 负责（见 deploy/README.md）。
# =============================================================================
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${1:-$(date -u +%Y.%m.%d)-1}"
TAR="${TAR:-tar}"
GOOS="${GOOS:-linux}"
GOARCH="${GOARCH:-amd64}"

c_info() { printf '\033[36m>>\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[32mOK\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m!!\033[0m %s\n' "$*"; }
die()    { printf '\033[31mXX\033[0m %s\n' "$*" >&2; exit 1; }

case "$VERSION" in
  *[!A-Za-z0-9._-]*|'') die "版本号只能含字母/数字/._-：$VERSION" ;;
esac

command -v go  >/dev/null 2>&1 || die "缺少 go"
command -v npm >/dev/null 2>&1 || die "缺少 npm"

# tar 需要 zstd 支持（GNU tar + zstd 或 bsdtar）；Windows Git Bash 自带的 tar 不支持
probe_tar() { # 真打一个临时包做往返验证，比看 --help 可靠
  local t="$1" tmpd rc
  tmpd="$(mktemp -d)" || return 1
  ( cd "$tmpd" && printf 'x' > probe.txt && "$t" --zstd -cf out.tar.zst probe.txt ) >/dev/null 2>&1
  rc=$?
  rm -rf "$tmpd"
  return $rc
}
if ! probe_tar "$TAR"; then
  for c in /c/Windows/System32/tar.exe /mnt/c/Windows/System32/tar.exe; do
    if [[ -x "$c" ]] && probe_tar "$c"; then TAR="$c"; break; fi
  done
fi
if ! probe_tar "$TAR"; then
  die "当前 tar 不支持 --zstd（Linux: yum install -y zstd；Windows: TAR=/c/Windows/System32/tar.exe ./build-release.sh $VERSION）"
fi

cd "$ROOT"
c_info "仓库根目录：$ROOT"
c_info "版本号：$VERSION（目标平台 $GOOS/$GOARCH）"

# ---------------------------------------------------------------------------
# 1) 卡池产物：默认要求 data/cards.json 已存在（产物随包版本化，见 architecture.md §4.6）
#    BUILD_CARDS=1 时先重跑管线（需要 dump；同 dump 同配置可复现）
# ---------------------------------------------------------------------------
if [[ "${BUILD_CARDS:-0}" == "1" ]]; then
  command -v python >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1 || die "缺少 python"
  c_info "重建卡池：python scripts/build_cards.py"
  if command -v python >/dev/null 2>&1; then python scripts/build_cards.py >/dev/null; else python3 scripts/build_cards.py >/dev/null; fi
  c_ok "卡池已重建"
fi
[[ -f data/cards.json ]] || die "缺少 data/cards.json：先跑 python scripts/build_cards.py（或 BUILD_CARDS=1 ./build-release.sh $VERSION）"
c_ok "卡池产物：data/cards.json（$(stat -c%s data/cards.json 2>/dev/null || stat -f%z data/cards.json) B）"

# ---------------------------------------------------------------------------
# 2) 测试（默认跑，SKIP_TESTS=1 跳过）
# ---------------------------------------------------------------------------
if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
  c_info "后端测试 go test ./..."
  ( cd backend && go test ./... >/dev/null )
  c_ok "后端测试通过"
  c_info "前端检查（单测）"
  ( cd frontend && [[ -d node_modules ]] || npm ci )
  ( cd frontend && NODE_ENV=test npx vitest run --reporter=basic >/dev/null )
  c_ok "前端检查通过"
else
  c_warn "已跳过测试（SKIP_TESTS=1）"
fi

# ---------------------------------------------------------------------------
# 3) 前端生产构建 → data/dist（vite outDir=../data/dist）
# ---------------------------------------------------------------------------
c_info "构建前端（vite build → data/dist）"
( cd frontend && [[ -d node_modules ]] || npm ci )
( cd frontend && npm run build >/dev/null )
c_ok "前端产物：data/dist"

# ---------------------------------------------------------------------------
# 4) 交叉编译线上二进制（纯 Go SQLite，CGO_ENABLED=0 可静态编）
# ---------------------------------------------------------------------------
c_info "交叉编译 anitexas-server（CGO_ENABLED=0 GOOS=$GOOS GOARCH=$GOARCH）"
rm -rf release
mkdir -p release/dist
( cd backend &&
  CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" go build -trimpath \
    -ldflags "-s -w" -o ../release/anitexas-server ./cmd/server ) || die "anitexas-server 编译失败"
c_ok "二进制：release/anitexas-server"

cp -R data/dist/. release/dist/
cp data/cards.json release/cards.json
# 随包带上部署资产：deploy-oneclick.sh 首装时用它引导（单元 + env 模板）
cp deploy/systemd/anitexas.service release/anitexas.service
cp deploy/anitexas.env.example release/anitexas.env.example
printf '%s\n' "$VERSION" > release/VERSION

# ---------------------------------------------------------------------------
# 5) 打包 + 校验和
# ---------------------------------------------------------------------------
FULL="anitexas-$VERSION.tar.zst"
rm -f "$FULL" "$FULL.sha256"

c_info "打包：$FULL"
"$TAR" --zstd -cf "$FULL" -C release .

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}
printf '%s  %s\n' "$(sha256_of "$FULL")" "$FULL" > "$FULL.sha256"

# ---------------------------------------------------------------------------
# 6) 结果
# ---------------------------------------------------------------------------
printf '\n'
c_ok "打包完成"
printf '  %-34s %12s B  %s\n' "$FULL" "$(stat -c%s "$FULL" 2>/dev/null || stat -f%z "$FULL")" "$(awk '{print substr($1,1,16)}' "$FULL.sha256")..."
printf '  包内：anitexas-server / cards.json / dist/ / VERSION / anitexas.service / anitexas.env.example\n'
printf '  前端主 JS：%s\n' "$(grep -o 'assets/index-[A-Za-z0-9._-]*\.js' data/dist/index.html | head -1)"
printf '\n'
c_info "一键部署：把「本包 + 同名 .sha256 + deploy-oneclick.sh」丢到服务器同一目录，然后："
c_info "  sudo ./deploy-oneclick.sh（回滚：sudo ./deploy-oneclick.sh --rollback）"

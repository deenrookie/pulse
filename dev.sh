#!/usr/bin/env bash
# Pulse 一键开发环境：Go 后端 + Vite 热更新前端，Ctrl+C 一并停止。
# 前置：go 1.25+、node 18+（macOS / Linux / Git Bash）。
#
# 用法：
#   ./dev.sh                 # 控制台 http://127.0.0.1:5175（热更新），代理 :8080
#   PROXY_PORT=9090 ./dev.sh # 换代理端口
#
# 注意：UI 端口固定 8000 —— web/vite.config.ts 的 /api 代理指向它；
# 改 UI 端口需同步修改 vite.config.ts。
set -euo pipefail
cd "$(dirname "$0")"

UI_ADDR="127.0.0.1:8000"
PROXY_PORT="${PROXY_PORT:-8080}"
DATA_DIR="${DATA_DIR:-$HOME/.pulse-dev}"
# 编译产物放仓库根的隐藏文件（含斜杠才会被当作路径而非 PATH 命令），退出时删除
BIN="./.pulse-dev-bin.$$"

fail() { echo "✗ $1" >&2; exit 1; }
command -v go >/dev/null 2>&1 || fail "需要 go（1.25+）：brew install go"
command -v node >/dev/null 2>&1 || fail "需要 node（18+）：brew install node"
go version | grep -q 'go1\.' || fail "go 版本无法识别"

BACK_PID=""
FRONT_PID=""
cleanup() {
  trap - INT TERM EXIT
  [ -n "$FRONT_PID" ] && kill "$FRONT_PID" 2>/dev/null
  [ -n "$BACK_PID" ] && kill "$BACK_PID" 2>/dev/null
  rm -f "$BIN"
  echo ""
  echo "▪ 已停止"
}
trap cleanup INT TERM EXIT

echo "▸ 前端依赖（首次运行会安装，之后跳过）"
[ -d web/node_modules ] || (cd web && npm install)

echo "▸ 编译后端"
go build -o "$BIN" ./cmd/pulse

echo "▸ 启动后端  UI http://$UI_ADDR  代理 :$PROXY_PORT  数据 $DATA_DIR"
"$BIN" --ui "$UI_ADDR" --proxy "127.0.0.1:$PROXY_PORT" --data-dir "$DATA_DIR" &
BACK_PID=$!

echo "▸ 启动前端（Vite 热更新）"
# exec 直连 vite（绕过 npm 包装进程），kill 时才能干净停掉
(cd web && exec ./node_modules/.bin/vite) &
FRONT_PID=$!

echo ""
echo "  控制台（带热更新）: http://127.0.0.1:5175"
echo "  代理:              127.0.0.1:$PROXY_PORT   （浏览器代理指向这里）"
echo "  Ctrl+C 停止全部"
echo ""

# 后端退出（崩溃/端口冲突）时整体收摊；Ctrl+C 走 trap
wait "$BACK_PID"
echo "✗ 后端已退出" >&2
exit 1

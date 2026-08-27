#!/bin/sh
set -e

export CONFIG_DIR="/app/config"
export DATA_DIR="/app/data"
# 前端是静态导出，由 API 进程托管；界面和 API 同一个端口
export FRONTEND_DIR="/app/frontend"
export BACKEND_PORT="${BACKEND_PORT:-3000}"
mkdir -p "$CONFIG_DIR" "$DATA_DIR"

# 两个进程各跑各的：代理和管理端隔离，管理端崩了不影响播放。
# 任一进程退出就让容器整体退出，交给 restart 策略拉起来。
echo "Starting API + web UI on :$BACKEND_PORT..."
node /app/backend/dist/index.js &
backend_pid=$!

echo "Starting Emby proxy..."
node /app/backend/dist/proxy.js &
proxy_pid=$!

terminate() {
  kill "$backend_pid" "$proxy_pid" 2>/dev/null || true
  wait
}
trap terminate TERM INT

# 等任意一个子进程退出（BusyBox sh 不支持 wait -n，轮询代替）
while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$proxy_pid" 2>/dev/null; do
  sleep 2
done

echo "One of the processes exited, shutting down."
terminate
exit 1

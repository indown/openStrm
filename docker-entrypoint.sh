#!/bin/sh
set -e

export CONFIG_DIR="/app/config"
export DATA_DIR="/app/data"
mkdir -p "$CONFIG_DIR" "$DATA_DIR"

# 三个进程各跑各的：代理和管理端隔离，管理端崩了不影响播放。
# 任一进程退出就让容器整体退出，交给 restart 策略拉起来。
echo "Starting backend..."
node /app/backend/dist/index.js &
backend_pid=$!

echo "Starting Emby proxy..."
node /app/backend/dist/proxy.js &
proxy_pid=$!

echo "Starting frontend..."
# monorepo 的 standalone 产物是嵌套的，入口在 apps/frontend/ 下
PORT=3000 node /app/frontend/apps/frontend/server.js &
frontend_pid=$!

terminate() {
  kill "$backend_pid" "$proxy_pid" "$frontend_pid" 2>/dev/null || true
  wait
}
trap terminate TERM INT

# 等任意一个子进程退出（BusyBox sh 不支持 wait -n，轮询代替）
while kill -0 "$backend_pid" 2>/dev/null &&
      kill -0 "$proxy_pid" 2>/dev/null &&
      kill -0 "$frontend_pid" 2>/dev/null; do
  sleep 2
done

echo "One of the processes exited, shutting down."
terminate
exit 1

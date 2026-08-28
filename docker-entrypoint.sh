#!/bin/sh
set -e

# 容器内路径。可以用环境变量覆盖（比如 /config 的 *arr 惯例），记得同时改挂载
export CONFIG_DIR="${CONFIG_DIR:-/app/config}"
export DATA_DIR="${DATA_DIR:-/app/data}"
# 前端是静态导出，由 API 进程托管；界面和 API 同一个端口
export FRONTEND_DIR="${FRONTEND_DIR:-/app/frontend}"
export BACKEND_PORT="${BACKEND_PORT:-3000}"
mkdir -p "$CONFIG_DIR" "$DATA_DIR"

# 设了 PUID 就用那个身份跑两个进程（PGID 缺省同 PUID）；没设保持 root，老部署不用动。
# config 里只有一个库文件，整个改归属；data 可能几万个 strm，只改目录本身——
# 之前用 root 跑出来的文件请自己 chown 一次。
run_as=""
if [ -n "${PUID:-}" ]; then
  PGID="${PGID:-$PUID}"
  chown -R "$PUID:$PGID" "$CONFIG_DIR"
  chown "$PUID:$PGID" "$DATA_DIR"
  run_as="su-exec $PUID:$PGID"
  echo "Running as $PUID:$PGID"
fi

# 两个进程各跑各的：代理和管理端隔离，管理端崩了不影响播放。
# 任一进程退出就让容器整体退出，交给 restart 策略拉起来。
echo "Starting API + web UI on :$BACKEND_PORT..."
$run_as node --enable-source-maps /app/backend/dist/index.js &
backend_pid=$!

echo "Starting Emby proxy..."
$run_as node --enable-source-maps /app/backend/dist/proxy.js &
proxy_pid=$!

stopping=0
terminate() {
  stopping=1
  kill "$backend_pid" "$proxy_pid" 2>/dev/null || true
  wait
}
trap terminate TERM INT

# 等任意一个子进程退出（BusyBox sh 不支持 wait -n，轮询代替）
while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$proxy_pid" 2>/dev/null; do
  sleep 2
done

# docker stop 走的是上面的 trap：正常停机要以 0 退出，不然 docker ps 里永远是 Exited (1)
if [ "$stopping" = 1 ]; then
  exit 0
fi

echo "One of the processes exited, shutting down."
terminate
exit 1

#!/usr/bin/env bash
#
# 起一套一次性的 Emby 实验环境，给 proxy.e2e.ts 用。
#
#   ./scripts/emby-lab.sh up      起 Emby + strm 媒体库 + 直链桩，打印环境变量
#   ./scripts/emby-lab.sh main    额外起 main 分支的 nginx/njs 栈，用于 A/B 对照
#   ./scripts/emby-lab.sh down    全部清理
#
# 为什么需要它：代理层踩过的坑几乎都跟真 Emby 的响应形状有关
# （MediaSource.Id 的 mediasource_ 前缀、strm 条目的 Container、
# PlaybackInfo 默认给 TranscodingUrl），假 Emby 验不出来。
set -euo pipefail

LAB="${LAB_DIR:-/tmp/openstrm-emby-lab}"
EMBY_PORT="${EMBY_PORT:-8096}"
STUB_PORT="${STUB_PORT:-8000}"
NGINX_PORT="${NGINX_PORT:-8091}"
MOUNT="${MOUNT:-/mnt/pan}"
# Docker Desktop 里容器看宿主机的地址
HOST_IP="${HOST_IP:-192.168.65.254}"
# 桩返回的直链：文件名已转义、签名带 + 和 =，和 115 真实返回同形态。
# 里面不含单引号，下面直接嵌进生成的 JS 单引号串（别用 ${VAR@Q}，macOS 的 bash 3.2 不支持）
RAW_LINK='https://cdn-qn.115.com/lab/%E4%B8%AD%E6%96%87%E5%90%8D.mkv?t=1&u=a%2Bb&sign=xY%3D%3D'

PLATFORM="${PLATFORM:---platform linux/amd64}"

log() { printf '\033[36m[lab]\033[0m %s\n' "$*"; }

media_fixtures() {
  mkdir -p "$LAB/config" "$LAB/media/tv/测试剧集/Season 1" "$LAB/media/movies"
  # strm 内容 = 挂载前缀 + 115 路径。用中文是故意的：直链转义的 bug 就死在这
  printf '%s' "$MOUNT/tv/测试剧集/S01E01 中文名.mkv" \
    > "$LAB/media/tv/测试剧集/Season 1/S01E01.strm"
  printf '%s' "$MOUNT/tv/测试剧集/S01E02 中文名.mkv" \
    > "$LAB/media/tv/测试剧集/Season 1/S01E02.strm"
  # 一个真正的本地文件，用来确认它不会被误 302
  [ -f "$LAB/media/movies/本地电影.mp4" ] || head -c 200000 /dev/urandom > "$LAB/media/movies/本地电影.mp4"
}

start_stub() {
  cat > "$LAB/stub-fs-get.cjs" <<EOF
const http = require("http");
const RAW = '$RAW_LINK';
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url.startsWith("/api/fs/get")) { res.writeHead(404); return res.end(); }
    if ((req.headers.authorization || "") !== "lab-token") {
      res.writeHead(401, {"content-type":"application/json"});
      return res.end(JSON.stringify({ code: 401, message: "unauthorized" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 200, message: "success",
      data: { raw_url: RAW, name: "中文名.mkv", provider: "115" } }));
  });
}).listen($STUB_PORT, "0.0.0.0");
EOF
  pkill -f "$LAB/stub-fs-get.cjs" 2>/dev/null || true
  node "$LAB/stub-fs-get.cjs" > "$LAB/stub.log" 2>&1 &
  log "直链桩已起在 :$STUB_PORT"
}

wait_for() {
  local url="$1" tries="${2:-90}"
  for _ in $(seq 1 "$tries"); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" = "200" ] && return 0
    sleep 2
  done
  return 1
}

up() {
  media_fixtures
  start_stub

  log "启动 Emby (amilys/embyserver)"
  docker rm -f emby-lab >/dev/null 2>&1 || true
  docker run -d --name emby-lab $PLATFORM -p "$EMBY_PORT:8096" \
    -v "$LAB/config":/config -v "$LAB/media":/media -e UID=0 -e GID=0 \
    amilys/embyserver:latest >/dev/null
  wait_for "http://127.0.0.1:$EMBY_PORT/System/Info/Public" || { log "Emby 起不来"; exit 1; }

  local E="http://127.0.0.1:$EMBY_PORT"
  local AUTH='X-Emby-Authorization: MediaBrowser Client="lab", Device="cli", DeviceId="lab-1", Version="1.0.0"'

  log "过启动向导"
  curl -s -o /dev/null -X POST "$E/Startup/Configuration" -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"UICulture":"zh-cn","MetadataCountryCode":"CN","PreferredMetadataLanguage":"zh"}'
  curl -s -o /dev/null -X POST "$E/Startup/User" -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"Name":"lab","Password":"labpass123"}'
  curl -s -o /dev/null -X POST "$E/Startup/Complete" -H "$AUTH"

  local login token userid apikey
  login=$(curl -s -X POST "$E/Users/AuthenticateByName" -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"Username":"lab","Pw":"labpass123"}')
  token=$(printf '%s' "$login" | python3 -c 'import sys,json;print(json.load(sys.stdin)["AccessToken"])')
  userid=$(printf '%s' "$login" | python3 -c 'import sys,json;print(json.load(sys.stdin)["User"]["Id"])')
  curl -s -o /dev/null -X POST "$E/Auth/Keys?App=openstrm" -H "X-Emby-Token: $token"
  apikey=$(curl -s "$E/Auth/Keys" -H "X-Emby-Token: $token" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["Items"][0]["AccessToken"])')

  log "建媒体库并扫描"
  curl -s -o /dev/null -X POST "$E/Library/VirtualFolders?name=LabTV&collectionType=tvshows&api_key=$apikey" \
    -H 'Content-Type: application/json' \
    -d '{"LibraryOptions":{"PathInfos":[{"Path":"/media/tv"}],"EnableInternetProviders":false}}'
  curl -s -o /dev/null -X POST "$E/Library/VirtualFolders?name=LabMovies&collectionType=movies&api_key=$apikey" \
    -H 'Content-Type: application/json' \
    -d '{"LibraryOptions":{"PathInfos":[{"Path":"/media/movies"}],"EnableInternetProviders":false}}'
  curl -s -o /dev/null -X POST "$E/Library/Refresh?api_key=$apikey"

  local strm_id="" local_id=""
  for _ in $(seq 1 40); do
    local items
    items=$(curl -s "$E/Items?Recursive=true&IncludeItemTypes=Episode,Movie&Fields=Path,MediaSources&api_key=$apikey")
    strm_id=$(printf '%s' "$items" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print(next((i["Id"] for i in d.get("Items",[])
  if (i.get("MediaSources") or [{}])[0].get("Path","").startswith("'"$MOUNT"'")), ""))' 2>/dev/null || true)
    local_id=$(printf '%s' "$items" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print(next((i["Id"] for i in d.get("Items",[])
  if (i.get("MediaSources") or [{}])[0].get("Path","").startswith("/media/")), ""))' 2>/dev/null || true)
    [ -n "$strm_id" ] && [ -n "$local_id" ] && break
    sleep 3
  done
  [ -n "$strm_id" ] || { log "没扫到 strm 条目"; exit 1; }

  cat > "$LAB/env.sh" <<EOF
export EMBY_URL=http://127.0.0.1:$EMBY_PORT
export EMBY_API_KEY=$apikey
export EMBY_USER_ID=$userid
export STRM_ITEM_ID=$strm_id
export LOCAL_ITEM_ID=$local_id
export MOUNT=$MOUNT
export STUB_FS_GET=http://127.0.0.1:$STUB_PORT
EOF
  log "环境就绪，变量写在 $LAB/env.sh"
  cat "$LAB/env.sh"
}

# 起 main 分支的 nginx/njs 栈，做 A/B 对照
main_stack() {
  [ -f "$LAB/env.sh" ] || { log "先跑 up"; exit 1; }
  # shellcheck disable=SC1091
  . "$LAB/env.sh"

  rm -rf "$LAB/mainstack" && mkdir -p "$LAB/mainstack" "$LAB/appconfig"
  git archive main emby2Alist | tar -x -C "$LAB/mainstack"
  local N="$LAB/mainstack/emby2Alist/nginx"
  mkdir -p "$N/embyCache" "$N/log"

  # main 的 constant.js 从这里读 Emby 地址
  cat > "$LAB/appconfig/settings.json" <<EOF
{"emby":{"url":"http://$HOST_IP:$EMBY_PORT","apiKey":"$EMBY_API_KEY"},
 "mediaMountPath":["$MOUNT"],"internalToken":"lab-token"}
EOF
  # 复刻 main entrypoint 的 token 注入，并把 alistAddr 指向桩
  python3 - "$N/conf.d/config/constant-mount.js" "$HOST_IP:$STUB_PORT" <<'PY'
import re, sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
s = re.sub(r'const alistAddr = "[^"]*";', f'const alistAddr = "http://{sys.argv[2]}";', s)
s = s.replace("openstrm-internal-token", "lab-token")
p.write_text(s)
PY
  rm -f "$N/conf.d/openstrm.conf"   # 前端反代，对照用不上

  docker rm -f nginx-emby-lab >/dev/null 2>&1 || true
  docker run -d --name nginx-emby-lab $PLATFORM -p "$NGINX_PORT:8091" \
    --add-host host.docker.internal:host-gateway \
    -v "$N/nginx.conf":/etc/nginx/nginx.conf:ro \
    -v "$N/conf.d":/etc/nginx/conf.d:ro \
    -v "$N/embyCache":/var/cache/nginx/emby \
    -v "$N/log":/var/log/nginx \
    -v "$LAB/appconfig":/app/config:ro \
    nginx:1.27.1 >/dev/null
  sleep 3
  echo "export MAIN_PROXY=http://127.0.0.1:$NGINX_PORT" >> "$LAB/env.sh"
  log "main 的 nginx 栈已起在 :${NGINX_PORT}，MAIN_PROXY 已加进 env.sh"
}

down() {
  docker rm -f emby-lab nginx-emby-lab >/dev/null 2>&1 || true
  pkill -f "$LAB/stub-fs-get.cjs" 2>/dev/null || true
  log "已清理容器与桩（$LAB 保留，需要的话自己删）"
}

case "${1:-up}" in
  up) up ;;
  main) main_stack ;;
  down) down ;;
  *) echo "用法: $0 {up|main|down}"; exit 1 ;;
esac

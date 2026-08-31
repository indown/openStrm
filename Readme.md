<div align="center">
  <img src="apps/frontend/public/logo.png" alt="OpenStrm Logo" width="200" height="200">
</div>

# OpenStrm

一个开源的 **Strm 生成工具**。不完全使用指南：[文档地址](https://www.yuque.com/aitiaodetuzi/ueexc2/ynkwg2flhsvf233c)

> **安全提示**：Next.js 的 [CVE-2025-66478](https://nextjs.org/blog/CVE-2025-66478)（React2Shell，CVSS 10.0，可导致远程代码执行）影响使用 App Router 的 Next.js 15.x / 16.x。本项目锁定的 `next@15.4.8` 正是官方公告列出的 15.4.x 线修复版本，**当前版本不受影响**。仍在使用 v0.2.4 及更早版本的请尽快升级；那些版本若曾以未修复状态暴露在公网，建议轮换应用密钥。

## ✨ 为什么做这个软件

希望此项目能帮助大家更简单创建的自己strm库。  

该项目的目标是：**开放、简洁、可改造**。  

本项目参考或依赖以下项目： 
- [p115client](https://github.com/ChenyangGao/p115client/)
- [Alist](https://github.com/alist-org/alist)  
- [Openlist](https://github.com/OpenListTeam/OpenList)  
- [embyExternalUrl](https://github.com/bpking1/embyExternalUrl)  
- [rclone](https://github.com/rclone/rclone)  

## 🚀 特性

- 开源自由
- 支持批量生成 `.strm` 文件
- 支持自定义前缀（方便配合媒体服务器使用）
- 基于115目录树生成
- 115 云下载：磁力 / ed2k / http 链接交给 115 云端下载，下到任务目录后自动生成 strm
- 支持账号级限流和重试逻辑
- 轻量，无额外依赖，易于二次开发

## 🎬 Emby 302 直链

命中挂载点的媒体不再由本服务中转字节，而是 302 到 115 直链，由客户端直接向 CDN 取——这是代理层存在的理由。

**前置配置**：

1. 在设置页配置 Emby 地址和 API Key
2. 新建同步任务时开启 **302 开关**
3. Emby 客户端连本项目的 **8091** 端口，而不是 Emby 自己的 8096

> 建议把 115 账号的命名和 OpenList 或 CD 里保持一致：找不到直链时才能正确回源。

怎么确认真的走了 302，见下方「确认 302 是否生效」。

## ☁️ 115 云下载

侧栏「云下载」页对应 115 的离线下载：贴上磁力、ed2k、http(s)、ftp 链接（每行一条，直接贴 40 位 info hash 也行），由 115 在云端下载到网盘。

下载位置二选一：

- **同步任务的目录**（可进子目录）：下载完成后自动只为这次下载的文件/目录生成 strm，不用再跑全量同步。回执落在数据库里，服务重启后接着盯；结果（生成了几个、为什么失败）直接显示在任务行下面，配置了 Telegram 的话也会推一条。
- **网盘里的任意目录**：只下载，不管 strm。

下载到 115 默认目录时还可以勾选「**下载完成后让 OpenList 复制走**」：115 下完，就通知 OpenList 把产物从挂载的 115 存储复制到另一个存储（比如挂载的本地磁盘），并一直盯到 OpenList 复制完（目录会被 OpenList 拆成逐文件任务，也一并盯）。先在设置页配好三样：openlist 账号、115 默认下载目录在 OpenList 里的路径（如 `/115/云下载`）、复制目标目录；成败同样进回执和 Telegram 通知。

列表支持翻页、重试失败任务、删除（可选连网盘文件一起删）、清空已完成 / 失败；配额剩余量显示在顶部。添加任务用的是 115 客户端的加密接口，和 App 内添加等价；接口只认 cookie，不需要额外配置。

## 🤖 Telegram 机器人

侧栏「Telegram」页填上 @BotFather 给的 bot token 和自己的 chat id（给机器人发 `/id` 就能看到），开启轮询即可；不需要公网地址。

- **通知**：任务完成 / 失败（含定时触发的启动失败，带原因）、云下载完成、115 cookie 失效或被封控（同一原因一小时只提醒一次）。每类可单独关掉，任务开始默认不发。
- **直接发链接**：磁力 / ed2k / http 链接 → 选下到哪个任务目录（可逐层进入子文件夹，比如 `tv/某剧/Season 1`），交给 115 云下载，下完自动生成 strm；115 分享链接 → 看一眼内容，选转存到哪个任务目录（同样可进子文件夹）并触发同步。
- **命令**：`/tasks` 任务列表（带运行按钮）、`/status`、`/history`、`/offline`、`/cancel`。

只回应白名单里的用户 id（陌生人私聊会收到自己的 id，加进白名单即可），群里只认配置的那个 chat id。会改动网盘或跑任务的动作（运行任务、添加云下载、转存分享）各有开关，默认全关。

## 📦 安装 & 使用

### 使用 Docker (推荐)

镜像是多架构的（linux/amd64、linux/arm64），`docker-compose.yml` 直接拉取 `indown/openstrm:latest`：

```bash
git clone https://github.com/indown/OpenStrm.git
cd OpenStrm
# 只需要 docker-compose.yml 一个文件；里面有 TZ / PUID / JWT_SECRET 等可选项的注释
docker compose up -d
```

不用 compose 的话：

```bash
docker run -d \
  --name openstrm \
  -p 3000:3000 \
  -p 8091:8091 \
  -e TZ=Asia/Shanghai \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config:/app/config \
  indown/openstrm:latest
```

**端口说明**：
- `3000`: 管理界面和 API（同一个进程）
- `8091`: Emby 302 代理端口（Emby 客户端使用此端口连接）

**目录挂载说明**：
- `./data`: 生成的 `.strm` 文件，以及字幕、nfo 等随片下载的文件。Emby 挂的是同一个目录
- `./config`: 只有一个 `openstrm.db`——账号、设置、任务、执行历史、登录凭据全在里面

日志走标准输出，`docker logs openstrm` 就能看；compose 里已经配了按大小轮转。镜像自带 HEALTHCHECK（`GET /api/health`，不鉴权，返回状态、版本和运行时长），`docker ps` 能看到 healthy 状态。

> **从 v2.0.0 之前升级**：旧版 compose 用的是 `./strmData`。换用新文件前先 `mv strmData data`，否则容器会对着一个空目录，Emby 那边的媒体库也会跟着空掉。
>
> v1 的 302 层是 nginx + emby2Alist，那套 `constant.js` 里的自定义配置（`mediaPathMapping`、`routeRule`、`clientSelfAlistRule` 等）**不会被继承**：v2 的代理只认「任务开了 302 的 strmPrefix 直接对应 115 目录」这一种映射。挂载结构就是一个前缀对一个目录、用主流客户端播放的话不受影响；改过那些规则的，升级后对应的客户端或目录会不走直链（日志里只有 `not-mounted`），需要反馈具体场景再补。

### 从源码构建镜像

改了代码想跑自己的版本：

```bash
docker compose -f docker-compose.build.yml up -d --build
```

### 本地开发

需要 **Node.js 24** 和 **pnpm 9**。仓库是 pnpm workspace，用 npm 装不出正确的依赖树。

```bash
git clone https://github.com/indown/OpenStrm.git
cd OpenStrm

# pnpm 版本由 package.json 的 packageManager 字段锁定，corepack 会自动取对应版本
corepack enable pnpm
pnpm install

# 同时启动 backend(4000) / Emby 代理(8091) / 前端 next dev(3000)
# 生产镜像里没有 Next 服务进程：前端是静态导出，由 backend 在 3000 上一并托管
pnpm dev
```

测试、类型检查和 lint：

```bash
pnpm test        # 后端全部单元/集成测试（node --test），跑在 /tmp/openstrm-test 下的临时库上
pnpm typecheck   # shared / backend / frontend 三个包
pnpm lint

# 只跑一个文件：CONFIG_DIR / DATA_DIR 必须指定，用例会改写设置表、在 DATA_DIR 里建删目录
cd apps/backend
CONFIG_DIR=/tmp/openstrm-test/config DATA_DIR=/tmp/openstrm-test/data pnpm test:file src/services/task/runner.itest.ts
```

代理层还有一套对着真实 Emby 的端到端对照（`scripts/emby-lab.sh up|main|down` 起环境，`pnpm test:e2e` 跑），需要 Docker，用法见 `.claude/plans/302-proxy-migration.md`。
>
## 🔧 配置说明

### 首次登录

默认账号 `admin` / `admin`。

**首次登录会强制要求修改密码**——在改掉之前，除修改密码本身以外的接口一律返回 403。

密码经 scrypt 哈希后存进 `config/openstrm.db`，不再以明文保存，因此**无法通过编辑文件修改**。忘记密码目前只能删掉 `config/openstrm.db` 重新初始化（账号、设置、任务会一并丢失）。

> 从旧版本升级上来的实例，原先的明文密码仍然可以登录，并在登录成功时自动转成哈希存储，不需要做任何操作。

### 环境变量

全部可选，不设也能正常运行。

| 变量 | 默认 | 说明 |
|---|---|---|
| `TZ` | `UTC` | 定时任务按这个时区解释 cron 表达式。compose 示例里已设为 `Asia/Shanghai`；不设的话 `0 3 * * *` 会在北京时间 11:00 跑 |
| `JWT_SECRET` | 首次启动随机生成并持久化 | 登录令牌的签名密钥。只有在需要轮换密钥、或多个副本共享同一份登录状态时才手动指定；改动会让所有已登录会话立即失效 |
| `LOG_LEVEL` | `info` | 排查「播放没走 302」时设为 `debug` |
| `CONFIG_DIR` / `DATA_DIR` | `/app/config`、`/app/data` | 容器内路径，一般不用改；改了要同步改 `volumes` 的挂载点 |
| `PUID` / `PGID` | 不设，以 root 运行 | 设了就用这个 uid/gid 跑两个进程（NAS 上用 `id` 查自己的）。`config` 目录会自动改归属；之前用 root 生成的 `data` 里的文件请自己 `chown` 一次 |
| `TRUST_PROXY` | 关 | 放在 nginx/Caddy 之类反代后面时设为 `true`，登录限流和日志里的客户端 IP 才会取 `X-Forwarded-For` |
| `BACKEND_PORT` / `PROXY_PORT` | `3000` / `8091` | 两个进程的监听端口。改了 `PROXY_PORT` 要同步改 compose 的 `ports` 映射；HEALTHCHECK 跟着 `BACKEND_PORT` 走 |
| `BACKEND_HOST` | `0.0.0.0` | 只想给本机反代用时可设为 `127.0.0.1`（容器里一般不用改） |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | 连不上 Telegram 官方接口时指到自己的反代，如 `https://tg.example.com` |

### 数据目录

- `./config/`: `openstrm.db` —— 账号、设置、同步任务、执行历史全在这一个文件里
- `./data/`: 生成的 `.strm` 文件和随片下载的字幕、nfo 等

> v2 起配置存放在 SQLite，不再有 `config.json`。旧版的 `config.json` 不会被自动导入，需要在界面里重新配置。

### 备份与恢复

备份用设置页的「下载备份」（或带登录 token 请求 `GET /api/system/backup`），拿到的是一致的快照。库是 WAL 模式，直接拷 `openstrm.db` 可能拷到一半。

恢复：

```bash
docker compose down
# 备份文件替换库文件；-wal / -shm 是上次运行留下的日志，必须一起删掉，否则会把旧内容合回去
cp openstrm-backup.db config/openstrm.db
rm -f config/openstrm.db-wal config/openstrm.db-shm
docker compose up -d
```

`./data` 里的 strm 可以随时用同步任务重新生成，不需要备份；随片下载的字幕、nfo 想留的话按普通文件备份即可。

### 放在反向代理后面

管理界面（3000）按普通站点反代即可。Emby 代理（8091）多一条要求：Emby 的实时通知走 WebSocket，反代要放行升级请求。Caddy 只需一行：

```caddyfile
emby.example.com {
    reverse_proxy 127.0.0.1:8091
}
```

nginx：

```nginx
location / {
    proxy_pass http://127.0.0.1:8091;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Emby 客户端里填反代后的地址；302 给出的是 115 直链，不经过反代。管理界面在反代后面时给容器加 `TRUST_PROXY=true`。

### 应用设置

以下在管理界面里改：

- `user-agent`: 115 API 请求使用的 User-Agent
- `strmExtensions`: 需要转成 `.strm` 的扩展名，会自动转小写
- `downloadExtensions`: 直接下载的文件扩展名，会自动转小写
- `emby.url`: Emby 服务器地址
- `emby.apiKey`: Emby API 密钥

### 匿名 302 开关

`emby.allowAnonymousRedirect`，默认 **关闭**，在设置页的 Emby 区块里有开关；下面的命令行方式留给没有界面的场景。

关闭时，不携带任何 Emby 凭据（query 和请求头里都没有令牌）的请求不会被解析成 115 直链，而是原样回源交给 Emby 自己裁决。打开则恢复旧行为——用服务端配置的管理员 API Key 去解析，这意味着**任何能访问 8091 端口的人，报一个条目 id 就能拿到你的媒体直链**，无需登录 Emby。

绝大多数播放器都会带令牌，不需要打开。只有确认播放器一个令牌都不发时才考虑。命令行方式：

```bash
docker exec -w /app/backend openstrm node -e '
const D = require("better-sqlite3");
const db = new D("/app/config/openstrm.db");
db.pragma("busy_timeout = 5000");
const emby = JSON.parse(db.prepare("select value from settings where key = ?").get("app.emby").value);
emby.allowAnonymousRedirect = true;
db.prepare("update settings set value = ? where key = ?").run(JSON.stringify(emby), "app.emby");
console.log("已设置:", emby);
'
```

配置是每个请求现读的，改完立即生效，不用重启。

### 确认 302 是否生效

```bash
docker logs -f openstrm 2>&1 | grep -E "直链|直连|回源|凭据"
```

要看到**两行**才算真的走了直连：

```
{"itemId":"72340","msg":"PlaybackInfo 已改写为直连"}
{"itemId":"72340","account":"主号","msg":"302 到 115 直链"}
```

只有第一行说明客户端没走到重定向，字节仍在经由本服务中转。最硬的判据是播放时看 `docker stats`——真走了 302，容器网络流量应该基本不动。

## 📄 许可证

本项目采用 [MIT License](LICENSE) 许可证。

## 💬 交流群组

欢迎加入我们的 Telegram 群组进行交流讨论：

[![Telegram Group](https://img.shields.io/badge/Telegram-OpenStrm%20Group-blue?style=for-the-badge&logo=telegram)](https://t.me/OpenStrmGroup)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request 来改进这个项目。

## ⚠️ 免责声明

本项目仅供学习和研究使用。请确保你遵守相关的法律法规和服务条款。

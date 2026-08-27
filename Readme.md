<div align="center">
  <img src="https://raw.githubusercontent.com/indown/openStrm/refs/heads/main/frontend/public/logo.png" alt="OpenStrm Logo" width="200" height="200">
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

## 📦 安装 & 使用

### 使用 Docker (推荐)

```bash
# 使用 Docker Compose
git clone https://github.com/indown/OpenStrm.git
cd OpenStrm
docker-compose up -d
```

### 手动构建

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

### Docker 镜像

项目支持多架构构建 (linux/amd64, linux/arm64)：

```bash
# 拉取最新镜像
docker pull indown/openstrm:latest

# 运行容器
docker run -d \
  --name openstrm \
  -p 3000:3000 \
  -p 8091:8091 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config:/app/config \
  indown/openstrm:latest
```

**端口说明**：
- `3000`: 管理界面和 API（同一个进程）
- `8091`: Emby 302 代理端口（Emby 客户端使用此端口连接）

**目录挂载说明**：
- `./data`: 生成的 `.strm` 文件，以及字幕、nfo 等随片下载的文件。Emby 挂的是同一个目录
- `./config`: 只有一个 `openstrm.db`——账号、设置、任务、执行历史、登录凭据全在里面，备份这一个文件就够了

日志走标准输出，`docker logs openstrm` 就能看；compose 里已经配了按大小轮转。

### 生产环境部署

```bash
docker-compose -f docker-compose.prod.yml up -d
```

生成的 strm 文件落在 `./data`，与上面的 Docker 用法一致。

> **从 v2.0.0 之前升级**：旧的 `docker-compose.prod.yml` 用的是 `./strmData`。换用新文件前先 `mv strmData data`，否则容器会对着一个空目录，Emby 那边的媒体库也会跟着空掉。

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
| `JWT_SECRET` | 首次启动随机生成并持久化 | 登录令牌的签名密钥。只有在需要轮换密钥、或多个副本共享同一份登录状态时才手动指定；改动会让所有已登录会话立即失效 |
| `LOG_LEVEL` | `info` | 排查「播放没走 302」时设为 `debug` |
| `CONFIG_DIR` / `DATA_DIR` | `/app/config`、`/app/data` | 容器内路径，一般不用改 |
| `TRUST_PROXY` | 关 | 放在 nginx/Caddy 之类反代后面时设为 `true`，登录限流和日志里的客户端 IP 才会取 `X-Forwarded-For` |

### 数据目录

- `./config/`: `openstrm.db` —— 账号、设置、同步任务、执行历史全在这一个文件里
- `./data/`: 生成的 `.strm` 文件和随片下载的字幕、nfo 等

> v2 起配置存放在 SQLite，不再有 `config.json`。旧版的 `config.json` 不会被自动导入，需要在界面里重新配置。

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

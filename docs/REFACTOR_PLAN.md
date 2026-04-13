# OpenStrm 前后端分离重构计划

## Context

当前项目是一个"拼接怪"：Next.js 全栈应用（页面 + API）+ nginx/njs 代理层（emby2Alist ~5,500 行）+ JSON 文件存储，配置分散在两处，调试困难，无法统一管理状态。

**目标**：统一为 Monorepo 架构，Fastify 后端承载所有 API + emby2Alist 代理 + 定时任务，Next.js 只负责前端页面，彻底去掉 nginx。

**技术选型**：Fastify + pnpm workspace + lru-cache + 一步到位迁移

---

## 1. Monorepo 结构

```
openstrm/
├── pnpm-workspace.yaml
├── package.json                    # scripts: dev, build, lint
├── tsconfig.base.json              # 共享 TS 配置
├── Dockerfile
├── docker-entrypoint.sh
├── docker-compose.yml
│
├── packages/
│   └── shared/                     # @openstrm/shared
│       └── src/
│           ├── types/              # 前后端共享类型
│           │   ├── account.ts      # AccountInfo
│           │   ├── task.ts         # TaskDefinition, TaskExecution
│           │   ├── settings.ts     # AppSettings
│           │   └── proxy.ts        # RouteRule, RouteMode, CacheConfig
│           ├── constants/          # 枚举、默认值
│           └── utils/              # 纯函数 (path, crypto, rule-matcher)
│
├── apps/
│   ├── backend/                    # @openstrm/backend (Fastify)
│   │   └── src/
│   │       ├── index.ts            # 入口
│   │       ├── plugins/            # Fastify 插件
│   │       │   ├── auth.ts         # JWT 认证
│   │       │   ├── config.ts       # JSON 配置读写
│   │       │   ├── cache.ts        # 5 个 lru-cache 实例
│   │       │   ├── task-manager.ts # 下载任务状态 (RxJS)
│   │       │   ├── rate-limiter.ts # Bottleneck 限流
│   │       │   ├── telegram.ts     # Telegram bot 生命周期
│   │       │   └── cron.ts         # 定时任务管理
│   │       ├── routes/
│   │       │   ├── auth/           # POST /api/auth/login, logout
│   │       │   ├── account/        # CRUD /api/account
│   │       │   ├── settings/       # GET/PUT /api/settings
│   │       │   ├── task/           # CRUD + start/cancel/log(SSE)
│   │       │   ├── task-history/   # GET/DELETE /api/task-history
│   │       │   ├── cloud/          # /api/115/files, /api/115/share
│   │       │   ├── directory/      # local/remote list
│   │       │   ├── fs/             # /api/fs/get (Alist 兼容)
│   │       │   ├── telegram/       # bot/webhook/polling/users
│   │       │   ├── system/         # clear-directory, clear-rate-limiters
│   │       │   └── proxy/          # *** emby2Alist 重写 ***
│   │       │       ├── redirect.ts         # /emby/videos/:id/stream → 302
│   │       │       ├── playback-info.ts    # PlaybackInfo 拦截修改
│   │       │       ├── transcode.ts        # 转码负载均衡
│   │       │       ├── items-filter.ts     # 列表过滤
│   │       │       ├── live.ts             # 直播/HLS
│   │       │       ├── subtitles.ts        # 字幕缓存+转码
│   │       │       ├── search.ts           # 搜索拦截
│   │       │       ├── system-info.ts      # 系统信息
│   │       │       └── catch-all.ts        # @fastify/http-proxy 透传 Emby
│   │       ├── services/
│   │       │   ├── cloud-115/      # 115 API 客户端 (复用现有 115.ts 等)
│   │       │   ├── download/       # RxJS 下载编排 (复用 downloadTaskManager)
│   │       │   ├── proxy/          # emby2Alist 核心逻辑
│   │       │   │   ├── rule-engine.ts      # 规则引擎 (移植 util.js)
│   │       │   │   ├── path-mapper.ts      # 路径映射
│   │       │   │   ├── alist-resolver.ts   # Alist API 调用
│   │       │   │   ├── emby-client.ts      # Emby API 调用
│   │       │   │   ├── strm-resolver.ts    # STRM 文件解析
│   │       │   │   ├── link-validator.ts   # HEAD 链接校验
│   │       │   │   └── hls.ts              # HLS/直播处理
│   │       │   └── config/         # 配置加载合并
│   │       └── middleware/
│   │           └── error-handler.ts
│   │
│   └── frontend/                   # @openstrm/frontend (Next.js 纯前端)
│       └── src/
│           ├── app/                # 页面 (无 api/ 目录)
│           ├── components/         # UI 组件 (不变)
│           ├── hooks/
│           └── lib/
│               ├── api-client.ts   # 请求封装，baseURL 从环境变量读取
│               └── utils.ts        # 客户端工具函数
│
├── config/                         # 挂载卷：JSON 配置
├── data/                           # 挂载卷：strm 输出
└── logs/                           # 挂载卷：日志
```

---

## 2. 关键技术决策

### 2.1 nginx → Fastify 替换映射

| nginx 特性 | Fastify 替代 |
|-----------|-------------|
| `ngx.shared` 共享内存 (5 zone) | `lru-cache` 5 个实例 |
| `proxy_pass` 透传 | `@fastify/http-proxy` |
| `r.subrequest` 子请求 | `fetch()` / `undici` |
| `r.return(302)` | `reply.redirect(302, url)` |
| `r.internalRedirect("@root")` | `reply.from(url)` via `@fastify/reply-from` |
| `proxy_cache` 图片/字幕 | 文件缓存 (`cacache`) 或内存缓存 |
| WebSocket proxy | `@fastify/websocket` |
| `js_set` 动态变量 | Fastify request decorator |
| gzip | `@fastify/compress` |

### 2.2 lru-cache 配置

```typescript
routeL1:    { max: 2000,  ttl: 15 * 60 * 1000 }   // 15min
routeL2:    { max: 4000,  ttl: 15 * 60 * 1000 }   // 15min
transcode:  { max: 500,   ttl: 4 * 60 * 60 * 1000 } // 4h
idem:       { max: 200,   ttl: 10 * 1000 }          // 10s
tmpDict:    { max: 200,   ttl: 60 * 1000 }          // 60s
version:    { max: 5000,  ttl: 11 * 60 * 60 * 1000 } // 11h
```

### 2.3 规则引擎移植

核心方案：创建请求适配器，让规则引擎代码几乎原样迁移：

```typescript
function adaptRequest(req: FastifyRequest) {
  return {
    args: req.query,
    headersIn: req.headers,
    variables: { remote_addr: req.ip, apiType: req.apiType },
    uri: req.url.split('?')[0],
    XMedia: req.xMedia,  // 每次请求从 Emby API 获取后挂载
  };
}
```

### 2.4 前后端通信

- **开发环境**：Next.js `next.config.ts` 配 `rewrites`，`/api/*` 代理到 `localhost:4000`
- **生产环境**：Fastify 托管 API (:4000) + Emby 代理 (:8091)，Next.js standalone (:3000)

### 2.5 认证

从 Next.js middleware 迁移到 Fastify `onRequest` hook：
- `/api/auth/*` — 公开
- `/api/fs/*` — internalToken 校验
- `/api/*` — JWT 校验
- `/emby/*` — 无认证（Emby 客户端自带认证）

---

## 3. 实施步骤

### Phase 1: 搭建 Monorepo 骨架
### Phase 2: 后端核心 — 配置与认证
### Phase 3: 后端核心 — 下载系统
### Phase 4: 后端核心 — Telegram
### Phase 5: emby2Alist 代理重写
### Phase 6: 前端改造
### Phase 7: 定时任务
### Phase 8: Docker 与部署

---

## 4. 关键源文件

| 文件 | 行数 | 目标 |
|------|------|------|
| `emby2Alist/nginx/conf.d/emby.js` | 887 | `routes/proxy/redirect.ts` + `playback-info.ts` |
| `emby2Alist/nginx/conf.d/common/util.js` | 781 | `services/proxy/rule-engine.ts` + `path-mapper.ts` |
| `emby2Alist/nginx/conf.d/modules/emby-v-media.js` | 441 | `services/proxy/hls.ts` |
| `emby2Alist/nginx/conf.d/modules/emby-transcode.js` | 425 | `routes/proxy/transcode.ts` |
| `frontend/src/app/api/startTask/route.ts` | ~600 | `services/download/orchestrator.ts` + `routes/task/start.ts` |
| `frontend/src/lib/enqueueForAccount.ts` | 363 | `services/download/rate-limited.ts` |
| `emby2Alist/nginx/conf.d/constant.js` + config/* | 604 | `services/config/proxy-defaults.ts` + `loader.ts` |

---

## 5. 后端依赖

```
fastify, @fastify/http-proxy, @fastify/reply-from, @fastify/websocket,
@fastify/cors, @fastify/compress, @fastify/static, @fastify/autoload,
lru-cache, bottleneck, rxjs, cron, jose, axios, uuid, zod, pino
```

---

## 6. 验证方案

1. **API 功能验证**：逐个对比新旧 API 的请求/响应
2. **代理功能验证**：Emby 播放 302 重定向、缓存命中、WebSocket、PlaybackInfo
3. **前端验证**：所有页面功能正常
4. **定时任务验证**：创建 → 自动执行 → 日志和历史
5. **Docker 验证**：`docker-compose up` 一键启动

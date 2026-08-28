# 用 TS 重建 302 代理层 —— 状态记录

> 原计划已执行完毕并超出原范围。本文档现在是**状态记录**，不是待办计划。
> 最后更新：2026-08-24

## Context

V2 重构删掉了 nginx/njs（`81cb062`），但没有把 nginx 干的活接过来：

- `routes/proxy/index.ts` 只注册了 catch-all，:8091 是纯透传，播放全流量过 Node
- `services/proxy/` 那 3890 行 njs 从未被任何文件 import，而且 import 即崩（`njs` 全局未定义、`r` 对象没 shim）
- UI 上的 302 开关空转：只往 `settings.mediaMountPath` 写值，而这个值只有死代码读

**一处需要更正的判断**：最初我认为"这条回调链路一次都没跑通过"。**这是错的**——main 的 `docker-entrypoint.sh` 在启动时用 `sed` 把生成的 internalToken 注入 `constant-mount.js`，且 main 上后端确实监听 8000，所以 **302 在 main 上是通的**。是 v2 重写 entrypoint 时丢了这步、后端又挪到 4000 才断的。

---

## 已完成

三个提交，都在 `v2` 分支：

| 提交 | 内容 |
|---|---|
| `86a1352` | 用 TS 重建 302 层，删除 3890 行未接线的 njs，拆出独立代理进程 |
| `9a51382` | 修 A/B 对照发现的 11 项回归 |
| `3486f94` | 补 `/Sync/JobItems/*/File` 路由；直链缓存跨进程失效 |

### 交付物

```
services/resolve/direct-link.ts   路径映射 + 115 直链解析（/api/fs/get 复用同一份）
services/emby/api.ts              条目查询（/Items 与 /Sync/JobItems 两种）
services/settings-safe.ts         代理侧容错读配置，库不可用时真降级
services/config-revision.ts       配置指纹，让直链缓存跨进程失效
routes/proxy/redirect.ts          302 核心 + LRU 缓存
routes/proxy/playback-info.ts     标直连、关转码、改写 DirectStreamUrl
routes/proxy/system-info.ts       端口改写 + web 播放器 crossorigin 补丁
routes/proxy/upstream.ts          转发头、逐跳头剥离、响应中继
proxy.ts                          独立进程入口
scripts/emby-lab.sh               一键重建验证环境（up / main / down）
```

### 验证方式

**关键做法：拿真 Emby 和 main 的 nginx 做 A/B。** 官方 `nginx:1.27.1` 镜像自带 `ngx_http_js_module.so`，所以 main 的 emby2Alist 栈能原样跑起来。同一个 Emby（`amilys/embyserver`，amd64 模拟，中文名 strm 库）前面分别挂两套代理，通过**同一个 `/api/fs/get` 桩**解析直链，逐项比对。

首轮 12 项对照 **9 项有差异，全是 v2 的缺陷**。修完后：

- `proxy.e2e.ts` 20 项通过（含 7 项与 main 的直接对照）
- `proxy.itest.ts` 26 项、`direct-link.test.ts` 18 项
- `pnpm test` 全套通过，`pnpm typecheck` 干净

### A/B 查出的问题（都已修）

最严重的是我自己引入的：`safeLocation` 用 `encodeURI` 兜底，而它把 `%` 转成 `%25`、**不幂等**，115 直链本来就是转义过的 → 中文文件名的条目 302 出去全是坏地址。**而当时的测试用未转义的桩数据算期望值，把 bug 断言成了正确行为。**

其余：PlaybackInfo 对空 body/表单 content-type 返回 400/415；`Keep-Alive`/`Expect` 头让所有路径 500（v2 遗留，非本次引入，但相对 main 是回归）；`SupportsTranscoding` 没关；`DirectStreamUrl` 用了 `mediasource_11` 而非条目 id；拦截路径丢响应头（304 导致给浏览器未打补丁的播放器）；`swapPorts` 子串替换污染主机名；超时没覆盖 body 读取；任务反查非最长匹配；账号兜底串盘；`X-Real-IP` 可伪造；降级路径不降级。

---

## 迁移完整度：**未完整迁移**

### 拦截点 7/17

已覆盖：`basehtmlplayer.js`、`PlaybackInfo`、`system/info`、`videos/(stream|original)`、`Audio/(universal|stream)`、`Items/Download`、`Sync/JobItems/File`

未覆盖：虚拟字幕（`vSubtitlesAdepter`）、媒体库过滤（`itemsFilter` ×2）、搜索增强（`searchHandle`）、`Users/Items/Latest` 过滤、直播直连（`directLive` ×2）、转码均衡（`transcodeBalance`）、`ActiveEncodings`、`Sessions/Playing`

### 配置面 3/38

v2 只读 `emby.url`、`emby.apiKey`、`mediaMountPath`。其余 35 项无对应物。另有三项被写死而非可配：`fallbackUseOriginal` 恒 true、路由缓存恒开 15 分钟、`redirectCheckEnable` 未实现。

### nginx 层能力

`proxy_cache`（图片 10G / 字幕 1G）、`gzip`、`client_max_body_size 20M`、`Referrer-Policy`、TLS 均未迁移。

---

## 剩余工作（按优先级）

### P0 — 影响老用户升级

规则引擎的骨架，默认配置下不影响，但改过 emby2Alist 配置的用户升级后设置会被**静默忽略**，表现为"某些客户端/某些盘突然不 302 了"，日志只有一句 `not-mounted`：

1. **`mediaPathMapping`** — 路径映射规则。挂载结构不是"一个前缀直接对应盘内路径"的用户，v2 直接失配
2. **`routeRule`** — 按客户端/路径决定走 302 还是中转

### P1 — 具体场景缺失

3. ~~**`clientSelfAlistRule`** — main 注释明确写着 Infuse 拖进度条依赖它~~ **已做（2026-08-28）**：真机复现是 Infuse 拖动时到代理的 UA 和到 CDN 的 UA 不一致，而 115 直链和换链 UA 严格绑定（实测：A 换的链接用 B 取直接 403，并发/复用都没问题），拿着缓存直链反复 403 把那个文件打到临时限流。`redirect.ts` 对 UA 含 Infuse 的请求先 302 回代理自己同一路径（`_hop=2`，令牌补进 query），第二跳按跟随时的 UA 换链——和 v1 转到 Alist `/d/` 再跳一次是同一个原理，不需要 Alist。
4. **`redirectCheckEnable`** — 回源前校验直链有效性（对应删掉的 `link-validator.js`）
5. **`itemHiddenRule`** 媒体库过滤 / **`searchConfig`** 搜索增强 —— 与 302 正交的独立功能

### P2 — 已知但影响有限

6. `/System/Info/Public` 未拦截，登录前仍暴露 Emby 真实地址（**main 同样如此，不算回归**）
7. 代理进程未启用 gzip
8. 图片/字幕磁盘缓存未迁移（Emby 自身有图片缓存，影响待观察）
9. 直播电视 `directLive` 未移植（115 strm 库不产生这类条目，透传给 Emby 仍能播）

---

## 复现验证环境

```bash
./scripts/emby-lab.sh up      # Emby + strm 库 + 直链桩，打印环境变量
./scripts/emby-lab.sh main    # 额外起 main 的 nginx/njs 栈做 A/B
. /tmp/openstrm-emby-lab/env.sh
cd apps/backend && CONFIG_DIR=/tmp/x/config DATA_DIR=/tmp/x/data pnpm test:e2e
./scripts/emby-lab.sh down
```

注意：两个代理测试**不指定 `CONFIG_DIR` 会拒绝运行**——它们写 settings 表，在真实库上跑会把 Emby 地址改成死端口。

## 未做的真机验证

115 那一段全部用桩替代（`setLinkResolver` / `/api/fs/get` 桩）。真账号下仍需人工确认：真直链 302 能否播放、拖进度条的缓存命中、web 端 CORS。

# 检查更新 —— 设计

## 要解决的事

镜像是 `indown/openstrm:latest`，用户不知道自己跑的这个容器是不是最新的，也不知道新版本改了什么。现在版本号只在侧栏角落显示一个 `v2.7.0`，要知道有没有新版只能自己去 GitHub 看。

**做**：告诉用户「你在跑 2.7.0，最新是 2.8.0，它改了这些，这样升」。
**不做**：自动升级。容器换不了自己的镜像（那是 watchtower 那类工具的活，而且我们的升级还牵扯数据库迁移，得让人自己挑时间）；也不做下载安装包。

## 数据源：GitHub Releases

`GET https://api.github.com/repos/indown/openStrm/releases/latest`，拿 `tag_name` / `name` / `body`（发版工作流开了 `generate_release_notes`，正文就是自动生成的更新说明）/ `html_url` / `published_at` / `prerelease`。

- 匿名限额 60 次/小时/IP，我们一天一次 + 手动（节流），够用；不带任何 token。
- 另外两个候选不选：Docker Hub 的 tags 接口只有 tag 和 digest，**没有更新说明**（这个功能一半的价值在说明上）；`releases.atom` 不吃配额但要解析 XML、也分不出 prerelease。
- 不比 digest：用 `latest` tag 的用户 digest 天天变，比语义版本才对得上用户心里的「版本」。

失败不降级到别的源，直接把「检查不上」如实显示——GitHub 在国内经常连不通，这是常态，不该假装成「已是最新」。

## 版本从哪来、怎么比

当前版本 = `process.env.APP_VERSION || package.json.version`（镜像里由 release 工作流注入裸版本号）。现在这段在 `routes/system/health.ts` 里，抽成 `lib/version.ts` 的 `APP_VERSION`，health 和更新检查共用。

比较用最小的 semver 实现（不引依赖）：去掉 `v` 前缀 → `major.minor.patch` 逐段比 → 都相等时按 semver 规则比 prerelease（`2.7.0-rc.2 < 2.7.0`，`rc.2 < rc.10` 按数字段比）。解析不了的版本（自己编译的 `dev`、`0.0.0`）当「比不了」，显示成「已是最新」，不烦人。

**预发布怎么办**：`/releases/latest` 本来就跳过 prerelease，跑正式版的人只会看到正式版。但跑 `2.8.0-rc.1` 的人光比正式版会被告知「有新版 2.7.0」——反了。规则：

- 当前版本带 `-`（是 rc），或者设置里开了「包含预发布版本」→ 另拉 `/releases?per_page=10`，取排序后最新的一条（含 prerelease）比。
- 否则只看 `/releases/latest`。

## 什么时候查、结果放哪

- 开了自动检查才有定时：启动后延迟 30 秒查一次（别和迁移、任务恢复、监控启动抢），之后每 24 小时一次；`setInterval(...).unref()`，和 housekeeping 一个套路。默认是关的，所以默认一次都不查。
- 手动「立即检查」：`POST /api/update/check`，5 分钟节流（连点不打爆配额），节流命中就直接回缓存。
- 结果存 settings 表的 `update.state`（KEY 里加一条；**不放 `app.` 前缀**——那是 GET /api/settings 会整个吐给前端的用户设置，运行状态不该混进去）：

```ts
interface UpdateState {
  checkedAt: number;            // 秒；0 = 从没查过
  ok: boolean;                  // 这次查成功没有
  error?: string;               // 失败原因（网络不通、限额、解析不了）
  latest?: {
    version: string;            // 裸版本号 2.8.0
    tag: string;                // v2.8.0
    url: string;                // 发布页
    publishedAt: number;
    prerelease: boolean;
    notes: string;              // 更新说明，截断到 4000 字免得把 settings 撑大
  };
  /** 已经通知过的版本：一个版本只推一次 Telegram */
  notifiedVersion?: string;
}
```

页面读缓存，不触发网络：刷新页面不该产生外网请求。

## 设置（2026-09-16 定）

`app.update = { enabled?: boolean; includePrerelease?: boolean }`。

- `enabled` **默认关**（用户定的）：不主动联网，装上不会有任何外网请求。它管的是**定时检查**；设置页的「立即检查」是用户自己按的，任何时候都能用——按一下就等于明确同意这一次请求。
- `includePrerelease` 不填时按当前版本自动判断（跑 rc 就跟 rc 比）。

## 接口

```
GET  /api/update        → { current, enabled, checking, state }   只读缓存
POST /api/update/check  → 真查一次（节流），回新的 state
```

设置照旧走 `/api/settings`（`app.update`）。错误壳照 `{ message, ...extra }`；上游失败不回 5xx（查不到不是我们的错），把原因放进 `state.error` 正常返回。

## 界面

1. **侧栏版本徽章**（现在是 `v2.7.0`）：有新版本时后面跟一个 brand 色小圆点，整块变成链到 `/settings#update` 的按钮，title 写「有新版本 v2.8.0」。没新版本时和现在一模一样。角标数据走一个和「整理待处理」同款的轻量 hook（`useUpdateBadge`，60 秒一轮 + 手动刷新事件）。
2. **设置页「更新」一节**（放在最上面，`id="update"`）：
   - 当前版本、最新版本、发布时间、「已是最新 / 有新版本 / 检查失败 / 关着」的状态徽章
   - 更新说明：`body` 按纯文本显示（等宽、可滚动，最多几行后「展开」），不引 Markdown 渲染器
   - 按钮：「立即检查」「打开发布页」
   - 开关：「自动检查更新」「包含预发布版本」
   - 升级指引一句话 + 可复制的 `docker compose pull && docker compose up -d`，旁边提醒「升级前点下面的『下载备份』」
3. 文案不吓人：检查失败写「连不上 GitHub（国内网络常见），不影响使用」。

## Telegram（做，默认关）

`TelegramNotifySettings` 加一个 `update`（默认 **关**：这是唯一一类和用户自己的媒体库无关的通知），事件 `{ type: "update-available", version, url, notes }`。发现新版本且 `state.notifiedVersion !== version` 时推一条，推完记下来，同一个版本不再推。

## 隐私与网络

- 只发一个匿名 GET，不带任何账号、路径、统计——这点在设置页的说明里写清楚。
- 超时 8 秒，失败 warn 一条日志（别每天刷屏），不重试。
- 代理：axios 在 Node 下默认认 `http_proxy` / `https_proxy` 环境变量，容器里设上即可，代码不特殊处理，Readme 提一句。

## 测试

- `version.test.ts`：比较与排序（v 前缀、rc 顺序、位数不同、非法版本）、`pickLatest`（按 includePrerelease 挑）。
- `update.itest.ts`：注入假 fetcher（`setUpdateDeps`，照 `setOrganizeDeps` 的做法）——查到新版本写缓存、查失败记 error 不覆盖上次的 latest、节流命中不发请求、关掉时不发请求、prerelease 规则、通知只推一次。
- 路由 itest：GET 形状、POST 节流、关掉时 POST 的行为。

## 分阶段

1. 后端：`lib/version.ts` + 比较纯函数 + 服务（缓存 / 节流 / 定时）+ 两个接口 + `app.update` 设置 + Telegram 通知（带测试）
2. 前端：设置页「更新」一节 + 侧栏小红点 + 通知开关里多一项

用户已定：提示放侧栏小点 + 设置页详情；自动检查默认关；Telegram 通知做、默认关。

## 不做

- 自动下载 / 自动升级、容器内自更新
- 版本回滚指引（Docker tag 本来就能回滚，写在 Readme 更合适）
- 自建更新服务器 / 灰度：没有服务端，也不该为这个建一个

## 实施记录（2026-09-16）

按上面的方案做完了，和方案的出入只有一处：`update.state` 里的 `notifiedVersion` 在**决定要推**的时候就先写下来，推送本身失败也不重推——不然 Telegram 连不上时每天都会再试一次同一个版本。

落到这些地方：

- `lib/version.ts`：`APP_VERSION`（`health.ts` 原来那段挪过来共用）+ `parseVersion` / `compareVersions` / `isNewerVersion` / `isPrerelease`，自己写的最小 semver，没引依赖。
- `services/update/service.ts`：`checkForUpdates` / `updateStatus` / `startUpdateChecks`，fetcher 和时钟都能注入（`setUpdateDeps`），测试里一个真请求都不发。
- `routes/update/index.ts`：`GET /api/update`、`POST /api/update/check`（节流命中回 429 带 `retryAfter`）。
- `app.update` 设置（schema 里加了）、`KEY.updateState`、Telegram 的 `update-available` 事件与 `notify.update` 开关（默认关）。
- 前端：`lib/update.ts`（刷新事件）、`hooks/use-update-badge.ts`、设置页最上面的 `UpdateSection`、侧栏版本徽章的小点、Telegram 页通知开关多一项。

测试：`version.test.ts` 3 条、`routes/update/update.itest.ts` 10 条（默认不联网、手动检查、节流 429、失败保留上次结果、预发布规则、草稿/乱 tag、通知只推一次、开了自动检查才定时查、要登录），后端 766 个全过。

浏览器里走了一遍（scratch 库 + 先摆一个假的 v99 缓存）：设置页的「更新」一节、侧栏 `v2.7.0 ●` 小点、点「立即检查」**打真的 GitHub** 回到「已是最新」、再点一次弹「刚查过，5 分钟后再试」。真实接口的形状和代码一致（`tag_name` / `html_url` / `published_at` / `prerelease` / `body`）。

一个附带发现：现在 release 正文是工作流自动生成的，而这个仓库没有 PR，所以正文常常只有一行 `**Full Changelog**: …compare/v2.6.0...v2.7.0`。想让「更新说明」有内容，发版时给 Release 写正文（或者 tag message 里写）。

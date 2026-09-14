# 同步任务的失败项：分类、处理建议、整轮停（设计）

> 状态：**已实施（后端 + 前端），未提交**。2026-09-14 设计并实施。起因：用户看到 `ENAMETOOLONG: name too long, open '/app/data/…'` 这种原样抛出来的错误，问后续方案，要求类似的报错都直接给处理建议。

## 现状

代码：`services/task/runner.ts`（全量同步）、`services/download/rate-limited.ts`（写 strm / 下载）、`services/life/handlers.ts`（监控生成）、`services/follow/service.ts`、`services/offline/service.ts`、`services/organize/run.ts`（本地镜像）；页面 `app/log`、`app/history`、`app/home` 的任务卡片、`app/life`。

- 单个文件失败：`failOne` 记一条 `{ filePath, kind, error: err.message }` 事件，任务继续；结束时 `describeFailures` 拼成「N 个文件失败：a、b、c 等」写进 `summary.errorMessage`，任务卡片、历史页、Telegram 都只有这一句。日志页的失败行下面显示原始错误文本。
- 写 strm 走 `fsp.mkdir` + `fsp.writeFile`，错误原样抛：`ENAMETOOLONG: name too long, open '…'`、`ENOSPC: no space left on device, write`、`EACCES: permission denied, mkdir '…'`。
- 下载那条流 `downloadOrCreateStrmLimited` 对除 PermanentError / 404 / 410 之外的一切失败重试 10 次、每次隔 2 秒：磁盘满、名字过长、没权限这类本地文件系统错误也会重试 10 次，每个文件白等 20 秒，错误一模一样。
- 任务级问题只在启动阶段认（`loadRemoteEntries`：封控 403、源目录不存在、读目录失败）。跑起来之后 cookie 失效、风控、磁盘满都是逐个文件失败，跑到最后一个才结束，几千行一样的错误。
- 每次全量同步都会再试同一批注定失败的文件（它们永远「本地缺失」），任务永远是失败状态，通知每次都来。
- 同一类错误在 网盘监控（`markLifeEvent failed` + `lastError`）、追更（`lastError`）、云下载回执（`detail`）、整理的本地镜像（`本地镜像失败：EACCES…`）里也是原文。

## 会碰到哪些错误

### 本地文件系统（写 strm、下载落盘、建目录、.part 改名）

| errno | 什么情况 | 该怎么办 | 范围 |
|---|---|---|---|
| `ENAMETOOLONG` | 单段文件名超过 255 字节（一个汉字 3 字节，加上 `.strm` 更长）；整条路径超过 4096 | 本地文件系统的硬限制，重试没用。用「整理」改成标准命名，或在网盘上把名字改短 | 单个文件 |
| `EINVAL`（SMB / NTFS / exFAT 上有时是 `ENOENT`） | 名字含本地文件系统不允许的字符：`: * ? " < > \|`、结尾的点或空格 | data 目录挂在 SMB / NTFS 上；「整理」会替换这些字符，或者换成 ext4 / btrfs 挂载 | 单个文件 |
| `ENOTDIR` / `EISDIR` / `EEXIST` | 网盘上同名的文件和目录（`Show` 文件 + `Show/` 目录），或本地已有同名文件挡住了目录 | 网盘上改掉其中一个的名字；本地那个删掉（体检能列出来） | 单个文件 |
| `ENOSPC` / `EDQUOT` | 磁盘满 / 配额满 | 清理或扩容 data 所在的盘 | 整轮 |
| `EACCES` / `EPERM` | 没权限：改过 PUID / PGID 之后旧文件还属于 root，或目录只读 | README 里的 `chown` 说明；检查挂载 | 整轮 |
| `EROFS` | 只读挂载 | 检查挂载参数 | 整轮 |
| `EMFILE` / `ENFILE` | 打开文件数超限 | 把设置里的下载并发调低；临时，可重试 | 临时 |
| `EIO` / `ESTALE` / `EBUSY` / `EAGAIN` | 存储层出错（NFS / SMB 掉线、磁盘坏块） | 检查存储；临时，重试一次 | 临时 |
| `ELOOP` | 软链接环 | 检查 data 目录里的链接 | 单个文件 |

### 网盘那边（取直链、下载正文）

| 表现 | 什么情况 | 该怎么办 | 范围 |
|---|---|---|---|
| 115 errno 990001「请重新登录」、夸克 31001 / 31004 / 401、OpenList 401 | cookie / token 失效 | 到「账号」页更新；已有 account-alert 通知 | 整轮 |
| 115 405 / 「访问被阻断」 | 风控 | 停下等一会再跑；已有 account-alert | 整轮 |
| 404 / 410 / `PermanentError` | 网盘上已经没有这个文件（同步开始后被删或挪走） | 不用处理，下次全量同步会当多余清掉 | 单个文件 |
| `ECONNRESET` / `ETIMEDOUT` / `EAI_AGAIN` / 5xx / 限流 | 网络抖动 | 已自动重试；仍失败就稍后再跑一次 | 临时 |
| 直链回的是 HTML / 大小对不上 | 网盘返回了错误页 | 多半是风控或 cookie，看账号页 | 整轮（连着来几个就停） |

## 方案

### 1. 一个分类器，所有生成 strm 的入口共用

`services/task/file-failure.ts`：

```ts
type FileFailureKind =
  | "name-too-long" | "invalid-name" | "name-conflict"     // 单个文件，重试没用，要改名
  | "no-space" | "permission" | "read-only"               // 整轮停
  | "fs-transient" | "io-error"                           // 本地临时
  | "gone"                                                // 网盘上没了，不用管
  | "auth" | "blocked"                                    // 整轮停 + 账号告警（已有）
  | "network"                                             // 已自动重试
  | "unknown";

interface FileFailure {
  kind: FileFailureKind;
  scope: "file" | "task";      // task = 整轮停
  retryable: boolean;          // 下载流的 retry 只重试它为 true 的
  message: string;             // 人话：「文件名超过 255 字节，本地文件系统写不下」
  advice: string;              // 下一步：「用「整理」改成标准命名，或在网盘上改短」
  detail: string;              // 原始错误文本
  action?: { type: "organize"; taskId: string; subPath: string } | { type: "account" } | { type: "settings" };
}

function classifyFileFailure(err: unknown, ctx: { localPath: string; remotePath: string; kind: "strm" | "download"; provider?: DriveProvider }): FileFailure
```

本地错误按 `err.code`（`NodeJS.ErrnoException`）判；网盘错误先问 `provider.classifyError`（auth / blocked），再看 HTTP 状态 / `PermanentError` / axios 网络码。认不出的归 `unknown`，`retryable = true`、`scope = file`，文案就是原文。文案模板全在这一个文件里，页面和通知不再自己拼。

`action.organize` 的 `subPath` 是文件所在目录相对任务的路径：日志页的按钮直接跳 `/organize?task=…&path=…`，用户点「预览」就能改名（整理会替换非法字符、按模板缩短名字——模板里 `{title} - S01E01` 远比发布名短）。

### 2. 事件和记录带上分类

- `DownloadProgress` 的文件失败事件加 `reason: FileFailureKind`、`message`、`advice`、`action?`；`error` 仍是原文（老记录没有新字段，页面按原文显示，兼容）。
- 执行历史 `summary` 加 `failures: Partial<Record<FileFailureKind, number>>`、`advice?: string`（数量最多那一类的建议）；`errorMessage` 改成按原因分组的摘要：「5 个文件失败：文件名过长 3、磁盘满 2」。任务卡片、历史页、Telegram 复用这一句。
- 整轮停时 `summary.stopped = { reason: kind, attempted, remaining }`，`errorMessage` = 人话原因 + 建议。

### 3. 整轮停

`scope === "task"` 的失败（磁盘满、只读、没权限、cookie 失效、风控）第一次出现就停：退订整条流，剩下没跑到的文件不算失败（日志页显示「未尝试」），`finish("failed", 原因 + 建议)`。cookie / 风控继续走已有的 `account-alert`（`issueFromDrive`）。直链回 HTML 这种认不准的，连续 5 个文件同一类才停。

### 4. 重试策略修正

- 下载流的 `retry`：`retryable === false` 的不再重试（本地文件系统错误、名字问题、404 / 410、cookie、风控）；只有 network / fs-transient / io-error 重试，次数照旧。
- 写 strm 那条流现在完全不重试：`fs-transient` / `io-error` 加一次 1 秒后的重试，其余不动。

### 5. 事前预判（推荐做）

`planSync` 算出的 `missingLocally` 里，本地文件名（含 `.strm`）任一路径段 `Buffer.byteLength > 255` 的，不去碰文件系统，直接记成 `name-too-long`（日志里标「未尝试」），建议照给。好处：不用等写失败，也不会在 SMB 之类的挂载上留下半截目录。非法字符不预判（不知道用户的文件系统），靠 errno。

### 6. 界面

- 日志页：失败行下面显示 `message`，再一行灰色 `advice`；顶部横幅改成按原因分组的摘要，每组一个按钮——「去整理这个目录」（organize，预填任务和目录）、「查看账号」（auth / blocked）、「打开设置」（EMFILE 调并发）；整轮停显示原因 + 建议 + 「未尝试 N 个」。
- 历史页、任务卡片：`errorMessage` 已经是分组摘要；hover 显示 `advice`。
- 网盘监控页：事件 `detail` 和账号 `lastError` 用同一套人话 + 建议。
- 追更 / 云下载：`lastError` / `detail` 同样过分类器。
- 整理的本地镜像失败：`mirror` 类的 error 文案也过分类器（现在是「本地镜像失败：EACCES…」）。

### 7. Telegram

`task-done` 失败：「❌ 同步失败 … 失败 5：文件名过长 3、磁盘满 2」+ 第一条建议一行；整轮停：「⏹ 同步中止：磁盘满（/app/data 所在的盘），未尝试 1200 个」+ 建议。通知总长度不变，只是把原始文件名换成原因。

### 8. 测试

- 分类器单测：每个 errno、每家网盘的 cookie / 风控 / 404、axios 网络错各一条，断言 kind / scope / retryable / 文案。
- `runner.itest`：假网盘 + 真文件系统——造一个 260 字节的文件名 → `name-too-long`、未碰文件系统（预判）；把 saveDir 改成只读 → 第一个文件 `permission` 整轮停、剩余标未尝试、通知带建议；下载 404 → `gone`、不重试；模拟 ENOSPC（注入 fs 桩）→ 整轮停。
- 日志事件形状、历史 summary、Telegram 文案各一条。

### 不做

- 不自动截短本地文件名：「本地树 = 网盘树」是全部链路的不变量（校验、监控、302、追更都靠它），改本地名等于要维护映射表。
- 不自动改网盘文件名：那是整理的事，给按钮跳过去。
- 不改「有单个文件失败时任务算 failed」的语义。

## 分阶段

1. 分类器 + 事件字段 + runner 摘要 / 整轮停 / 重试修正 + 测试
2. 监控、追更、云下载、整理镜像复用分类器文案
3. 日志页 / 历史 / 任务卡片 / 监控页 + Telegram
4. 事前预判（文件名字节数）

## 实施记录（2026-09-14）

- 分类器放在 `services/download/failure.ts`（不是设计里写的 task/），因为写 strm / 下载都在 download/ 里，`rate-limited.ts` 的重试也直接引它：`classifyFileFailure` / `describeFileFailure` / `summarizeFailures` / `tooLongSegment` / `isPermanentFsError`。类别和 `TaskStopInfo` 在 shared 的 task.ts。
- 进度事件复用已有的 `message` 字段放人话（`DownloadProgress` 本来就有 message 给结束事件用），另加 `reason / advice / action / attempted`，结束事件加 `stopped`。老记录没有这些字段，日志页照旧显示原文。
- 整轮停在 `failOne` 里判 `scope === "task"`，`queueMicrotask` 后退订整条流再 `finish`（在流的回调里同步退订会打断当前通知）；`finish` 加了幂等保护。剩余文件不算失败，`summary.stopped.remaining` 记数量。
- 事前预判（第 4 阶段）随第 1 阶段一起做了：`tooLongSegment` 按 255 字节算每一段（strm 的最后一段换成 `.strm`），命中的直接走 `failOne(..., attempted = false)`。
- 下载流的 `isPermanentFailure` 加了 `isPermanentFsError`（ENAMETOOLONG / ENOSPC / EACCES 这类不再重试 10 次）；写 strm 那条流对 retryable 的错误隔 1 秒重试一次。
- 复用分类器文案的地方：网盘监控事件的 `failed` detail、追更转存分组的错误、云下载回执「生成 strm 失败」、整理本地镜像失败的 error。任务卡片没改：`errorMessage` 已经是分组摘要 / 整轮停原因。
- Telegram `task-done` 加 `advice` 一行（👉 开头）；整轮停时建议已在 message 里，不重复。
- 前端：`lib/task-failures.ts`（类别名 + 按钮去向）、`log/events.ts` 解析新字段并按原因分组、日志页失败行显示人话 + 建议 + 「没去碰文件系统」、结束后显示「失败原因」面板（去整理这个目录 / 查看账号 / 打开设置）、整轮中止横幅；历史页多一行「建议」。
- 测试：`failure.test.ts` 5 条；`runner.itest` 新增 文件名过长预判、目标目录只读整轮停（root 下跳过），404 用例加了分类 / 不重试断言；`notify.itest` 加建议行。后端 656 全过，前端 typecheck / lint / build 干净。
- 整轮的问题出在最后一个文件上时，流会比 `stopFor` 的微任务先结束：`finish` 现在看到 `stopping` 就按整轮停记（remaining = 0），不会混成「2 个文件失败：文件名过长 1、没有写入权限 1」。真机第二个场景暴露的，补了单文件只读的用例。
- **浏览器真机（2026-09-14，115 真账号 + scratch 库）**：115 允许 274 字节的文件名（90 个汉字 + .mp4），在 `/tv/_orgtest115` 里用 `files/copy` 造一个超长名和一个正常名的文件，建只指向这个目录的同步任务。任务页点「开始同步」→ 卡片「失败 · 1 个文件失败：文件名过长 1（完成 1/2）」；历史页「错误信息 + 建议」两行；日志页「失败原因」面板：「文件名过长 · 1」、说明、建议、「去整理这个目录」跳到整理页并预选任务，文件行标「（没去碰文件系统）」。第二轮删掉本地 strm、目标目录 chmod 555 再跑：横幅「同步中止：没有写入 data 目录的权限」+ PUID 建议，面板两组（过长 / 没权限），卡片摘要是中止原因。结束后 115 测试目录进回收站。磁盘满没模拟（ENOSPC 分类有单测）。

### 评审后的修补（2026-09-14 晚）

- **本地 errno 先于网盘判断**：以前先问 `provider.classifyError`，115 那份是按文案猜的，本地错误的 message 带本地路径，路径里有「405」「cookie」就被当成风控 / 登录失效整轮停。现在有 errno 的先按本地分。
- **「文件没了」只在取直链 / 下载时成立**：strm 那边（转存、列目录、云下载回执）的 404 / PermanentError / 分享失效原样给原文，不再说成「不用处理」。
- **非法字符查每一段路径**：SMB 上目录名带冒号在 mkdir 就报 ENOENT，只看文件名会归成 io-error 去重试。
- **没有 provider 时账号问题走 `classifyAccountIssue`**（和 115 的 classifyError 同一份规则），夸克 / OpenList 的登录码由 `driveErrorFacts.authCode` 给；删掉自己那份正则。云下载 / 监控 / 追更那几处把 provider 传进去了。
- **下载重试和 strm 重试合成一套**：`isPermanentFailure(err, provider)` 就是 `!classifyFileFailure(...).retryable`，cookie 失效 / 风控 / 404 / 本地永久错误都不再重试 10 次；runner 把 provider 传进 `downloadOrCreateStrmLimited`。
- **预判挪进公共写入口** `downloadOrCreateStrm`：按实际落盘的名字算（strm 是 `.strm`，下载是 `.part`，比设计里多算 5 字节），mkdir 之前就抛 `nameTooLongError`（带 `attempted: false`），监控 / 追更 / 云下载 / 整理镜像也不会先建出半截目录；runner 里那份预判和 strmTotal / downloadTotal 的重算删掉。
- **整轮停改成 `takeUntil(stop$)`**：`failOne` 只置 `stopping` 并 `stop$.next()`，merge 走正常的 complete 收尾——不再有微任务 / 退订 / 幂等锁那套，也顺手修了整轮停之后不触发 Emby 刷新、以及流先结束时 `finish` 要二次猜的问题；`finish` 里日志落库失败不再把收尾掐断（任务不会挂在 running）；fatal（流本身炸了）不再附带之前个别文件的建议。
- **整理镜像失败的文案分本地**：`context: "mirror"` 时撞名说「本地已有同名挡着 → 在 strm 管理里删掉或合并本地那份」，名字过长说「缩短模板」，不再把用户指向网盘。
- 前端：`reasonOf` 只认已知类别，不认识的归 unknown（标签不会空）；结束前不再每 200ms 分一遍组；`FileRow extends FailureInfo`。
- 两个分类器不再 import 三家客户端的错误类（`driveErrorFacts`），`messageOf` 收进 `lib/errors.ts`。
### 真机复测（2026-09-14 晚，评审修补之后）

115 真账号：`files/copy` 造 `/tv/_synctest115/`（一份 274 字节的长名 + 一份正常名），建一个只扫这个目录的本地 strm 任务，后端跑 scratch 拷贝的库。
- 全量同步：正常那份生成 strm，长名那份在写入口预判处拦下（`name-too-long`，没碰文件系统），历史里 `failures = {name-too-long: 1}`、`advice`「用整理改成标准命名，或在网盘上把名字改短」。
- 本地目标目录改成只读再跑：第一份撞 EACCES → `permission`（任务级）→ `stop$` 整轮停，历史里 `stopped = {reason: permission, remaining: 0}`、`errorMessage` 就是停下的原因 + 建议；目录改回可写后再跑恢复。
- 浏览器：任务日志页顶部「同步中止：没有写入 data 目录的权限 + 建议」横幅，「失败原因」面板两组（文件名过长 · 1 带「去整理这个目录」链接、没有写入权限 · 1），文件行各自带原因 + 建议，长名那行标「没去碰文件系统」；历史页两条记录分别显示「错误信息」和「建议」行。

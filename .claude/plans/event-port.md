# 进程内事件口：通知端口、暂存区搬家、文件落地事件

2026-09-30 设计模式分析里的第三档第 2 条。目标是让领域模块不再 import Telegram、打断 copy ↔ organize 的双向依赖，
触发链在一个地方看得见。**方案先给用户看，同意后再动手。**

## 现状（逐条核过代码）

**通知**：12 个模块 import `services/telegram/notify.ts`。其中 10 处只用 `notify(event)` 和几个类型 / `issueFromDrive`
（task/runner、life/monitor、follow、offline、copy、organize/run、library/health、emby/library-new、update、
routes/telegram/bot 的 `notifyPrefs`）；`password-check` 用 `notifySecurityAlert`、`oauth/authorize` 用 `notifyOAuthRequest`，
这两个是 Telegram 专属流程（批准按钮、安全告警），不算领域模块依赖通知渠道。
`notify()` 本身已经是事件形状：模块发一个 `NotifyEvent`，notify.ts 按偏好过滤、一小时去重、渲染、发送。
问题只在于端口住在 `telegram/` 目录里，import 方向是领域 → Telegram。

**copy ↔ organize**：
- copy → organize 三条边：`organize/duplicates.ts`（暂存区常量；文件头自己写着「独立一个文件是为了让监控 / 同步那边也能引用，
  不用去 import 整理的规划模块」——它就是个中立叶子，只是住错了目录）、`organize/mirror.ts`（本地 strm 镜像的挪 / 删 / 删空目录，
  import 的是 life/handlers，和整理无关）、`organize/auto.ts`（`maybeAutoOrganize` 在 copy/service 里已经走 `deps.organize` 注入；
  copy/manual 用 `autoOrganizeBusy` 查询）。
- organize → copy：`copy/queue.ts`（整理挪了目录后改队列里的路径、放行等整理的复制）、`copy/paths.ts`（算落点）。
  这个方向是「整理告诉复制队列发生了什么」，合理，保留。
- 模块级其实没有真正的 import 环（service → auto → queue，run → queue / paths），环在目录粒度上。

**Emby 刷新**：9 处调 `media-server.ts` 的 `scheduleEmbyRefresh` / `refreshEmbyNow`。它是叶子服务，领域 → 它是单向的，
改成事件只是换个写法，**不做**。

**复制登记 `enqueueCopy`**：offline / monitor / share / manual / copy 五处。调用方要拿返回值（排上几条、重复、没排上的原因）
写进自己的记录或响应，是请求 / 应答，**不是事件，不做**。

**自动整理触发 `maybeAutoOrganize`**：copy（经 deps）、offline、share/receive、life/monitor、agent/transfer 五处。
发出去就不管（内部 30 秒防抖、合并路径），是事件形状。share 和 agent 还要 `effectiveAutoMode` / `forcedOrganizeMode`
算出模式写进响应——那是查询，和触发分开看。

## 方案：三步，各一个提交

### 1. 通知端口挪到中立位置：`services/notify.ts`

- 新文件 `services/notify.ts`：`NotifyEvent`、`TaskTrigger`、`EmbyNewGroup`、`AccountIssue`、`issueFromDrive`、`classifyAccountIssue` 的再导出，
  以及 `notify(event): Promise<boolean>`——把事件派发给注册的 sink（`registerNotifySink(fn)` / `unregisterNotifySink`），
  没有 sink 时回 false；sink 抛错只记日志，不影响调用方。
- `telegram/notify.ts` 保留偏好过滤、去重、渲染、发送，把它的 `notify` 改名成 `telegramNotify`（sink），
  `notifySecurityAlert` / `notifyOAuthRequest` / 按钮发送 / `notifyPrefs` / `DEFAULT_NOTIFY` 原样留着。
- `index.ts` 在注册路由之前 `registerNotifySink(telegramNotify)`。
- 10 个领域模块的 import 改指向 `services/notify.ts`；6 个 `deps.notify` 测试缝不动（默认值就是端口的 `notify`）。
- 测试：`telegram/notify.itest.ts` 直接调 `telegramNotify`（它测的是渲染和偏好）；新加 `services/notify.test.ts`
  测「没 sink 回 false、sink 抛错不影响别的 sink、注销后不再收」。其它 itest 只看 `deps.notify` 收到的事件，不受影响。
- `password-check.test` / `update.itest` / `oauth.itest` 用 `setNotifySender` / `setButtonSender` 换 Telegram 发送层：不动。

### 2. 暂存区常量和本地镜像搬家（纯搬家，改 import）

- `organize/duplicates.ts` → `services/strm/staging.ts`（重复文件目录、归档目录、`isStagingDir`）。
- `organize/mirror.ts` → `services/strm/mirror.ts`。
- 改 import：copy/service、copy/manual、life/handlers、task/runner、organize/auto、organize/plan、organize/run。
- 搬完 copy 目录对 organize 只剩 `auto.ts`（触发 + 查询）。

### 3. 文件落地事件 `files.landed`

- `lib/events.ts`：约 40 行的类型化 emitter（`on` / `off` / `emit`，监听者抛错记日志不外抛，同步派发）。
- `services/events.ts`：声明 `AppEvents = { "files.landed": AutoOrganizeInput }` 和单例 `events`。
  以后要加的事件（比如复制完成、转存完成）都在这一个文件里登记，触发链在这里看得见。
- 五个触发点都改成 `events.emit("files.landed", …)`；organize/auto 提供 `startAutoOrganize()`（幂等）订阅，
  `maybeAutoOrganize` 不再导出。index.ts 启动时调；用到自动整理的 itest 在 `before` 里调（它们本来就 import auto.ts 拿
  `__test_flushAutoOrganize`）。copy/service 的 `deps.organize` 缝删掉，copy 的 itest 里桩 `deps.organize` 的地方
  改成订阅事件。
- `autoOrganizeBusy` 和 `effectiveAutoMode` / `forcedOrganizeMode` 是查询，保留导出；copy/manual → organize/auto 只剩这一条查询边，
  organize 不 import copy/manual，不成环。

## 不做的、以及为什么

- Emby 刷新、`enqueueCopy` 不改成事件（上面说了）。
- offline / monitor / share 对 organize 的其它 import（`effectiveAutoMode` 算 `holdForOrganize`）保留：单向、是查询。
- 不引第三方事件库；不做异步事件队列 / 持久化——进程内、同步派发够用，出错的地方就在调用栈里。

## 风险

- 启动顺序：sink 要在任何可能发通知的东西起来之前注册（index.ts 里放在 `registerErrorHandling` 之后、对账之前——对账会发通知吗？
  `reconcileInterruptedExecutions` 不发；保险起见放最前）。
- 测试接线：改成事件后，凡是断言「复制完 / 转存完会触发整理」的用例都要确保订阅了；漏一个用例就会假通过。
  对策：`startAutoOrganize()` 放进那几个 itest 的 `before`，并在 events 的测试里断言「没订阅时 emit 不抛」。
- 行为：三步都不打算改任何行为；全量测试 + 手工核对一遍通知路径（任务完成、监控告警）在真机日志里还发得出来。

## 验证

- 每步：后端全量测试、tsc、eslint。
- 第 1 步额外：真机（或本地起后端）跑一次任务，Telegram 收到「任务开始 / 完成」。
- 第 3 步额外：转存一次、复制一次，整理页出现待确认清单（或自动执行）。

## 进度

2026-09-30 三步做完，各一个提交，都不改行为；每步后端全量测试、tsc、eslint 都过。

1. **通知端口**（`refactor(notify)`）：`services/notify.ts` 放 `NotifyEvent` / `TaskRef` / `TaskTrigger` / `EmbyNewGroup` /
   `AccountIssue` / `issueFromDrive` / `DEFAULT_NOTIFY` / `notifyPrefs` 和 sink 登记（`registerNotifySink`，`notify()` 逐个派发、
   渠道抛错只记日志、没渠道回 false）；`telegram/notify.ts` 的入口改名 `telegramNotify`，index.ts 启动最前面登记。
   10 个领域模块 + routes/telegram/bot 改 import；`telegram/format.ts` 里重复的 `TaskRef` 删了。
   测试：新 `services/notify.test.ts`（3 条）；`update.itest` 自己登记 Telegram sink（它是端到端断言 Telegram 文案的唯一一个）；
   6 个只 import 类型的 itest 改指向端口。src 里还 import `telegram/notify` 的只剩 index.ts、password-check、oauth/authorize、telegram/commands。
2. **搬家**（`refactor(strm)`）：`organize/duplicates.ts` → `strm/staging.ts`，`organize/mirror.ts` → `strm/mirror.ts`，九处 import 改路径，
   staging 的文件头改成说明它为什么住在 strm/。
3. **files.landed**（`refactor(events)`）：`lib/events.ts`（类型化 emitter，`on` 返回注销函数，监听者抛错记日志不外抛，
   泛型约束用 `E extends object`——接口没有索引签名，`Record<string, unknown>` 过不了 tsc）+ `services/events.ts`
   （`FilesLandedEvent`、`AppEvents`、单例 `events`）。五个触发点（复制完成 / 云下载 / 转存 / 监控 / 智能体转存）都 `emit`；
   `organize/auto.ts` 的 `maybeAutoOrganize` 改成内部的 `onFilesLanded`，`startAutoOrganize()` 幂等订阅，index.ts 启动时调。
   copy/service 的 `deps.organize` 缝删了。测试：`lib/events.test.ts`（3 条）；`auto.itest` / `manual.itest` 改成发事件；
   follow / monitor / manual / mcp-copy / mcp-p3 五个 itest 的 `before` 里 `startAutoOrganize()`；copy.itest 订阅事件记录触发；
   archive-source / remove-source 的 `organize: () => {}` 桩删掉（没订阅就是空操作）。
   做完 copy → organize 只剩 `copy/manual.ts → organize/auto.ts` 的 `autoOrganizeBusy` 查询（organize 不 import manual，不成环）；
   organize → copy 保留 queue / paths 两条。

**没做 / 待验**：真机没验（任务完成的 Telegram 通知、转存后自动整理）——三步都是接线，测试覆盖了每条路，但 index.ts 的登记顺序
只能真起一次后端看日志确认。

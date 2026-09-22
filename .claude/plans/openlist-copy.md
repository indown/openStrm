# 复制到 OpenList：从「云下载专属」变成通用的后续动作（设计）

> 状态：**三个阶段已实施**（`55ebe6c` / `2852933` / `f534d20`，未推送、未发版；末节有实施记录和和设计稿不一样的地方）。2026-09-22。起因：用户问「复制到 OpenList 是不是可以优化一下了」，并确认四个方向都要，外加「不止 115，夸克、以后接入的网盘都能触发复制」。

## 现状

配置 `settings.openlistCopy`（`packages/shared/src/types/settings.ts:120`）：一个 OpenList 账号 + `srcDir`（115 默认下载目录**在 OpenList 里的完整路径**，手打）+ `dstDir`（目标目录，手打）。

能用它的只有一条路：云下载页添加任务、**且下到 115 默认目录**（不选任务、不选目录）时勾「下载完成后让 OpenList 复制走」。别的一律拒绝：

```ts
// services/offline/service.ts:329
if (opts.copyToOpenlist) {
  if (task || dirId != null) throw new HttpError(400, "「复制到 OpenList」只支持下载到 115 默认目录");
```

之后的机制是对的，值得整个搬走复用（`services/offline/service.ts:647 submitOpenlistCopy` / `:698 pollOpenlistCopies`）：

- 115 下完 → 带 `refresh:true` 列 `srcDir`（不刷新看不见刚下完的文件）→ 产物名出现了才提交 `/api/fs/copy`；没出现不算失败，最多等 10 轮（`copyWaits`，和「115 列表里找不到任务」的 `misses` 分开计）。
- `/api/fs/copy` 对目录是「父任务展开子任务」，父任务结束只代表列目录完成，真正的进度在 `/api/task/copy/undone|done` 里，所以要一直盯到 undone 里没有自己的任务，再去 done 里对成败（按 `endedAt` 滤掉陈年同名任务）。
- 回执落在 settings 表的 `offline.followups` 键，重启不丢；7 天没结果就放弃；提交失败重试 3 次。

**四个短板**（对应用户点的四项）：

1. 只认 115 默认目录。根因是 `srcDir` 是一条手打的死路径，没有「网盘路径 → OpenList 路径」的换算。
2. 只有云下载能触发。转存 / 追更 / 网盘监控落下的新文件都没法复制走。
3. 复制完只发一条 Telegram（`notify({type:"offline-copied"})`），Emby 不知道、源文件留在网盘上。
4. 复制失败只能重下 115 任务（`offlineRestart`），没法单独重试复制。

还有一条用户明确提的：**不止 115**。夸克、以后的网盘都要能触发。现在这套只存在于 `offline/service.ts` 这条 115 专属的流水线里。

## 关键缺口：网盘路径 ↔ OpenList 路径

`DriveProvider`（`services/drive/types.ts:89`）有 `resolvePath` / `listDir` / `listSubtree` / `write`，但**没有任何东西知道这个网盘挂在 OpenList 的哪个路径下**；`AccountInfo` 里也没有。全站唯一的映射就是那条 `srcDir`。

所以第一件事是把映射补成配置：

```ts
export type OpenlistCopySettings = {
  account?: string;                    // 用哪个 openlist 账号调 API（不变）
  dstDir?: string;                     // 默认目标目录（不变）
  /** 网盘账号名 → 它在 OpenList 里的挂载根，例如 { my115: "/115", quark1: "/quark" } */
  mounts?: Record<string, string>;
  /** 复制成功后把网盘上那份删掉（搬运）。默认 false */
  deleteAfterCopy?: boolean;
  srcDir?: string;                     // 旧字段，只给「115 默认下载目录」那条路兜底，见「迁移」
};
```

有了 `mounts`，任意网盘路径都能换算：`openlistPath = mounts[account] + 网盘绝对路径`。115 挂在 `/115`、任务目录是 `/tv`，那么 `/tv/某剧/S01E01.mkv` 在 OpenList 里就是 `/115/tv/某剧/S01E01.mkv`。夸克、以后的网盘同理，功能代码里不出现 `accountType === "…"`（`services/drive/types.ts:1` 的规矩）。

**为什么放设置里而不是账号表**：挂载点是「这个网盘在那个 OpenList 实例里的位置」，是两个账号之间的关系，不是网盘账号自己的属性；而且复制功能本来就只认一个 OpenList 账号（`openlistCopy.account`），放一起改一处就够，也不用动 `AccountInfo` 和账号页。

**界面**：设置页「复制到 OpenList」里，账号下面列出所有 115 / 夸克账号，每个给一行挂载根（`InputGroup` + 浏览按钮，直接从那个 OpenList 账号的根目录挑，`api.directory.remote`）。填完点「检查」：列一遍 `mounts[account]`，把这个账号下每个任务的 `originPath` 拼上去验证存在，不存在就指出是哪一条。

## 方案

### 1. 把复制抽成一个服务：`services/copy/service.ts`

从 `offline/service.ts` 里搬出来，改成不认来源、只认「网盘账号 + 一批网盘绝对路径 + 目标目录」：

```ts
export interface CopyRequest {
  account: string;        // 网盘账号名（115 / 夸克 / …）
  paths: string[];        // 网盘绝对路径，文件或目录
  dstDir?: string;        // OpenList 目标目录；不给用设置里的 dstDir
  taskId?: string;        // 有任务就记上，界面和「整理挪目录」时要用
  trigger: CopyTrigger;   // "offline" | "share" | "follow" | "monitor" | "manual"
}
/** 登记待复制；同步返回，内部排队，绝不往调用方抛 */
export function enqueueCopy(req: CopyRequest): void;
```

队列记录落 settings KV 的新键 `copy.queue`（`db/keys.ts`），形状照着 `OfflineFollowup`（`offline/service.ts:66`）：`{ id, account, srcPath, name, dstDir, taskId, trigger, status, detail, attempts, waits, misses, copyTaskId, submittedAt, addedAt }`。一个 `createPollingLoop`（30 秒，没待办自己停）负责推进，阶段和今天完全一样：**等产物在 OpenList 里可见 → 提交复制 → 盯任务 → 成败落地**。云下载那条流水线改成只管登记，不再自己做复制。

去重靠 `(account, srcPath, dstDir)`：队列里已经有同一条待办就不重复登记（监控会对同一个文件反复报事件）。提交前再列一遍目标目录，已经有同名的就跳过记「目标已存在」——`/api/fs/copy` 的 `overwrite` 一直是 `false`，不拦的话 OpenList 那边会堆同名任务。

**合并**：同一轮里同一个源目录下的多个名字合成一次 `/api/fs/copy`（`openlistCopy(account, srcDir, dstDir, names[])` 本来就收数组）。监控是一个文件一个事件，不合并会把几百个文件排成几百个任务。

### 2. 四个触发点

都在「新文件已经落到网盘上」那一刻，和 `maybeAutoOrganize` / `scheduleEmbyRefresh` 并排，一样是 `void`、失败只记日志：

| 来源 | 接在哪 | 已有的路径信息 |
|---|---|---|
| 云下载 | `offline/service.ts:629` 旁边（strm 回执完成处）；默认目录那条保持现在的即时登记 | `task.originPath` + `f.subPath` + 产物名 |
| 转存 | `share/receive.ts:107` 旁边（`maybeAutoOrganize` 已经在那儿算好 `paths`） | `fullOriginPath` + 每个 `item.name` |
| 追更 | `follow/service.ts:575` 旁边，用现成的 `landed`（任务相对路径） | `task.originPath` + `landed[]` |
| 监控 | `life/monitor.ts:389` 旁边，同样守 `res.arrived && res.changed` 和 `ownOk`（整理自己造成的事件不能再复制一遍） | `ev.path` 就是网盘绝对路径 |

监控那条沿用 `maybeAutoOrganize` 的 `debounce`（30 秒）思路：攒一会儿再登记，正好也让上面的「同源目录合并」生效。

### 3. 开关：任务级 + 一次性覆盖

照抄 `organize` 的那套（`TaskDefinition.organize` → `taskInputSchema` → `AddTaskDialog`，见 `services/organize/settings.ts:81`）：

```ts
// packages/shared/src/types/task.ts
copyToOpenlist?: { enabled?: boolean; dstDir?: string };   // dstDir 不填用全局的
```

- 任务弹框里一个开关 +（开了才出现的）目标目录选择器，说明写「转存 / 追更 / 云下载 / 监控到新文件时，让 OpenList 把它复制到这里」。
- 一次性覆盖：转存弹框、`POST /api/share`、`POST /api/library/:id/save-to-task` 加 `copy?: boolean`，和现有的 `organize?: boolean` 同一个位置、同一套写法。
- 全局前提缺失（没配 OpenList 账号 / 这个网盘账号没填挂载根）→ 一律当关，和「没配 TMDB key 就不自动整理」（`organize/auto.ts:59`）一个路子。
- 任务存的是 JSON blob（`db/repositories/tasks.ts:8`），**不用迁移**。

### 4. 复制完之后

按顺序，每一步失败都不影响前一步的「已复制」：

1. `scheduleEmbyRefresh()`——复制到本地盘的就是真文件，Emby 得扫一遍才看得见。
2. 目标目录正好落在某个 **OpenList 账号任务** 的 `originPath` 下时，按那个任务的策略 `maybeAutoOrganize({ task, paths, trigger: "copy" })`。落在别处（纯备份目录）就不整理。
3. `deleteAfterCopy` 开着时，删掉网盘上那份——**走 Provider 的 `write.remove`**（`services/drive/types.ts:86`），不走 OpenList 的 `/fs/move`：OpenList 的移动不跨存储，而且删源必须用网盘自己的接口才准。只有 `status === "done"` 且目标目录里确认看得见同名条目才删。
4. `notify`：现有的 `offline-copied` / `offline-copy-failed` 改成通用的 `copy-done` / `copy-failed`（带 trigger 和任务名），旧的两个保留一轮以免 Telegram 设置里的开关语义突变。

### 5. 失败能重试

- 新路由：`GET /api/copy`（最近的队列记录）、`POST /api/copy/:id/retry`（失败的重新排队，计数清零）、`DELETE /api/copy/:id`（不跟了）。
- 界面：云下载页现在那行 `FollowupLine`（`app/offline/page.tsx:627`）照旧显示，失败时多一个「重试复制」按钮；任务卡片上显示「复制中 N / 失败 N」，点开是同一个列表。
- 失败原因写全：OpenList 那边的 `error` 原文 + 我们这边的阶段（没看见产物 / 提交失败 / 复制失败 / 目标已存在）。

### 6. 整理挪了目录怎么办

队列里带 `taskId` 的待办记的是网盘绝对路径，整理会在网盘上改名 / 移动。照 `rewriteOfflineSubPaths`（`offline/service.ts:759`）和 `rewriteFollowSubPaths`（`follow/service.ts:641`）再写一个 `rewriteCopyPaths(taskId, mappings, dryRun)`，接在整理执行完的同一处。

## 迁移

`mounts` 是新键，`dstDir`、`account` 不动。唯一尴尬的是 `srcDir`：它是「115 默认下载目录在 OpenList 里的完整路径」，从它反推不出挂载根（不知道默认目录在 115 上的路径是什么）。

两条路，**建议第一条**：

1. **查一次 115 的默认下载目录路径**（`offlineDownPaths` 给的是 id + 名字），有了它就能从旧的 `srcDir` 反推出挂载根，自动填进 `mounts`，`srcDir` 随后作废（`0017_*.sql` 照 `0007_drop_retired_settings.sql` 的样子删键）。
   **前提没验**：`fsFiles` 现在只取了响应里的 `data` / `count`（`services/cloud-115/client.ts:342`），115 的文件列表接口是不是真带祖先链（`path: [{file_id,file_name}…]`）要先打一次接口确认；确认不了就直接走第二条，别为它硬凑。
2. 反推不了就保留 `srcDir` 只服务「下到 115 默认目录」这一条老路，设置页标成「旧配置」，新装的人只填 `mounts`。

无论哪条，**已经配好的人升级后不能失效**：`mounts` 空 + `srcDir` 有值时，默认目录那条照旧工作。

## 分阶段

1. **打底**：`mounts` 配置 + 设置页那一节重做（挂载根 + 检查按钮）+ `services/copy/service.ts`（队列、循环、去重、合并）+ 云下载改成调它、解除「只能默认目录」+ 重试路由和按钮。这一阶段做完，115 和夸克的云下载 / 任意目录都能复制走。
2. **铺开**：任务级开关 + 转存 / 追更 / 监控三个触发点 + 一次性覆盖参数 + 任务卡片上的状态。
3. **收尾**：复制完 Emby 刷新、落在 OpenList 任务里就自动整理、`deleteAfterCopy`、通知事件改名、`rewriteCopyPaths`。

## 不做

- **多个 OpenList 账号同时当目标**：复制功能仍然只认一个 `openlistCopy.account`。真有两个目标的需求再说。
- **OpenList → 网盘 的反向复制**：现在没有场景。
- **覆盖同名**：`overwrite` 保持 `false`，撞名就跳过并记原因，不悄悄盖掉别人的文件。
- **按文件类型过滤**：先整目录 / 整条目复制；要不要只复制视频文件等做完一轮再看。

## 风险

- **夸克的可见性延迟**比 115 更没谱（监控那边本来就是靠轮询对比），`copyWaits` 的轮数可能要按网盘分开配；先沿用 10 轮，真机验的时候盯这个数。
- **监控 + 自动整理同时开**：整理会把文件挪走，队列里的路径可能在复制前就失效。靠 `ownOk` 守住整理自己造成的事件 + `rewriteCopyPaths` 跟着改；真机要专门验「监控到新文件 → 自动整理 → 复制」这条串起来的顺序。
- **大目录**：一个目录几百个文件时 OpenList 会展开成几百个子任务，`/api/task/copy/undone` 一轮拉回来的量不小；按名字匹配（`r.name.includes(f.name)`）在同名文件多的时候可能串味，阶段一就把匹配改成「父任务 id + 提交时间窗」双条件。
- **删源**（`deleteAfterCopy`）是不可逆的，默认关，界面上要说清「复制成功且目标里确认看得见才删」，并且第一版只对「整条目复制」生效，不对单文件事件生效。

## 测试

- 单测：路径换算（`mounts` + 网盘路径 → OpenList 路径，含中文、空格、结尾斜杠）、去重、同源目录合并、`rewriteCopyPaths`。
- 假 OpenList：给 `Deps.openlist`（`offline/service.ts:150` 已有这个注入口，搬过去继续用）写一个假实现，覆盖「产物迟迟不可见」「父任务展开子任务」「done 里有陈年同名任务」三种。
- FakeDrive 覆盖 `write.remove`（删源）那一步。
- 真机：115 + 夸克各跑一遍「转存 → 复制 → Emby 刷新」，以及「监控到新文件 → 复制」。

## 实施记录（2026-09-22）

三个阶段一口气做完，三个提交，都在 v2 上（未推送、未发版）：

| 提交 | 内容 |
|---|---|
| `55ebe6c` | 挂载映射 + `services/copy`（`paths.ts` / `queue.ts` / `service.ts`）+ 云下载改成交接 + `/api/copy` + 设置页一节重做 + 云下载页的队列面板 |
| `2852933` | 任务级开关（`TaskDefinition.copyToOpenlist`）+ 转存 / 追更 / 监控三个触发点 + 一次性勾选 |
| `f534d20` | 复制完：Emby 刷新、目标落在 OpenList 任务里就自动整理（`trigger: "copy"`）、按任务删源、通知改名、`rewriteCopyPaths` |

**和设计稿不一样的几处**（都是评审 / 实现时发现的）：

- **目标目录按层级摆，不是平铺**。设计稿只说了 `dstDir`，但监控是一个文件一条事件，平铺过去一季四十集会挤进同一个目录还撞名。`CopyRequest` 因此多了 `rootPath`（通常是 `task.originPath`），`dstDirFor` 把相对那一段的目录结构原样搬到目标下面。
- **提交前先 `mkdir`**：`/fs/copy` 不会自己建目标目录。
- **源目录在 OpenList 里不存在 → 第一轮就失败**（挂载根填错了），和「产物还没出现」（等 10 轮）分开。两个计数器 `waits` / `misses` 各管一个阶段，换阶段清零对方。
- **保留期拆开**：失败留 7 天、办完留 2 天、上限 500 条。监控一个文件一条记录，共用一个窗口的话一批成功会把唯一能动手的失败记录挤掉。
- **合批在 tick 里做，不在登记时 debounce**：登记就落 KV（进程被杀不丢），`SETTLE_MS = 10s` 只是让同目录的兄弟文件凑进同一批。
- **删源核对 nodeId**：整理可能已经把文件挪走、原路径上换成了另一个同名文件，只按路径删会删错。
- **追更给转存传 `copy: false`**，自己按整轮的新增登记一次，来源才显示成「追更」而不是「转存」。
- **`resolveDirPath` 做成了 offline 的注入点**：`handoffCopy` 要把 115 的目标目录 id 反解成路径，测试里不能打接口。

**验证**：后端 990 个测试全过（新增 43 个：`copy.itest.ts` 31、`paths.test.ts` 7、路由 4、监控 2、追更 1、crud 1，外加云下载那边重写的几条）、三包 tsc / eslint、`next build` 都过。本机用一个假 OpenList（`http.createServer`，实现 login / fs.list / fs.mkdir / fs.copy / task.copy.undone|done）在浏览器里走通了整条链路：设置页填挂载根 → 「检查这些目录」通过 → 队列面板显示失败记录 → 点「重试复制」→ 列源目录、建目标目录、提交复制（`names: ["E01.mkv"]`、`overwrite: false`）→ 盯任务 → 「已复制」，循环自己停。任务弹框的开关、目标目录、删源三件也在浏览器里看过。

**还没验的**：真机（真 115 / 夸克 + 真 OpenList）；转存 / 追更 / 监控三个触发点只有 itest，没在真机上跑过；旧 `srcDir` → 挂载根的自动换算没有真 115 账号可验（逻辑有测试，接口那步没有）。

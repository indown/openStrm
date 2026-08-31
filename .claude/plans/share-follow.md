# 分享追更（share follow）—— 设计与进度

> 状态：**实施中**。最后更新：2026-08-31

## 要解决的事

每周更新的剧集，分享链接不变、内容在涨。现在每次都要重开链接、勾新集、再"保存到任务目录"。
转存链路（`POST /api/115/share action=receive` → `saveSelectionToTask()` → `generateStrmForSelected()`）
没有任何地方记住"这个分享已经存过哪些文件"。

## 方案

把一次「分享目录 → 任务目录」的转存记成一条**追更订阅**：后台按周期重新列这个分享目录，
和上次快照比，只把**新增**的转存到同一位置、生成 strm、发通知。

### 订阅（`share_follows` 表，迁移 0009）

`(shareCode, receiveCode, watchCid, scope) → (taskId, subPath)` + `intervalMinutes` + 快照 `known` + 最近动态 `recent`。

- 独立表而不是挂影库 / KV：影库是可选书签；订阅是长期 CRUD 实体，还带几百条快照。`libraryId` 软链接借封面标题。
- **范围 scope** 从这次勾选推出来：勾了文件 → `[""]`（追当前目录的一切新增）；只勾目录 → 目录名列表（只追这些目录里面）。
- **快照** = 订阅时范围内全部现有条目（不只是勾选的）。当时没勾的 `sample.mkv`、别的季永远不会被补转存。
- 唯一键 `(share_code, watch_cid)`：同一分享目录只允许一条。

### 一次检查

```
递归列范围内的分享目录（深度 ≤ 4 / 3000 条 / 30 次请求，超了报"目录过大"）
→ diff（services/follow/diff.ts，纯函数）：
    路径未知且 sha1 未知 → 新增；同路径 sha1 变 → 被替换（只记不动）；sha1 已知路径变 → 改名/搬家（只记不动）；
    新目录整项转存，其后代不再单独算；新目录里全是已知 sha1 → 视为搬家跳过
→ 按父目录分组 → saveSelectionToTask(mode=sync)（fsDirGetId 必须非 0，否则该组报"目标目录不存在"）
→ 成功的写进 known，记 recent，scheduleEmbyRefresh()，Telegram follow-added
```

### 调度与状态

- 每条 `intervalMinutes`（预设 1h/3h/6h/12h/24h，默认 360，下限 30）；一条循环每 60s 挑到期的顺序跑，条间隔 2s，下次时间 +10% 抖动；`POST /:id/check` 立即跑。
- 状态：`idle | checking | error | expired | stale`，另有 `enabled`。
  - error：网络/cookie/封控 → 保留，退避 interval×2^streak 封顶 24h；cookie/封控走 `classifyAccountIssue` 账号告警。
  - expired：`share/snap` 回 `state=false`（`ShareApiError`）连续 3 次 → `enabled=false`，通知一次。
  - stale：60 天没有新增 → `enabled=false`，通知一次，可手动继续。
  - 任务被删 → error「任务已不存在」。
- 全在库里，启动时 `startFollowWatcher()` 续跑（同云下载回执）。

### 接口

- `GET /api/follow` → `{ follows: ShareFollowSummary[], watcher }`（不带 known）
- `POST /api/follow`（建订阅并出快照）、`PUT /:id`（name/enabled/intervalMinutes/taskId/subPath/receiveCode；enabled=true 时把 expired/stale/error 复位）、`DELETE /:id`、`POST /:id/check`
- `POST /api/115/share action=receive` 与 `POST /api/library/:id/save-to-task` 加可选 `follow: { intervalMinutes }`：转存成功后顺手建订阅，建失败只在响应里带 `followError`
- Telegram：`follow-added / follow-expired / follow-stale / follow-failed`，开关 `notify.follow`

### 前端

- `SaveToDriveDialog` 第四项「转存后追更」+ 间隔下拉，文案随选择变
- 新页 `/follow`「追更」（侧栏影库之后）：名称·范围 / 目标 / 检查周期·下次·上次 / 最近新增 / 状态 / 操作（立即检查、暂停·继续、编辑、删除）；有 checking 才 5s 轮询
- 影库卡片「追更中」徽标（按 shareCode + shareRootCid 匹配）

### v1 不做

被替换/改名/搬家的文件只提示不动；整站合集级分享直接报过大；Telegram「转存并追更」按钮与 `/follow` 命令放 v2。

### 顺手修

`services/library/save-to-task.ts` 只判 `id == null`，`fsDirGetId` 对不存在的路径回 `id=0` → 会转存进网盘根目录；改成和 `offline/service.ts` 一样判 `"0"`。

## 进度

- [x] 1. shared 类型 + schema/迁移 0009 + repository
- [x] 2. `services/follow/diff.ts` + `diff.test.ts`
- [x] 3. `services/follow/service.ts`（deps 注入、tick、watcher）+ `service.itest.ts`
- [x] 4. `routes/follow/index.ts` + `index.ts` 接线 + 两个保存接口的 `follow` 参数 + `id=0` 修复 + 路由 itest
- [x] 5. Telegram 事件与开关
- [x] 6. 前端：对话框勾选框 → `/follow` 页 → 影库徽标 → Telegram 页开关

## 验证（2026-08-31）

- 后端整套 300 个测试全过（新增 31 个：diff 单测 13、service 状态机 16、路由 2），lint / typecheck 干净。
- 真机式界面验证：隔离 CONFIG_DIR/DATA_DIR + 种子数据（scratchpad/seed-follow-demo.mts）起后端托管静态导出，Chrome 走查：
  /follow 四种状态徽标、暂停/继续/编辑/删除、SaveToDriveDialog 勾选后出间隔下拉、影库卡片「追更中」徽标。
  意外覆盖到真实链路：点「继续」后循环 60s 内真的对 115 发了 share/snap（假 share code）→「分享不可用：参数错误」→ 退避 12h，符合设计。
- **未真机验证**（需要真实分享 + cookie）：真订阅建快照、新增集转存与 strm 生成、expired/stale 的真实触发、Telegram 四个通知的实际文案。

## 备注

界面上被盯目录当前不可改（改了快照就对不上）；要换目录删掉重建订阅。

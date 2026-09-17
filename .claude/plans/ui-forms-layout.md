# 表单 / 控件 / 布局 —— 方案

> 2026-09-17 起草，基于 v2 的 `37feca8`。
> 上一轮 `ui-tech-style.md` 修的是**质感**（色温、面板厚度、等宽字体、运行中动态、登录页背景），这一轮修的是**控件语义和信息结构**，两件事不重叠。

---

## 一、现状诊断（读完 `apps/frontend/src` 全部 11 个页面）

`components/ui/` 那 21 个文件**一个字都没改过**，全是 shadcn 出厂件。产品自己的语义（路径、cron、模板、扩展名、API Key）没有一个落到控件上。具体：

| # | 现象 | 证据 |
|---|---|---|
| 1 | 设置页是一条 3000px 的直线：8 个 section 一个列，**唯一的保存按钮在最底部** | `settings/page.tsx:155,207,281,335,371,407` + 两个子组件；按钮在 `:479` |
| 2 | 没有脏状态保护，滚到底填完点侧栏就没了 | `grep beforeunload\|isDirty` 零命中 |
| 3 | 两套表单写法并存：5 个文件 `useForm` + zod，6 个裸 `useState`（没有字段级校验，错误只在 toast 里） | settings / OrganizeSection / telegram / life / AdjustDialog / RenameDialog |
| 4 | 开关语义的布尔项用了勾选框 | 12 处（见下表），另有 22 处是真多选，不动 |
| 5 | 主操作不带品牌色：`--primary` 是黑（浅）/ 白（暗），brand 青蓝只在侧栏竖条、图标、焦点环 | `globals.css:113` 那条注释是当时的有意决定 |
| 6 | 对话框宽度 **15 种写法** | 32 个文件，`sm:max-w-[560px]` / `[460px]` / `[425px]` / `[420px]` / `lg` / `xl` / `2xl` / `[1100px]`… |
| 7 | 全站 `max-w-6xl`，表格页在 1920 屏上两侧各空 300px | `LayoutWrapper.tsx:236` |

---

## 二、这一轮做什么

### 2.1 `<Switch>` + `<SwitchRow>`，替掉 12 处开关语义的勾选框

手写，**零新依赖**——`@radix-ui/react-switch` 没装，而一个 `role="switch"` 的 `<button>` 就够：键盘（空格 / 回车）是 button 自带的，`<label htmlFor>` 对 button 也生效（button 是 labelable element）。

换：`settings/page.tsx` 1（Emby 匿名直链）、`UpdateSection` 2、`OrganizeSection` 4、`AddTaskDialog` 3（CheckboxRow）、`telegram/page.tsx` 2 处 map（权限 / 通知，**点一下立即生效**，最纯粹的开关场景）。

不换（真多选，勾选框是对的）：`life` 3（账号 / 模式多选）、`strm` 4、`offline` 5、`UnitList` 3、`AddOfflineTaskDialog` 2、`SaveToDriveDialog` 2、`ShareDetailDialog` 1。

顺手把 12 处手抄的 `<label className="flex items-start gap-2 rounded-md border p-3">` 收成一个 `<SwitchRow>`：标题 + 说明在左，开关在右。

### 2.2 设置页：sticky 保存条 + 脏状态

- 把 `onSave` 里拼 `saveData` 的那段抽成 `buildPayload()`，加载完存一份 baseline，**递归比叶子**算出"N 处未保存"。
- 脏了才出现的保存条：`sticky bottom-4`，跟着 `max-w-3xl` 那一列走（不盖侧栏）。里面是「N 处未保存」+ 放弃 + 保存。
- ⌘S / Ctrl+S 保存；脏着离开页面 `beforeunload` 拦一下。
- 底部那行留「下载备份」和 WAL 那句说明——它不是表单动作。

### 2.3 主操作上品牌色

`--primary` 指向品牌色。**浅色下不能直接用 `--brand`**：算过了，`oklch(0.6 0.13 220)` 配白字只有 **3.53:1**，AA 正文要 4.5。压到 `oklch(0.52 0.13 220)`（#00789c）是 **4.83:1**。暗色的 `--brand` 配近黑字是 9.33:1，直接用。

连带变的（都合理）：勾选框选中态、`selection:bg-primary`、`link` 变体的文字色。

### 2.4 对话框宽度收成 3 档

`DialogContent` / `AlertDialogContent` 加 `size` 变体，15 种写法归一：

- `sm` → `sm:max-w-md`：确认框、单字段（原 420/425/460）
- `md` → `sm:max-w-xl`（默认）：常规表单（原 520/560/600/lg/xl）
- `lg` → `sm:max-w-3xl`：目录浏览、列表（原 2xl/760/1100）

只管宽度。`max-h-[85vh] flex flex-col` 留在调用点——那是每个弹框自己的滚动结构，统一进变体会改掉布局。

### 2.5 容器放宽到 `max-w-[88rem]`

改 `LayoutWrapper` 一处。表单页本来就自己收 `max-w-3xl`，不受影响；PageHeader 的说明文字加 `max-w-3xl`，免得在 1920 上拉成一行长句。

---

## 三、撤掉的一项：分段控件

评审时说"≤3 项的枚举换分段控件"，**实际读了选项文字之后撤掉**。全部 12 处 `<Select>`：9 处是数据驱动的（任务 / 账号 / 间隔选择器，Select 本来就对），剩下 3 处枚举的选项标签是整句——`智能：「: 」→「 - 」，其余「-」`、`把握大的直接执行，其余待确认`、`Emby：[tmdbid=123]`——分段控件放不下。只有 `AddTaskDialog` 的「库类型」（混合 / 电影 / 剧集）够短，为一处新增一个原语不划算。

---

## 四、落地顺序（每步之间都能停）

| 步 | 内容 | 提交 |
|---|---|---|
| 1 | `switch.tsx` + `switch-row.tsx` + 12 处替换 | 一个 |
| 2 | 设置页保存条 + 脏状态 + ⌘S + 离开拦截 | 一个 |
| 3 | `--primary` 换品牌色 | 一个 |
| 4 | 对话框 3 档宽度 | 一个 |
| 5 | 容器宽度 | 一个 |

**验证**：`3223` 上看浅色 / 暗色 / 窄屏（dev 常驻时不要在同目录 `next build`）；收尾 `typecheck` + `lint` + 一次干净构建。

---

## 五、下一轮的候选（这次不做）

- ⌘K 命令面板（`cmdk`）——11 个页面 + 一堆弹框，这是收益最大的一项，但要新依赖，单独一轮。
- 165 处 `text-xs text-muted-foreground` 的说明文字降级（label 旁边一个 ⓘ，长文收进 Popover）——编辑量大，且要逐条判断哪些能删。
- 路径组合输入（前缀 addon + 浏览按钮同一个边框）、扩展名 tag 输入。
- 6 个裸 `useState` 表单统一到 react-hook-form。

---

## 实施记录

### 2026-09-17（worktree `task-ui`，基于 v2 的 `37feca8`）

五步全部做完，**零新依赖**，首屏共享 JS 仍是 100 kB。

| 提交 | 内容 |
|---|---|
| `91da14b` | `ui/switch.tsx` + `switch-row.tsx`，12 处开关语义的勾选框换掉（`AddTaskDialog` 里那个 RHF 版本留在本地，和共享的那个同一副长相） |
| `6bcdcaf` | 设置页 `buildPayload` / `countChanges` / baseline，sticky 保存条、⌘S、`beforeunload` |
| `e38d2a8` | `--primary` 换品牌色（浅色 `oklch(0.52 0.13 220)`，暗色指向 `--brand`） |
| `dedad02` | 对话框三档宽度 |
| `7a41b3a` | 容器 `max-w-6xl` → `max-w-[88rem]`，PageHeader 说明收 `max-w-3xl` |

**验证**：typecheck + lint + 一次干净构建全过。浏览器真机（假后端在 4000，dev 在 3223）逐条看过：

- 开关浅色 / 暗色都对，禁用态（strm 路径 URL 编码）是半透明；**点标题文字能翻转**，`<label htmlFor>` 对 button 生效那条成立，而且只翻一次（没有 label 和 button 双触发）。
- 脏状态：改 User-Agent → 「1 处未保存」，再开一个开关 → 「2 处未保存」；点「放弃更改」三个文本框和开关一起退回，保存条消失；手动把开关点回原值，计数自己归零。
- `beforeunload` 真的拦住了跳转（浏览器弹了"离开站点？"）。
- 420px 窄屏：开关行的文字换行、开关不缩，保存条照样贴底，⌘S 提示按 `sm:` 隐掉。
- 容器放宽后任务表的路径列不再折行；新建任务弹框是 md 档，footer 的「保存」是品牌色。

**没验的**：`lg` 档那几个弹框（strm / 整理页要更多假数据才进得去）、真机上系统开 reduced-motion。

### 一处和方案不一样的地方

方案 2.4 里 `lg` 原本写的是 `sm:max-w-3xl`（768px），实做改成 `sm:max-w-2xl`（672px）—— 七个 `lg` 档里六个本来就是 2xl，按 3xl 会把它们统统撑宽 96px，那是"顺手改设计"，不是归一。

另外确认框（`AlertDialogContent`）默认从 `sm:max-w-lg` 变成了最窄的 `sm:max-w-md`：10 个没写宽度的确认框跟着变窄，而四个显式写了 425 / 460 的本来就在往窄里调，方向一致。

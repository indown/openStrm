# 前端「科技范」视觉提升 —— 方案

> 2026-09-16 起草，基于 v2.7.0（`5a0d6be`）的前端现状。**还没动任何代码。**
> 上一轮 UI 约定见记忆 `ui-review-2026-09-03`，这份是在那套骨架之上加"质感"，不推翻它。

---

## 一、现状诊断

把 `apps/frontend/src` 通读了一遍，问题不是"丑"，是**没有身份**——一眼能认出是 shadcn `new-york` + `neutral` 的出厂样子。具体四条：

| # | 现象 | 位置 |
|---|---|---|
| 1 | 中性色**零彩度**：浅色暗色两套 token 的灰全是 `oklch(x 0 0)`，没有冷暖倾向；品牌青蓝只出现在侧栏选中态、PageHeader 图标、焦点环三处，界面主体完全看不到它 | `app/globals.css:51` / `:100` |
| 2 | **只有一种面板**：`rounded-xl border bg-card` 从骨架屏、空状态、任务卡片、整理表单一路用到日志统计面板，圆角、边框粗细、阴影完全一致，读不出层级 | `loading.tsx` / `empty-state.tsx` / `home/page.tsx:479` / `organize/page.tsx:189` / `log/page.tsx:372` |
| 3 | **字体没有声音**：产品内容主体是路径、cron、文件大小、计数、任务 ID，但等宽字体用的是系统 mono，跟正文几乎一样重一样宽 | `globals.css:57` |
| 4 | **跑起来和停着长得一样**：任务运行时只有 StatusBadge 的脉冲小圆点 + 进度条宽度在变。这个产品最有辨识度的时刻（文件在流、进度在爬）被处理得和静态表格一模一样 | `log/page.tsx` / `offline/page.tsx` |

另外 `app/library/page.tsx` 还停在 2026-09-03 之前：自己写 `<h1>`、自己写"加载中..."、用 `rounded-md` 和裸 `border`，没走 PageHeader / EmptyState / 骨架屏。

**判断：先修 1–3（底子），再把 4 做成全站唯一一个"炫"的地方，比往各个页面撒动效有效得多。**

---

## 二、底子（零新依赖，主要改 `globals.css` 一个文件）

### 2.1 让灰有温度

把中性色全部挪到蓝青侧一点点彩度。幅度要小——这是"钢"和"灰"的区别，不是换主题色。

```
.dark   --background       oklch(0.145 0 0)      →  oklch(0.16  0.012 250)
        --card/--popover   oklch(0.205 0 0)      →  oklch(0.205 0.014 250)
        --muted/--secondary/--accent
                           oklch(0.269 0 0)      →  oklch(0.27  0.014 250)
        --muted-foreground oklch(0.708 0 0)      →  oklch(0.71  0.02  250)
        --sidebar          oklch(0.205 0 0)      →  oklch(0.185 0.014 250)   ← 侧栏比内容区更深，分得开

:root   --muted/--secondary/--accent
                           oklch(0.97 0 0)       →  oklch(0.97  0.005 245)
        --muted-foreground oklch(0.556 0 0)      →  oklch(0.55  0.015 245)
        --border/--input   oklch(0.922 0 0)      →  oklch(0.92  0.006 245)
```

`--card` 浅色下保持纯白不动：画布（`bg-muted/50`）带一点冷、面板纯白，对比出来的层次比现在"白盘子放白桌子"清楚。

### 2.2 面板分层

> **2026-09-16 核对更正**：原稿说"现在全是 `rounded-xl`"是错的。实际半径层级已经对了 —— 面板 50 处 `rounded-xl`(14px)、小元素 63 处 `rounded-md`(8px)，只有 `life/page.tsx:315,566` 和 `library/page.tsx:326` 三处面板漏成了 `rounded-lg`。这项缩成"补 3 处"。

- 暗色下给面板加一条顶边高光 —— 这一条就能让它从"色块"变成"硬件"。**不需要新建 `.panel` 工具类、不用改 48 处调用点**：`bg-card` 在 `components/ui/` 之外的 48 处用法几乎全是面板，直接挂全局规则即可：
  ```css
  @layer components {
    .dark .bg-card { box-shadow: inset 0 1px 0 oklch(1 0 0 / 6%); }
    :root:not(.dark) .bg-card { box-shadow: 0 1px 2px oklch(0 0 0 / 3%); }
  }
  ```
  注意 `bg-card/60`（EmptyState、UnitList:172）生成的是另一个类名，不会被命中，正好——空状态走网格底纹那条路。
- 顶栏改成毛玻璃：`LayoutWrapper.tsx:163` 的 `bg-background` → `bg-background/80 backdrop-blur-md`，`border-b` → `border-b border-border/60`。滚动时内容从底下透出来，是"控制台"最省事的一笔。

### 2.3 自托管一款等宽字体（性价比最高的一项）

`public/fonts/` 放 JetBrains Mono 或 IBM Plex Mono 的 400 / 500 两个字重 woff2（合计 40–60KB），`globals.css` 里 `@font-face` 接到已有的 `--font-geist-mono`，`font-display: swap`。

**必须自托管**：`layout.tsx` 顶部已经写明 `next/font/google` 会在构建期去 Google 拉字体，离线 / 国内网络下 `next build` 直接失败。

接上之后，把路径、cron、文件大小、计数、任务 ID、版本号统一成 `font-mono tabular-nums`。真正的等宽一上，"科技范"就有了一半，而且零运行时成本。

### 2.4 侧栏与空状态

- 选中项加 2px 品牌色左竖条 + 极淡外发光（改 `app-sidebar.tsx:68` 那串 class），比现在纯底色 tint 更像仪表盘。
- `EmptyState` 的虚线框换成淡网格底纹（两条 `linear-gradient`，8px 网格，`opacity` 压到 0.4 以下）。虚线框是所有模板的默认长相，网格是这个产品自己的。

---

## 三、集中发力的一处：让"正在跑"看起来像在跑

只做这一个主题，其它地方保持安静。四个落点：

1. **进度条扫描高光**：一条从左到右循环的亮带，只在 `status === running` 时跑。三处进度条（`log/page.tsx:387`、`offline/page.tsx:666`、`organize/RunView.tsx:368`）先抽成一个 `<ProgressBar tone running>`，顺手消掉重复。
2. **运行中的描边**：运行中的任务行 / 实时日志面板套一圈会动的发光描边（思路见 §4 的 ElectricBorder / BorderGlow）。
3. **数字滚到位而不是跳变**：`log/page.tsx:478` 的 `Stat`（7 个）和历史页汇总。
4. **实时日志列表上下渐隐 + 新行淡入**：`log/page.tsx` 的日志行区域加 `mask-image` 渐隐，新行 120ms 淡入。

**`prefers-reduced-motion: reduce` 下这四样全部静音。** reactbits 的组件基本都不处理这个，自己写就顺手管了。

---

## 四、reactbits.dev 逐个评估

先说结论：reactbits 是**给营销落地页做的**，165 个组件里绝大多数放进这个后台是负分——它们假设深色背景、硬编码颜色、常驻动画、鼠标跟随。能用的就下面这几格，而且多数是**抄思路不抄代码**。

### 值得用

| 落点 | 参考组件 | 依赖 | 怎么用 |
|---|---|---|---|
| 运行中的任务行 / 日志面板描边 | `ElectricBorder`、`BorderGlow`、`StarBorder` | **零依赖**（SVG filter / 纯 CSS） | 抄思路自己写：换成 `--brand` / `--warning` token，加 reduced-motion 兜底。原版写死 `#5227FF` 这类颜色，浅色下直接花 |
| 日志页 7 个统计数字、历史页汇总 | `CountUp`、`Counter` | `motion` | 抄思路：25 行 `requestAnimationFrame` hook 就够，不值得为一个数字滚动引 framer-motion |
| 「运行中」「同步中」文字微光 | `ShinyText` | `motion` | 抄思路：`background-position` 关键帧 10 行纯 CSS（reactbits 早期版本本来就是纯 CSS，后来才改成 motion 的） |
| 实时日志列表 | `AnimatedList` | `motion` | **只取上下渐隐遮罩**，别取逐行入场——日志一秒几十行，逐行动画会糊 |
| 登录页背景（全站唯一的"首屏"） | `Radar`、`Topography`、`FaultyTerminal`（`ogl`，约 15KB gz）/ `LetterGlitch`、`DotField`（**零依赖** canvas 2D） | `ogl` 或零 | 唯一值得**原样引入**的一类（着色器自己写不划算）。只在 `/login` 动态 import，静态导出会切成独立 chunk，不进主包 |

登录页背景选型倾向：**雷达扫描** > 极光 / 等离子 / 光线。理由是 Aurora / Silk / LightRays / Plasma 已经是"AI 生成落地页"的通用长相，而"扫描"正好是这个产品自己的隐喻（网盘监控那页的图标就是 Radar）。零依赖想省事就 `DotField`。

### 可选，优先级低

| 落点 | 参考组件 | 说明 |
|---|---|---|
| 整理页 预览→确认→执行 | `Stepper`（`motion`） | 现在三步靠文案串，做成步骤条会更清楚。但整理页刚评审重构完，别急着动 |
| 影库海报墙 | `ChromaGrid`（`gsap`）、`Masonry`、`TiltedCard`（`motion`） | 影库是隐藏功能（`lib/features.ts`），排最后。真要做，先把这页拉回 2026-09-03 约定 |

### 明确不要

- **导航类**：`Dock`、`GooeyNav`、`PillNav`、`CardNav`、`StaggeredMenu`、`LineSidebar` —— 换掉现在的侧栏等于丢掉折叠态、手机抽屉、键盘可达、tooltip，这些都已经调过一轮了。
- **光标特效**：`SplashCursor`、`BlobCursor`、`TargetCursor`、`ClickSpark`、`Crosshair` —— 一个每天要用的后台不需要鼠标拖尾。
- **滚动叙事**：`ScrollReveal`、`ScrollFloat`、`ScrollVelocity`、`ScrollStack`、`ScrollExpand` —— 表格页不是营销长页，滚一次动一次会晕。
- **`MagicBento`**：`gsap` + 写死暗色 + 自带配色，跟现有 token 体系冲突。
- **`GridScan`**：依赖 `face-api.js` + `three` + `postprocessing`，**而且要开摄像头**。绝对不要。
- **`three` 系**：`Lanyard`、`ModelViewer`、`Ballpit`、`Hyperspeed`、`ShapeBlur` —— 单是 three 就 140KB+ gz，这个 app 是跑在 NAS 上给手机浏览器看的。

### 共同的改造成本（不管抄哪个）

1. 全部硬编码深色：`SpotlightCard` 直接写着 `border-neutral-800 bg-neutral-900`。要接 `--card` / `--border` / `--brand`，否则浅色主题下全废。
2. 全部不管 `prefers-reduced-motion`。
3. 常驻动画在低功耗设备上是持续耗电——主界面里的效果都得能按状态开关（只在 running 时动），不能常亮。

---

## 五、许可证：一个必须先定的问题

reactbits 是 **MIT + Commons Clause**（`LICENSE.md`）：允许作为应用的一部分使用、修改、分发，但**必须保留版权声明**，且不得单独出售 / 再分发组件本身。

OpenStrm 是 MIT 仓库、源码公开。直接复制文件会有两处摩擦：

- 保留版权头 ⇄「代码里不写第三方项目名」的规矩。（那条规矩管的是借鉴来源不写进注释；许可证要求的署名是另一回事，不能省。）
- 仓库整体宣称 MIT，而这些文件带 Commons Clause 限制，Readme / LICENSE 得补一句说明。

**所以建议**：

- 真正想要的效果里，零依赖那几个（发光描边、数字滚动、闪光文字、渐隐列表）**自己写**，每个 20–60 行。抄想法不落地代码，既吃现有 token、支持浅色和 reduced-motion，两个摩擦一起没了。
- 只有登录页的 WebGL 背景值得原样引入。那就单独放 `src/components/vendor/`，保留完整版权头，Readme 致谢里写一句 —— 这是许可证的硬要求，属于「不写第三方名字」那条规矩的例外。

---

## 六、落地顺序（每步之间都能停）

| 阶段 | 内容 | 依赖 | 估时 |
|---|---|---|---|
| 1 | token 加温度、`.panel` 分层、自托管等宽字体、顶栏毛玻璃、侧栏选中竖条、EmptyState 网格 | 无 | 半天 |
| 2 | 抽 `<ProgressBar>` + 扫描高光、`useCountUp`、运行中描边、日志渐隐；全部 reduced-motion 兜底 | 无 | 半天 |
| 3 | 登录页背景（雷达扫描），`/login` 动态 import | `ogl` 或零 | 1–2 小时 |
| 4 | `library/page.tsx` 拉回 2026-09-03 约定 | 无 | 1 小时 |

**验证**：每阶段都要在 3222 的 dev 上看浅色 / 暗色 / 手机窄屏三遍（dev 常驻时**不要**在同目录跑 `next build`，会覆盖 `.next`）；收尾跑 `pnpm --filter @openstrm/frontend typecheck` 和一次干净构建。

---

---

## 七、阶段 1 执行清单（行号 2026-09-16 核对过）

改 5 个文件、新增 3 个文件，**不加任何 npm 依赖，不碰 `components/ui/` 下的 shadcn 原语，不引入 reactbits**。

| # | 做什么 | 文件 | 规模 |
|---|---|---|---|
| 1 | 中性色加温度：暗色 `--background` `0.145 0 0`→`0.16 0.012 250`、`--card`/`--popover` `0.205 0 0`→`0.205 0.014 250`、`--muted`/`--secondary`/`--accent` `0.269 0 0`→`0.27 0.014 250`、`--muted-foreground` `0.708 0 0`→`0.71 0.02 250`、`--sidebar` →`0.185 0.014 250`（比内容区深，把导航轨和画布分开）；浅色 `--muted`/`--secondary`/`--accent`→`0.97 0.005 245`、`--muted-foreground`→`0.55 0.015 245`、`--border`/`--input`→`0.92 0.006 245`。`--card` 浅色保持纯白不动 | `globals.css:51-149` | ~12 行 |
| 2 | 面板顶边高光：`@layer components` 里加 `.dark .bg-card` / `:root:not(.dark) .bg-card` 两条 box-shadow | `globals.css:150` 附近 | +4 行 |
| 3 | 补 3 处漏网的面板圆角 `rounded-lg`→`rounded-xl` | `life/page.tsx:315,566`、`library/page.tsx:326` | 3 行 |
| 4 | 自托管 JetBrains Mono（OFL-1.1）：`public/fonts/` 放 latin 400/500 两个 woff2（各 ~21KB，合计 ~43KB）+ `OFL.txt`；`globals.css` 顶部两条 `@font-face`；`--font-geist-mono` 字体栈首位插 `"JetBrains Mono"`，后面的系统栈原样留作兜底 | `globals.css:57` + 新增 3 个文件 | +12 行 |
| 5 | 顶栏毛玻璃：`bg-background` → `bg-background/80 backdrop-blur-md`，`border-b` → `border-b border-border/60` | `LayoutWrapper.tsx:163` | 1 行 |
| 6 | 侧栏选中态加 2px 品牌色左竖条（`relative` + `before:` 伪元素，折叠成图标时保留） | `app-sidebar.tsx:68` | 1 行 |
| 7 | EmptyState 换网格底纹：`globals.css` 加 `.grid-surface`（两条 `repeating-linear-gradient`，8px 网格，颜色走 `color-mix(in oklch, var(--border) …)`），组件里 `border-dashed` → 实线 + `grid-surface` | `globals.css` + `empty-state.tsx:18` | +8 行 / 1 行 |

### 已知的小副作用（都不算 bug，先说在前面）

- 第 2 条的全局规则会命中 `log/page.tsx:510` 和 `strm/components/ScanDialog.tsx:56` 两个分段控件的选中态 —— 它们本来就带 `shadow-sm`，Tailwind 的工具类优先级更高会盖掉内高光，视觉无变化。
- 同理 `auth-shell.tsx:23`（`shadow-sm`）、`history/page.tsx:192`（`hover:shadow-sm`）、`library/page.tsx:326`（`hover:shadow-md`）这 3 处拿不到内高光。要完全一致就手动调这 3 行，不调也看不出来。
- 等宽字体只换族，不铺开用量。现有 33 处 `font-mono` 立刻受益；路径里的中文仍走系统 CJK 字体回退（今天也是这样，不是新问题）。把更多数字 / 计数改成 mono 放到阶段 2。

### 验证

1. 3222 的 dev 上浅色 / 暗色 / 手机窄屏各走一遍：任务、strm、整理、日志、设置、登录。
2. `pnpm --filter @openstrm/frontend typecheck`。
3. 收尾等 dev 停了再跑一次干净构建（**dev 常驻时不要在同目录 `next build`**，会覆盖 `.next`）。


## 实施记录

### 阶段 1（2026-09-16，worktree `task-ui`，未提交）

七项全部做完，改 6 个文件 + 新增 3 个字体文件，**没加任何 npm 依赖**：

| 项 | 落点 | 与计划的出入 |
|---|---|---|
| 1 中性色加温度 | `globals.css` 浅色暗色两套 token | 计划外多调了浅色的 `--sidebar` / `--sidebar-accent` / `--sidebar-border` —— 只给内容区加温度、侧栏留纯灰的话，对比之下侧栏会显得发黄 |
| 2 面板顶边高光 | `globals.css` `.dark .bg-card` / `:root:not(.dark) .bg-card` | 按计划，48 处调用点一处没改 |
| 3 面板圆角补漏 | `life/page.tsx` ×2、`library/page.tsx` ×1 | 按计划 |
| 4 自托管等宽字体 | `public/fonts/` + `globals.css` 两条 `@font-face` | 按计划。JetBrains Mono latin 400/500，21KB + 22KB + OFL.txt |
| 5 顶栏毛玻璃 | `LayoutWrapper.tsx:163` | 按计划 |
| 6 侧栏选中竖条 | **改到了 `globals.css`**，挂 `[data-sidebar="menu-button"][data-active="true"]::before` | 原计划写在 `app-sidebar.tsx:68` 的 class 串里。挂 data 属性上更短，而且手机抽屉里是同一套按钮，一起生效，所以 `app-sidebar.tsx` 最终一行没改 |
| 7 EmptyState 网格底纹 | `globals.css` `.grid-surface` + `empty-state.tsx:18` | 网格画在伪元素上（遮罩会连子元素一起吃掉）；浏览器里看浅色下太淡，把线色抽成 `--grid-line`，浅色单独用足 `--border` |

顺带改了 `layout.tsx` 的 `themeColor`：暗色从 `#0a0a0a` 跟到新背景 `#090e12`，否则手机状态栏和页面对不上。

**验证**：`typecheck` 通过；`next lint` 无告警；干净 `next build` + 静态导出通过，`out/fonts/` 三个文件都在、导出的 CSS 正确引用；浏览器里浅色 / 暗色各走了登录、任务（空状态）、设置三页，面板内高光、侧栏竖条、毛玻璃、等宽字体都确认生效。JS 首屏包大小没变（没加依赖）。

**留的尾巴**：等宽 500 字重目前没有任何地方用（全站 `font-mono` 都没配 `font-medium`），文件留着等阶段 2 用 —— 它按 `unicode-range` 懒加载，不用就一个字节都不下载；确定不做阶段 2 的话删掉即可。窄屏没在浏览器里验（这台机器 `resize_window` 不生效），但这轮七项都不动布局。

### 阶段 2（2026-09-16，worktree `task-ui`）

主题只有一个：**让「正在跑」看起来像在跑**。四个落点加一条 reduced-motion 兜底，**仍然没加任何 npm 依赖，也没引入 reactbits 的代码**——四个效果都是照着它的思路自己写的（见第四节的理由）。

新增两个共享件：

- `components/progress-bar.tsx` —— 全站统一的进度条。收掉了四处各写一遍的 `h-1.5 overflow-hidden rounded-full bg-muted`（`log` 总进度 + 单文件、`offline`、`organize/RunView`）。颜色走 StatusBadge 的 tone；`running` 时条上一道循环扫过的高光；`indeterminate` 给总量未知的场景。
- `hooks/use-count-up.ts` —— 数字滚到位而不是跳变。目标值中途再变就从当前显示值接着滚，不回跳；reduced-motion 下直接返回目标值。

CSS 都在 `globals.css` 的 `@layer components` 里：`progress-scan`、`progress-drift`、`running-outline`、`tr[data-running]`、`stream-row`、`scroll-fade`；文件末尾一个 `@media (prefers-reduced-motion: reduce)` 把这一组循环动画全部关掉（放在所有 layer 之外，不用 `!important` 就盖得住）。

接线：

| 落点 | 改了什么 |
|---|---|
| 日志页总进度 | 换 `<ProgressBar size="md">`，颜色仍跟状态标签走，跑着时有扫描高光；`progressColor` 那个局部变量连同 `TONE_CLASS` 的 import 一起删了 |
| 日志页统计面板 | 跑着时套 `running-outline`，一圈呼吸的品牌色描边 |
| 日志页 7 个统计数字 | 数字类的走 `CountUpValue`；「用时」「连接」是文字，原样显示 |
| 日志行 | 新行淡入（`stream-row`，只在 running 时加）；单文件进度条换共享组件 |
| 日志列表 | 底部渐隐 |
| 云下载 | 进度条换共享组件，`downloading` 时有扫描高光 |
| 整理 RunView | 进度条换共享组件；识别阶段拿不到总数，走 `indeterminate` 而不是像原来那样假装 30% |
| 任务页 | 正在跑的表格行：行底色带品牌色 + 首格一条呼吸的竖条；手机卡片套 `running-outline` |

**浏览器里改掉的两处**：

1. `indeterminate` 原来单向漂 `-120% → 420%`，两端会滑出轨道外还停顿，看着像断了。改成 `0 → 300%` + `alternate`，在轨道里来回扫。
2. `scroll-fade` 原来上下都渐隐。**上边是错的**：日志是最新的在最上面、滚动条停在顶部，顶部渐隐等于永久压着最新那一行。改成只渐隐底部。

**验证**：`typecheck` + `next lint` + 干净 `next build` / 静态导出全过，首屏 JS 仍是 100 kB 没变；构建产物里确认了 reduced-motion 块（`@media (prefers-reduced-motion:reduce){.progress-drift,.running-outline:after,.stream-row,tr[data-running=true]>td:first-child:before{animation:none}...}`）。没有后端造不出"正在跑"，所以临时开了一个 `app/ui-preview` 页把各状态摆出来，浅色暗色都看过，**已删除**。

**没验到的**：页面级接线（真的有任务在跑时的样子）只过了类型和 diff，没跑真机；`prefers-reduced-motion` 只确认了 CSS 进产物，没在系统里真开过；窄屏同样没验。日志行的新行淡入不会在开页时炸一片——SSE 没有快照回放事件，文件行只从连上之后逐条来。

### 阶段 3（2026-09-16，worktree `task-ui`）

登录页背景：一圈慢慢转的雷达扫描，`components/radar-backdrop.tsx`，接在 `AuthShell` 上（登录页和强制改密码页共用这个壳，两边一起有）。

**和计划不一样的一点**：原计划写的是"引 `ogl` 自己写着色器"。真做的时候发现**不需要 WebGL** —— 雷达是同心圆 + 辐条 + 扫描扇形，纯几何，canvas 2D 就够，而且省一个依赖、颜色能直接读 `--brand` 跟主题走、低端设备上更稳。**最终零依赖**，登录 / 改密码两条路由各 +1 kB，共享首屏包没变。

实现上值得记的几点：

- 圆心放在卡片后面偏上（`height * 0.42`）。卡片是不透明的，正好盖住最密的中心，只留外圈的弧。
- 扫描扇形切成 22 片薄扇叠出渐变，不用 `createConicGradient`（省掉浏览器支持的判断）；总绘制面积就是一个 75° 扇形，不重叠。
- 光点的亮度只由"扫描线转过它多久"算（`exp(-passed / 0.85)`），**不存状态**，所以改窗口大小、切主题都不会闪。
- 主题切换只改 `<html>` 的 class，用 MutationObserver 重新读色；标签页切走 / reduced-motion 都走同一条"画一帧静态的然后停"的分支；dpr 封顶 2。

**浏览器里改掉的两处**：

1. 12 根辐条里正好有一根是水平的，横穿整屏、圆心又被卡片挡着，看着像一条分割线。整组转半格（`(i + 0.5) / SPOKE_COUNT`），不让任何一根落在正轴上。
2. 环和扫描扇的透明度改成按主题分开（浅色 0.15 / 0.3，暗色 0.1 / 0.24）：同一个值在两个主题下轻重差很多。
3. 顺手把 `.auth-backdrop` 的径向渐变加了个中间色标，尾巴拉长一点，和雷达叠起来更顺。

**验证**：typecheck + lint + 干净构建 / 静态导出全过；浅色暗色都看过；控制台无报错。

**一个教训（测试方法本身出的错）**：想用 `document.hidden` 伪造标签页切走来验"停止 / 静止帧"分支，前两次结论都是错的 —— 这个被扩展驱动的标签页真实 `visibilityState` 就是 `hidden`，Chrome 在这种标签页里**根本不跑 rAF**（自插的计数 rAF 在 500ms 里跑了 0 次），所以"前后两帧相同"根本不能证明什么。正确的验法是反过来：把伪造删掉、让 `document.hidden` 回到真实的 `true`，静止分支会**同步**画一帧 —— 采样到 9109 个像素被画到，700ms 后仍是同一帧。以后在这个环境里验 canvas 动画，别拿"帧有没有变"当判据。

### 阶段 4（2026-09-16，worktree `task-ui`）

`app/library/page.tsx` 拉回 [[ui-review-2026-09-03]] 的约定 —— 这页之前还停在重做之前：自己写 `<h1>`、自己写"加载中..."、空状态是个裸边框、外层 `space-y-4`。

- 页头换 `PageHeader`（图标用侧栏同一个 `Library`），搜索框收进 `actions`，图标改成绝对定位压在输入框里，和顶栏的分享链接框一个写法
- 首屏骨架：`components/loading.tsx` 新增 `PosterGridSkeleton`（竖版海报 + 两行字），骨架归在 loading.tsx 是既有约定
- 两个空状态都换 `EmptyState`：影库为空 / 搜索没有匹配（后者带「清空搜索」按钮，文案里带上搜的词）
- 卡片 hover 从 `hover:shadow-md` 改成 `hover:border-brand/40` —— 顺手了结阶段 1 留下的尾巴：`shadow-*` 工具类优先级更高，会盖掉面板的顶边高光
- 文件数角标补 `tabular-nums`

**验证**：typecheck + lint + 干净构建 / 静态导出全过。浏览器里三个状态都看了（海报墙明暗两套、搜索无匹配、影库为空）。没有后端时用了个假后端：scratchpad 里一个 40 行的 node http 服务监听 4000 返回假的 `/api/library` 和 `/api/follow`，dev 的 rewrites 会把 `/api/*` 转过去 —— 比在页面里 mock XHR 干净得多，**这个办法以后看任何需要数据的页面都能用**。用完已删。

**发现但没动的**：影库加载**失败**时，页面也显示"影库是空的"（只多一个 toast）。这是这页原来就有的行为，不是这次改出来的；要区分"空"和"没加载上"得加一个错误态，超出这一阶段的范围，先记在这里。

### 收尾：第三方字体的许可声明（2026-09-16）

这轮唯一引入的第三方资产就是那两个字体文件。OFL-1.1 要求的"许可证随字体一起分发"本来就满足了（`OFL.txt` 和 woff2 放在一起，构建产物 `out/fonts/` 里三个都在），缺的是仓库层面的说明 —— 仓库 LICENSE 是 MIT，对外等于说里面的东西随便拿，而这两个文件不归 MIT 管。

在 `LICENSE` 的 MIT 正文后追加了一段 Third-party licenses，`Readme.md` 的「许可证」一节也补了一句。**这是「代码里不写第三方项目名」那条规矩的例外** —— 许可证要求的署名必须指名道姓，和「借鉴来源不写进注释」是两回事。

### 合并（2026-09-16）

五个提交 rebase 到了 v2 的 `d463fd9` 之上（仓库历史是纯线性的，近 60 个提交 0 个合并提交，所以不用合并提交）。两边都改过的 `organize/components/RunView.tsx` 没冲突。rebase 后重跑 typecheck + lint + 干净构建全过，v2 可以直接快进。


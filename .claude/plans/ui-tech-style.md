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

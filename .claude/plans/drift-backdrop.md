# 海报背景（strm 管理 / 整理页）—— 方案与实施记录

一面 3D 倾斜的海报墙，压暗压糊铺在内容后面。灵感来自 reactbits 的 DriftWall，但只借机制，
代码是自己写的（reactbits 是 MIT + Commons Clause，抄源码进仓库要保留版权头，和「代码里不写第三方项目名」冲突）。

参照物不是落地页，是 **Emby / Jellyfin / Plex 的详情页背景**：一张作品图放大、模糊、压暗铺满。
对一个 strm 工具来说这是本行的语言，不是从营销页搬来的装饰。

## 一、定下来的形态

用户在「内容带 / 页头背景 / 整页背景」三个方案里选了**整页背景**，并要求做 3D（不是分层假纵深）。

两个状态，判定只有一条规则：

| 状态 | 判定 | 表现 |
|---|---|---|
| `stream` | 当前路径的祖先里**没有**带 id 标签的段 | 若干列海报缓慢上下漂移，列在 Z 轴上深浅不一 |
| `single` | 祖先里**有** `[tmdbid=…]` | 就这一张，倾斜、放大、糊掉，**完全静止** |

剧集和电影一视同仁，也不分层：`剧名 (2024) [tmdbid=1]`、它的 `Season 01`、`Season 01/extras`
进哪一层都是同一张。命名里不写 id 标签的库退一步：拿当前目录和它的父目录去碰运气。

## 二、海报从哪来：四级回退（`services/strm/poster.ts`）

| 级 | 来源 | 靠什么 | 要不要外网 |
|---|---|---|---|
| ① `local` | 目录里的 `poster/folder/cover/default.{jpg,jpeg,png,webp}` | 默认 `downloadExtensions` 就带 `.jpg/.png`，图片随片下载到本地了 | **不要** |
| ② `tmdb` | 目录名里的 id 标签 → TMDB 详情缓存 | `organize/identify.ts` 的 `idTagFromName()`，三种风格通吃 | 缓存命中就不要 |
| ③ `tmdb` | `tvshow.nfo` / `movie.nfo` 里的 tmdbid | `organize/nfo.ts` 的 `readNfoFacts()` | 同上 |
| ④ `run` | 这个任务最近 10 次整理记录里的 `organize_units.match`（自带 `posterUrl`） | `dstRoot` 和本地相对路径是同一串 | **不要** |

①③④ 全部离线可用——这个产品跑在 NAS 上，不少人没填 TMDB key，也有人不想让 NAS 连外网，
所以**海报能力不建立在「必须有 key」上**。②③ 缓存没命中且没 key 就静默跳过，不报错、不留空框。

TMDB 详情缓存和 `organize/identify.ts` 的 `TmdbClient` **共用一份**（键都是 `details:<kind>:<id>:<lang>`）。

### 接口

```
POST /api/strm/posters  { taskId, paths: string[] }   # 一次最多 48 个目录
  → { posters: { [path]: { source, url, title?, year?, tmdbId? } } }   # 拿不到的不出现

GET  /api/strm/image?taskId=&path=                    # 本地图片，只放行图片扩展名
```

两个都复用 `manage.ts` 的 `resolveManagedPath()`（越界 + 符号链接检查现成的）。
`/image` 带 `Content-Type`、`ETag`（size+mtime）、`Cache-Control: private, max-age=86400`，
超过 16MB 不给。

**`<img>` 带不了 Authorization 头**，所以本地图片是前端 `fetch` 成 blob 再 `createObjectURL`
（`hooks/use-dir-posters.ts`，最多缓存 60 个，先进先出释放）。没有把 token 放进 URL——会落到日志和 referrer 里。

## 三、3D 几何（`components/poster-backdrop.tsx` + `globals.css` 的 `.poster-backdrop`）

```
perspective: 1200px（和参考实现同一档）   perspective-origin: 60% 42%
列的 translateZ: -300 ~ +40
平面: rotateX(16°) rotateY(-14°) translateZ(-120px)  ← 先转再沿自己的法线往后推
      尺寸按视口算（X 1.7 倍、Y 1.5 倍），封顶 3600×1800
瓦片: 190×285（2:3），间距 20，速度 12px/s 基准，列间黄金分割伪随机、方向交替
空气透视: 越远 → 越糊（blur 1.5~6px）、越淡（opacity .5~1）、越小（透视自带）
遮罩: radial-gradient(ellipse 105% 105% at 60% 8%)，铺满大半屏、四周渐隐，热点偏右上让开标题
不透明度: 暗色 .22 / 浅色 .14；单作品态 .38 / .16
```

**倾角 / 墙的尺寸（OVERSCAN·MAX）/ `PLANE_Z` 的后推 / 瓦片大小是一组，动一个就要重算其余三个。**
试过 -22°：只抬倾角的话，① 远端收缩过头，屏幕左上角露出墙外的底色；② 近端放大到 2.58×，
瓦片大得不像墙。把 OVERSCAN 加到 2.1 / 2、后推到 -280、瓦片缩到 150×225 能补回覆盖，
但一屏就变成一百来块——**太密，反而不好看**。最后定在 -14°：一屏三四十块、块够大看得出是海报，
四角也都盖住（六个探测点实测全覆盖）。视点从 50% 50% 挪到 60% 42% 是这一版唯一保留下来的补丁，
它把远端在屏幕上摊得更开，不增加列数就能盖住左上角那个最远的角。

**列是 `overflow: hidden` 的，于是 `transform-style` 被强制 flat**：每一列先拍平成一个 2D 面，
再整体摆进 3D。这是好事——单块瓦片不可能自己冲到相机跟前炸开，风险只剩"整列"这一个粒度，
而列的 Z 是我自己给的、有界的。（注意：这也意味着用 `getBoundingClientRect()` 量被裁掉的瓦片
会读到几十万像素的假值，别拿它当炸开的证据，要量就只量视口内的。）

**超宽屏靠 `PLANE_MAX_W` 封顶**：不封的话 4K 屏上斜着的墙左端会自己伸到相机跟前。

**踩过的坑（改几何前必看）**：透视里元素的 Z 一旦逼近相机距离（`perspective` 值），投影会炸开——
第一版用了 `scale(1.7)` 放大平面 + `perspective: 1400px` + 16°/18° 倾角，
实测有列被放大到 **49000px 宽**，整面墙只剩一张糊成星云的图。四条规矩：

1. **不要用 `scale()` 放大平面**（scale 连 Z 一起放大），尺寸按视口直接算；
2. 倾角和后推一起算账（现在 16° / 14° + `translateZ(-120)`），最坏情况 Z 位移要留出 perspective 的一半余量；
3. `copies` 要按「一列里有几张海报」算，不能只按视口高度除——前者算错会多铺好几倍的 DOM；
4. 墙的尺寸要封顶，不能只按视口比例算——超宽屏上斜墙的两端会自己伸到相机跟前。

**另一个坑**：`loading="lazy"` 在 3D 变换里浏览器判不准可见性，会一张都不加载。别加。

### 层级

页面根节点 `relative z-0`（不是 z-10），背景层 `fixed -z-10` 挂在它里面：

- 在内容列的 `bg-muted/50` 之上（负层直接挂在外面会被那层底色盖掉）；
- 在面板和文字之下；
- 顶栏是 `sticky z-20`，照常盖在上面（它本来就是毛玻璃，透出来正好）；
- **左右两边按 `[data-slot="sidebar-inset"]` 的实测位置收住**（`ResizeObserver` 跟着侧栏展开 / 收起变）。
  侧栏是 `fixed z-10`，但实测这层 fixed 背景还是会糊到导航上去，按几何收住最稳。

strm 页的表格面板改成 `bg-card/60 + backdrop-blur-sm`，墙才透得出来。

## 四、什么时候不出现

| 条件 | 行为 | 为什么 |
|---|---|---|
| 有任务在跑 / 整理在执行 | 700ms 淡出到 0，停 rAF | 这个后台里「动」= 有任务在跑，不能被背景稀释 |
| 搜索模式 | 淡出 | 搜索结果和当前目录不是一回事 |
| 当前目录 > 300 条 | 不渲染 | 长表格滚动时不值得再叠一层合成 |
| 窄屏 < 640px | 不渲染 | 手机上这两页是卡片列表 |
| 页面切到后台 | 停 rAF | 别烧电 |
| `prefers-reduced-motion` | 显示但不动 | |

## 五、信息搬到哪了

背景不承载信息，所以统计进了 `PageHeader` 那一行：

```
本地目录 /media/strm   14 个目录 · 12 已识别   [2 个没认出来]
                                               ↑ 可点，跳 /organize?task=&path= 预填范围
```

进到作品里换成 `12 个 strm · 2 个其它`。「缺口即待办」这个价值没丢，只是从瓦片变成了徽章。

## 六、实施记录（2026-09-16，worktree `task-ui`）

改动：

- `packages/shared/src/types/strm.ts`：`StrmPoster` / `StrmPosterSource` / `StrmPosterResult`
- `apps/backend/src/services/strm/poster.ts`（新）：四级回退 + `statImage()`
- `apps/backend/src/routes/strm/index.ts`：两个新路由
- `apps/backend/src/routes/strm/strm.itest.ts`：三个用例（三级来源各一、入参与越界、图片的 Content-Type / ETag / 304 / 非图片 400）
  —— 样本目录挂在**自己的任务** `r-poster` 下，混进 `r-main` 会改变前面那些用例的条目数
- `apps/frontend/src/components/poster-backdrop.tsx`（新）、`hooks/use-dir-posters.ts`（新）
- `apps/frontend/src/app/globals.css`：`.poster-backdrop` 的透视、遮罩、浅色 / 暗色两套数值
- `apps/frontend/src/app/strm/page.tsx`、`app/organize/page.tsx`、`organize/components/RunView.tsx`：接上

零新依赖。共享首屏 JS 仍是 100 kB；`/strm` 18.2 kB、`/organize` 24.9 kB。

验证：`pnpm -r typecheck`、`pnpm -r lint`、后端 769 个测试全过、一次干净 `pnpm build`。

浏览器上验过（假后端 + picsum 占位图，dev 3223）：暗色 / 浅色、流态 / 单作品态、
进到 `Season 01` 仍是同一张、搜索时淡出、侧栏和顶栏不被糊到。

**没验过的**：真有任务在跑时的淡出、窄屏、系统里真开 reduced-motion、
四级回退在真机上的命中率（本地 `poster.jpg` 那一级尤其要看 115 真机）、长目录滚动的帧率。

## 七、还可以做的

- `fanart.jpg` / TMDB backdrop 做横版背景：单作品态铺满比竖版海报更合适（现在复用竖版）
- TMDB 的图可以把 URL 里的 `w500` 换成 `w185`，反正要糊，省带宽也省合成
- 分类目录（`电影/`、`电视剧/`）现在没有海报，可以借它下一层第一张 + 角标计数

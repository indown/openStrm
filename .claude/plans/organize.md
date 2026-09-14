# 整理与规范化命名（organize）—— 设计

> 状态：**已实施（后端 + 前端），待真机验证**。最后更新：2026-09-11

## 要解决的事

网盘里的目录和文件名是资源站 / 字幕组 / PT 的原始命名，strm 库照抄过来，Emby 只能靠猜：

```
tv/怒呛人生/BEEF.S01.1080p.NF.WEB-DL.DDP5.1.H.264-XXX/BEEF.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-XXX.mkv
tv/[Nekomoe kissaten][Sousou no Frieren][01][1080p][JPSC].mp4
movie/Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX/Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv
```

典型后果：剧名带一串技术词识别错片、年份缺失匹配到重名作品、字幕组的 `[01]` 认不出季集、同一部剧散在三个目录、电影目录里塞着 sample 和花絮。
需要两件事：**规范化命名**（原地改成媒体服务器认得的名字）和**整理**（挪进 `作品 (年份)/Season 01/` 这样的标准结构）。两者是同一条流水线的两种输出。

## 业界怎么做

### 目标：媒体服务器的命名规范

三家官方文档给的规范高度一致，差别只在 id 标签的写法：

| | 电影 | 剧集 | id 标签 | 多版本 / 多段 |
|---|---|---|---|---|
| Emby | `Avatar (2009)/Avatar (2009).mkv` | `Glee (2009)/Season 01/Glee S01E01.mp4`，特别篇 `Season 00` 或 `Specials` | `[tmdbid=36557]`、`[tmdb-36557]`、`{tmdbid=36557}`（tmdb / imdb / tvdb 都认） | `300 (2006) - 1080p.mkv`、`300 (2006) - 4K.mkv`；`-cd1`、`-part1`、`-disc1` |
| Jellyfin | `Movie (2019) [tmdbid-xxx]/Movie (2019) [tmdbid-xxx].mp4` | 季目录必须是 `Season 01`（明确说别写 `S01`） | `[tmdbid-xxx]`、`[imdbid-tt…]` | `Movie (2021) - 2160p.mp4`；字幕 `Film.en.forced.srt` |
| Plex | `Batman Begins (2005) {tmdb-272}/Batman Begins (2005) {tmdb-272}.mp4` | `Show (2010) {tvdb-…}/Season 01/Show - s01e01.mkv` | `{tmdb-272}`、`{edition-Director's Cut}` | 同上 |

共同点：**目录名 = 标题 + (年份) + id 标签**，剧集下一层固定 `Season NN`，文件名重复目录名再接 `S01E01` / 版本标签；花絮进 `extras` / `trailers` 这类固定子目录；多集 `S01E01-E02`；日播 `2020-01-31`。目录名里带 TMDB id 是让刮削百分百命中的最有效办法，三家都认。

### 过程：整理工具怎么做

| 工具 | 识别 | 命名 | 预览 | 撤销 | 分类 | 网盘 |
|---|---|---|---|---|---|---|
| Sonarr / Radarr | 解析文件名 + TVDB/TMDB，导入时人工可改匹配 | token 模板：`{Series TitleYear}/Season {season:00}/{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}`；多集样式六选一；非法字符替换、冒号五种策略（默认 Smart：`: ` → ` - `） | 「Rename」先列出 旧路径 → 新路径，逐条勾选再执行 | 无 | 根目录级 | 无 |
| FileBot | 解析 + 多库匹配，左原名右新名对照 | Groovy 表达式 `{n} - {s00e00} - {t}`，自带 `{plex}` `{emby}` `{jellyfin}` `{kodi}` 预设 | 有 | `history.xml` 记录每次改名，`Revert` 一键回退 | 无 | 无 |
| 国内主流的网盘整理工具 | 正则 + **自定义识别词**（屏蔽词 / `A => B` 替换 / `前 <> 后 >> EP+1` 集数偏移 / 直指 `{[tmdbid=xxx;type=tv;s=1]}`）+ TMDB | Jinja2 模板，默认电影 `{{title}} ({{year}})/{{title}} ({{year}}){% if part %}-{{part}}{% endif %}{% if videoFormat %} - {{videoFormat}}{% endif %}{{fileExt}}`，剧集 `{{title}} ({{year}})/Season {{season}}/{{title}} - {{season_episode}} - 第 {{episode}} 集{{fileExt}}` | 手动整理：选目录 → 识别 → 可改类型 / TMDBID / 季 / 集偏移 → 执行 | 整理历史可重做（`/redo`）、可连文件一起删 | `category.yaml` 二级分类：按 `genre_ids` / `origin_country` / `original_language` 分到 动画电影 / 华语电影 / 国漫 / 日番… | 支持 115 等网盘内移动改名，再生成 strm |
| tinyMediaManager | 先刮削后改名 | `${title} (${year})` 模板 | 预览后执行 | 无 | 无 | 无 |

### 提炼出的原则

1. **识别和命名分开**：先把文件变成结构化事实（类型、TMDB id、季、集、版本标签），再由模板产出名字。识别结果可被人改、改过的要记住。
2. **命名以媒体服务器的规范为准**，把 provider id 写进目录名；模板只提供有限变量和可选段，不做图灵完备（Jinja2 那种全功能模板是维护负担，Sonarr 的 token 更稳）。
3. **一律预览 → 人工确认 → 执行**，逐条可勾选、可改匹配；认不出的默认跳过，绝不瞎猜。
4. **幂等 + 可撤销**：每一步记 from → to；已经规范的文件再跑一次是零变更；出了错能按记录退回去。
5. **限流分批**：网盘接口有风控，能批量的接口用批量，不能的逐条限速。
6. **完成后联动**：strm 跟着走、通知媒体服务器刷新、通知人。
7. **增量自动化**：新入库的内容（转存、追更、云下载、监控新增）走同一条流水线，规则配一次。

## 方案

### 定位：整理作用在网盘上，本地 strm 跟随

本项目所有链路——全量同步（`planSync` 按相对路径对照）、网盘监控（事件路径 → 本地路径）、追更（`subPath`）、strm 校验 / 重写（`inspectStrm` 从本地文件名推算网盘路径）、302（strm 内容 = 前缀 + 网盘路径）——都建立在一个不变量上：**本地目录树是网盘目录树的镜像**。

只改本地 strm 名而不动网盘（「虚拟整理」）就得在每条链路里维护一张网盘路径 ↔ 本地路径的映射表：`removeExtraFiles` 会把改过名的 strm 当多余删掉再按原名生成；校验会把每个文件报成 `name-mismatch`；监控搬家算不出本地位置；OpenList 和其它工具看到的仍然是乱的。代价远大于给 Provider 加三个写操作。国内主流的网盘整理工具也是直接在网盘内移动改名。

所以：**在网盘上改名 / 移动，本地 strm 由整理器自己同步镜像**（不等监控），监控随后收到的自有事件识别为已处理。作用范围以同步任务为单位，任务的 `originPath` 就是媒体库根；一个任务一种库（电影 / 剧集 / 混合，混合按识别结果分流）。

### 流水线

```
范围（任务 + 子目录；或转存 / 追更 / 云下载 / 监控给的新增路径）
→ 扫描   provider.walkSubtree 拿整棵子树，按「作品单元」分组
→ 识别   recognize：识别词预处理 → 解析文件名 / 目录名 → 单元级综合    （纯函数，样本表驱动测试）
→ 匹配   identify：nfo / 影库条目 / 记忆 里的 tmdbId 直接用；否则 TMDB 搜索打分，给置信度
→ 规划   plan：模板 + 分类 → 目标路径；冲突检测；源 == 目标 的标 keep       （纯函数）
→ 预览   按单元折叠的 from → to 列表；换匹配 / 改季 / 集偏移 / 勾选
→ 执行   apply：mkdir → 批量改名 / 移动 → 本地镜像 → 逐条记账 → 清理空目录
→ 收尾   scheduleEmbyRefresh、改写受影响的追更 / 云下载 subPath、Telegram
→ 撤销   revert：按记录逆序退回，逐条校验节点仍在目标位置
```

预览是后台作业（1000 个单元要几百次 TMDB 请求，现有 scrape-worker 是 4 req/s），`organize_runs` 记状态，页面轮询；可取消。

### 识别（recognize）

把 `services/media-title.ts` 的 cutoff 解析扩成完整的 `parseMediaName()`（保留现有 `normalizeTitle` 供影库刮削用，或让它改调新函数）：

```ts
interface ParsedName {
  title: string; year?: string;
  season?: number; episode?: number; episodeEnd?: number;   // S01E01-E02
  absolute?: number;                                         // 字幕组的 [13]、- 13
  isSpecial?: boolean; date?: string;                        // SP / OVA / 日播 2020-01-31
  part?: string; edition?: string;                           // part1 / cd1；导剪版 / 加长版
  tags: { resolution?; source?; videoCodec?; audio?; hdr?; group? };
  subtitleLang?: string; forced?: boolean;                   // 字幕文件才有
}
```

规则来源：guessit / anitomy 的思路 + 现有 `QUALITY_TOKENS`。中文特化：`第一季` / `第01集` / `E01` / `[01]` / ` - 01`；字幕组前缀 `[Sub][Title][01][1080p]`（方括号段序）；`国语 / 粤语 / 中字 / 简繁` 归入标签；`SP / OVA / OAD / 特别篇` 归特别篇；`1080p` 和 `13` 同时出现时集数取靠前的两位数。

**作品单元**：直接含视频文件的目录是候选；目录名是 `Season 1` / `S01` / `第一季` / `Specials` 时单元是上一级；扁平目录里解析出多个标题就按标题 + 年份拆成多个单元（电影堆、散集堆）。单元级综合时目录名优先于文件名（目录名通常是干净的「剧名 + 年份」），季从季目录 / 文件名推，集只看文件名。

**识别词**（沿用国内用户熟悉的那套语法）：

```
屏蔽词
被替换词 => 替换词
前定位词 <> 后定位词 >> EP+12          集数偏移，支持 EP+1 / 2*EP-1
被替换词 => 替换词 && 前 <> 后 >> EP-1
被替换词 => {[tmdbid=95396;type=tv;s=2]}   直接指定
```

全局一份，任务可以再加自己的；存 `app.organize.rules`。

**证据优先级**：同目录 `tvshow.nfo` / `<video>.nfo` 里的 `<tmdbid>` 或 `<uniqueid type="tmdb">` → 影库条目的 `tmdbId`（从影库转存的路径） → `organize_matches` 里用户确认过的 → 识别词直指 → 目录名解析 → 文件名解析。

### 匹配（identify）

TMDB：已有 `services/tmdb.ts` 的 search，补 `tv/{id}`（季数、每季集数、集标题，可选）和 `movie/{id}`，加 `tmdb_cache` 表（key `type:id:lang`）。

打分：标题（归一化后，对照 `title` / `original_title` / `alternative_titles`）完全相等 +3，年份相等 +2、差 1 年 +1，类型与解析一致 +1，`popularity` 只做同分排序。置信度：

- **high**：tmdbId 来自 nfo / 影库 / 记忆 / 识别词；或标题相等且年份相等。
- **medium**：标题相等但无年份可比 / 差一年；或首选领先第二名 ≥ 3 分。
- **low**：其余有结果的。
- **none**：无结果——预览里单列「待处理」，可搜索或手填 tmdbId。

剧集拉到季集清单后做两件事：解析出的集数超过该季集数 → 试按绝对集数折算（前几季集数累加），标 medium 并在预览里说明；`第二季` 目录里文件只有 `[13]` 这种，同理。

### 命名（naming）

模板用 token，Sonarr / Radarr 风格；`[ … ]` 是可选段，段内变量都为空整段丢弃；路径段整体为空则去掉这一层（分类关掉时 `{category}/` 自然消失）。

```
{category} {title} {originalTitle} {enTitle} {year} {tmdbId} {imdbId} {idTag}
{season} {season00} {episode} {episode00} {episodeRange} {absolute} {episodeTitle}
{part} {edition} {resolution} {source} {videoCodec} {audio} {hdr} {group} {ext}
```

`{title}` 跟设置里的 `tmdb.language`（默认 zh-CN）；`{idTag}` 按设置风格生成：`[tmdbid=693134]`（Emby，默认）/ `[tmdbid-693134]`（Jellyfin）/ `{tmdb-693134}`（Plex）/ 不写。

默认模板：

```
电影  {category}/{title} ({year}) {idTag}/{title} ({year})[ - {edition}][ - {resolution}].{ext}
剧集  {category}/{title} ({year}) {idTag}/Season {season00}/{title} - S{season00}E{episode00}[ - {episodeTitle}].{ext}
```

产出：

```
电影/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv
电影/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.zh-CN.srt
剧集/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv
剧集/葬送的芙莉莲 (2023) [tmdbid=209867]/Season 01/葬送的芙莉莲 - S01E01.mkv
剧集/葬送的芙莉莲 (2023) [tmdbid=209867]/Season 00/葬送的芙莉莲 - S00E01.mkv
```

规则细节：

- 多集 `S01E01-E02`（Sonarr 的 Prefixed Range，Emby / Jellyfin 都认）；特别篇 `Season 00`；多段保留 `-part1`；多版本靠 `[ - {resolution}]`，同一单元两个文件产出同名 → 冲突。
- 字幕跟着同名视频走：`{视频主名}.{lang}[.forced].{ext}`，语言归一 `chs / sc / 简体 → zh-CN`，`cht / tc / 繁体 → zh-TW`，`eng → en`，认不出就不写语言段。`poster.jpg` / `fanart.jpg` / `tvshow.nfo` 随单元目录移动、名字不动；`<video>.nfo` 跟视频改名。
- 非法字符 `: \ / > < ? * | "` 替换（115 目录名明确不允许 `" < >`）；冒号默认 Smart（`: ` → ` - `，其余 → `-`），可选删除 / 短横；全角标点保留；首尾空格和点去掉；单段 ≤ 200 字节，超长截标题不截 `S01E01`。
- `sample`、`-trailer`、`Featurettes` 这类：sample 跳过，花絮按 Emby 规范挪进单元下的 `extras/`（默认关，开了才动）。
- 二级分类（默认关）：JSON 版的 category.yaml，`{ name, genreIds?, originCountry?, originalLanguage? }` 顺序匹配、全部条件同时满足才命中、都不中用最后一条兜底；预置一份「动画电影 / 华语电影 / 外语电影；国产剧 / 日番 / 欧美剧 / 纪录片」。

### 规划与冲突（plan）

每个单元产出 items：`{ srcPath, nodeId, dstPath, kind: video|subtitle|nfo|image|dir|other, action }`。

- `keep`：源 == 目标，灰显不计数——已整理的库再跑是零变更。
- `rename`：同一父目录只改名；`move`：跨目录（可能同时改名）。
- `mkdir`：目标目录不存在（同一部剧再来一季时目录已存在 → 复用，这是增量的常态）。
- `conflict`：目标已存在且不是同一节点；两个源映射到同一目标；目标目录是另一个任务的 `originPath`。冲突项默认不勾，给出原因。
- `skip`：未匹配单元里的文件、`other` 类文件、sample。
- `rmdir`：执行后变空的源目录（可关）。

保护：不动任务根目录本身；不删除任何文件；目标必须仍在本任务 `originPath` 下；一次 run 上限 20000 个文件，超了让用户缩小范围。

### 执行、镜像与撤销（apply / mirror / revert）

按单元顺序执行，每条 op 一行记账：

1. `mkdir` 目标目录链（115 `files/add`，夸克 `/file`），拿到 id 再往里挪——115 `files/move` 对不存在的 pid 也会成功、产生悬空节点，所以永远用刚建 / 刚解析到的 id。
2. 先原地改名再移动：115 `files/batch_rename`（一次 ≤ 100 个 `files_new_name[fid]`）、`files/move`（一次 ≤ 100 个 fid，接口注明不要并发，串行）；夸克 `/file/rename`、`/file/move`（`action_type: 1, filelist, to_pdir_fid`，回 task_id 且未完成就复用 `quarkWaitTask`）；OpenList `/api/fs/rename` `/api/fs/move` `/api/fs/mkdir`。全部走 `scheduleForAccount` 的账号级限流。
3. **本地镜像**：每条 op 成功后立刻按 `services/life/handlers.ts` 的 `relocate` 逻辑挪本地文件并重写 strm 内容（把它抽成可复用的 `mirrorRelocate({ oldPath, newPath, isDir, nodeId })`）。不等监控：监控可能没开，夸克快照最短 5 分钟。115 同时更新 `path_cache`（`rememberListing` / 直接 upsert），后续生活事件才能解析出正确的旧路径。
4. 记账：item `status = done`，附 `finishedAt`；失败的记 error 继续下一条，风控（`classifyError === "blocked"`）整轮暂停，run 可续跑（`pending` 的从头再来，`done` 的跳过）。
5. 收尾：清理空目录（只删本次腾空的）、`scheduleEmbyRefresh()`、改写 subPath（见下）、Telegram `organize-done`。

**监控自有事件**：执行完之后监控会收到我们自己产生的 rename / move 事件。处理前先查 `organize_items`：同 nodeId、同新路径、24 小时内 done → 记 skipped「整理已处理」。没查到也无害：`relocate` 发现本地 from 不存在会退化成 handleCreate，重写同样内容（目录会重新 listDir 一遍，只是费接口）。

**撤销**：只允许对最近一次 `done` 的 run 做；按 done 的 item 逆序：校验节点当前路径 == `dstPath`（115 按 path_cache / resolvePath 对 id，夸克 resolvePath），对不上就跳过并列出；`move` / `rename` 反向执行，`mkdir` 的目录变空了就删（只删空目录，需要 `rmdirIfEmpty`），本地同样镜像回去；run 标 `reverted`。

### 自动整理（增量）

任务级设置 `organize.mode`：`off`（默认）/ `review`（只生成待确认的 run 并通知「N 项待确认」）/ `auto`（high 置信度且无冲突的单元直接执行，其余留待确认）。

触发点都已有明确的「新增路径」：`saveSelectionToTask` 完成（转存）、追更 tick 转存成功、云下载回执生成 strm 后、监控 `create` 目录事件。影库转存自带 `tmdbId / mediaType / year`，直接当 high 匹配，免识别。

**路径回写**：追更订阅 `share_follows.sub_path` 和云下载回执 `offline.followups[].subPath` 指向任务下的相对目录，被整理挪走后它们会报「目标目录不存在」。run 收尾时把 `task_id` 相同、`sub_path` 等于或以被移动目录旧相对路径开头的记录改成新路径（同一事务）；预览里提示「此目录被 N 条追更订阅引用，执行后自动改写」。

### 数据模型

```
organize_runs      id, task_id, scope_path, mode(manual|auto), status(planning|ready|applying|done|failed|cancelled|reverted),
                   stats(json: units/items/done/failed/skipped/conflicts), error, created_at, started_at, finished_at
organize_items     id, run_id, unit_key, kind, action, src_path, node_id, dst_path, match(json), confidence, selected,
                   status(pending|done|failed|reverted), error, finished_at        ← 既是计划也是撤销用的流水账
organize_matches   account_name, src_path, media_type, tmdb_id, season, episode_offset, title, year, updated_at
                   ← 用户在预览里改过并勾了「记住」的识别结果，下次同目录直接用
tmdb_cache         key, value(json), fetched_at
settings           app.organize = { templates, idTag, colon, categories, rules, cleanupEmptyDirs, extras, auto }
TaskDefinition    += organize?: { mode?: "off"|"review"|"auto"; libraryType?: "movie"|"tv"|"mixed" }
```

时间戳统一秒（`unixepoch`）；id 一律字符串。

### 接口

```
POST /api/organize/runs                     { taskId, subPath?, paths?: string[] }   建 run 并后台识别 + 规划 → { id }
GET  /api/organize/runs?taskId=&page=       run 列表（不带 items）
GET  /api/organize/runs/:id                 run + 按单元分组的 items（分页）
PUT  /api/organize/runs/:id/units/:key      { match?: { mediaType, tmdbId, season?, episodeOffset? }, selected?, remember? }  改匹配后重新规划该单元
PUT  /api/organize/runs/:id/items           { ids, selected }
POST /api/organize/runs/:id/apply           执行（异步）；进度 GET /api/organize/runs/:id/log（SSE，沿用任务日志流的做法）
POST /api/organize/runs/:id/cancel
POST /api/organize/runs/:id/revert
POST /api/organize/preview-name             { template, sample }   设置页实时试算
GET  /api/tmdb/tv/:id                        季集清单（带缓存）；搜索复用 POST /api/library/tmdb/search
```

错误壳照 `{ message, ...extra }`，上游失败 `upstreamError`，输入 `parse(schema, body)`。

### 前端

- 新页 `/organize`「整理」（侧栏放在 strm 管理之后）：选任务 + 目录（复用 `DirectoryTreeDialog` 的远程目录树）→ 「预览」→ 单元列表：海报缩略、标题 (年)、类型、TMDB 链接、置信度 `StatusBadge`（high 成功色 / medium 警告 / low 危险 / none 中性）、文件数，单元操作「换匹配」（TMDB 搜索弹框，复用影库那套）「季 / 集偏移」「跳过」「记住」；展开看 from → to，差异段高亮；底部粘性栏「执行 N 条」；执行中进度条 + 日志；完成摘要 + 「撤销」。「历史」tab 列 runs。手机上单元是卡片。
- 设置页「整理」区块：电影 / 剧集模板（输入时下方实时显示样例）、id 标签风格、冒号策略、集标题开关、二级分类开关 + 规则表、识别词（textarea，每行一条）、空目录清理、花絮处理、自动整理默认策略。
- 新建 / 编辑任务：库类型 + 自动整理模式。
- `SaveToDriveDialog`：「转存后整理」勾选（默认取任务设置）。
- strm 管理体检：新增 `nonstandard-name` 问题类型，点过去预填整理范围。
- Telegram：`organize-done` / `organize-review`（待确认清单）两个事件，开关 `notify.organize`。

### 网盘 Provider 写操作

`DriveProvider` 加可选 `write`，`capabilities.write` 标有无；`providerForTask(task, "write")` 没有就 400：

```ts
interface DriveWriteOps {
  mkdir(parentId: string, name: string, signal?): Promise<DriveNode>;
  rename(id: string, newName: string, signal?): Promise<void>;
  renameMany?(pairs: Array<{ id: string; name: string }>, signal?): Promise<void>;   // 115 批量
  move(ids: string[], toDirId: string, signal?): Promise<void>;
  rmdirIfEmpty(id: string, signal?): Promise<boolean>;
}
```

`FakeDrive` 补同一组（`FakeTree` 已有 `move`），整理服务的测试全走它。

### 不做

- 不做 NFO / 图片刮削：目录名带 tmdbid 后 Emby 自己刮得准；以后要做也是独立功能。
- 不做复制 / 硬链接 / 软链接：网盘没有这些概念。
- 不做「仅本地」虚拟命名（理由见定位）。
- 不做 Jinja 表达式，不做音乐。
- 不删除任何网盘文件；空目录清理只碰本次腾空的目录。

### 风险与取舍

- **识别错 → 错名字进 Emby**：只有 high 才自动执行；其余人工确认；能撤销。
- **网盘风控**：批量接口 + 串行 + 账号限流；大库分目录跑；blocked 整轮停。
- **Emby 把改名后的条目当新条目**，播放记录可能丢——所有整理工具的共同代价，页面上写明，建议建库前一次整理完。
- **115 目录信息有几分钟缓存**：执行后立刻在 strm 管理页校验可能误报；本地镜像由整理器自己做，不依赖网盘再列一遍。
- **追更 / 云下载的相对路径**靠收尾回写保证，回写失败要进 run 的 error 并通知。
- **夸克没有批量接口**：一部剧几百集就是几百次请求，限速下要几分钟，预览里给预估。

## 分阶段

1. **内核（纯函数）**：`services/organize/` 下 `parse-name.ts`、`units.ts`、`rules.ts`（识别词）、`template.ts`、`plan.ts`；用一百来条真实乱命名样本做表驱动测试。
2. **Provider 写操作** 115 / 夸克 / OpenList + `FakeDrive`；表和 repository；`identify.ts`（TMDB + 缓存 + 打分）；`run.ts`（preview → apply → mirror → revert）；路由；itest 覆盖执行、续跑、撤销、镜像、监控自有事件跳过。
3. **页面**：整理页 + 设置区块 + 任务表单字段。
4. **记忆与规则**：`organize_matches`、识别词作用域、二级分类预置。
5. **自动化接入**：转存 / 追更 / 云下载 / 监控四个触发点、subPath 回写、Telegram。
6. **真机验证**：115 和夸克各过一遍——改名、跨目录移动、多版本、字幕跟随、撤销、监控不重复处理、Emby 识别结果、追更目录改写后下一次 tick 正常。

## 已定（2026-09-11，按推荐值实施）

- `{category}` 段和二级分类第一版就有，默认关；关掉时模板里的分类段自动消失。预置一份按类型 / 国家 / 语言分的分类表，设置页按行编辑。
- 集标题默认关（模板里留着 `[ - {episodeTitle}]` 可选段，开了才拉季详情）。
- 自动整理默认全局 `off`，任务上可覆盖；转存弹框有「转存后整理」勾选（任务设了 auto 就直接执行，否则待确认）。

## 进度

- [x] 内核（纯函数）：`services/organize/parse-name.ts`（64 条样本）、`rules.ts`、`units.ts`、`template.ts`、`plan.ts`、`settings.ts`、`identify.ts`（TMDB 桩测试）
- [x] Provider 写操作：`DriveWriteOps`（mkdir / rename / renameMany / move / rmdirIfEmpty），115（`files/add`、`files/batch_rename`、`files/move`、`rb/delete`，同步维护 path_cache）、夸克（`/file`、`/file/rename`、`/file/move`、`/file/delete`，异步任务轮询）、OpenList（`/api/fs/*`）、`FakeDrive`
- [x] 表与迁移 0011：`organize_runs / organize_units / organize_items / organize_matches / tmdb_cache`；repository；留存清理进 housekeeping
- [x] `run.ts`：预览（列范围 → 分单元 → 识别 → 规划 → 范围外目标目录列一次查冲突）→ 改单元重规划 → 执行（mkdir → 批量改名 → 按目标目录批量移动，批失败逐个再试 → 本地镜像 → 记账 → 删空目录 → 追更 / 云下载 subPath 改写 → 记忆 → Emby 刷新 → 通知）→ 撤销；进程重启把中断的 run 标失败可续跑
- [x] 自动整理入口 `auto.ts`：转存 / 追更 / 云下载 / 监控四个触发点，监控事件攒 30s；监控对整理自己的改名 / 移动事件按 (nodeId, 新路径) 跳过
- [x] 路由 `routes/organize/*`、设置 schema（模板 / 识别词入口校验）、任务 `organize` 字段、Telegram `organize-done / organize-review`
- [x] strm 管理体检新增「命名不规范」
- [x] 前端：`/organize` 页（范围 → 预览 → 单元卡片 / 换匹配 / 季与集偏移 / 勾选 / 记住 → 执行 → 撤销 → 历史）、设置页「整理」区块（模板实时试算、id 标签、冒号、分类、识别词、自动策略）、任务弹框（库类型 / 自动整理）、转存弹框「转存后整理」、Telegram 开关
- [x] 测试：后端 632 个全过（新增 parse-name 66、rules 7、template 6、units 6、plan 9、identify 7、run.itest 18、organize 路由 4）；前端 typecheck / lint / next build 干净
- [x] 2026-09-11 评审一轮（自审 + 自动化评审），修掉的：监控只认最终路径、认不出「先原地改名」的中间事件（现在 `findOwnOperation` 认中间路径 / 反向路径 / 建目录，按事件时间和 hits ≤ 2 限定）；按路径自动触发的 run 不列范围外目标目录（现在按整棵列过的 roots 判）；改名后没挪走的中间状态不落库（加了 `cur_path`，续跑不重复改名、撤销能改回去）；本地镜像失败被吞、监控又跳过（镜像先于 done、失败记在 error、监控见 error 不跳）；失败项再执行不重试；记忆被 repath 的旧记忆盖掉（先 repath 后 remember）；`nonstandard-name` 把集名里的 Web / Cam 当噪音（先认规范形状）；「转存后整理」的 review 语义被丢（run.mode 现在有 review）；同秒建的 run 撤销判定靠随机 id（改 rowid）；`..` 范围路径；mkdir 前先看目录在不在；夸克批量移动分批；TMDB 节流和影库刮削共用一条时间线
- [x] 2026-09-11 真机验证（本机浏览器 + 115 / 夸克真账号）：115 电影目录（`Captain.America.Brave.New.World.2025...` → `美国队长4 (2025) [tmdbid=822119]/美国队长4 (2025) - 2160p.mkv`，nfo 跟随）、115 剧集目录（`Lord.of.the.Flies.S01...` → `蝇王 (2026) [tmdbid=270572]/Season 01/蝇王 - S01Exx.mkv`）、夸克剧集目录（`亿万地堡（2025）/S01/...` → `亿万地堡 (2025) [tmdbid=245648]/Season 01/...`）各走完 预览 → 执行 → 本地 strm 镜像（内容按段 URL 编码，和生成器一致）→ 监控把自己的事件认出来跳过 → 撤销 → 网盘 / 本地都回原样；115 `files/add` 回 `cid`、夸克 `/file/move` 走任务轮询都确认了；换匹配弹框的 TMDB 搜索也在真机看过。真机暴露并修掉的：
  - 本地镜像按路径匹配任务会串到别的账号（115 和夸克都有 `tv`，夸克的整理把 strm 写进了 115 任务的本地目录）：`ExecCtx.tasks` 只放同账号的任务（和监控一致），itest 加了「别的账号同名 originPath」的用例
  - 范围目录本身腾空后不删：范围就是某个发布目录（名字带年份 / 季集标记 / 发布噪音，`looksLikeReleaseDir`）时一起删，`inbox`、`电影` 这种收件箱式的留着，任务根永远不删
  - 清单里带目录项（夸克 / OpenList 的 walkSubtree）时，子目录删掉后上级还算「没空」，从深到浅清不干净：rmdir 一层就把这条目录项从 remaining 里去掉
  - 监控认不出整理自己的删目录事件（115 的删除事件路径已经不在缓存里、报成根目录下的名字；夸克快照可能在撤销开始之后才看到执行时的那次删除）：`findOwnOperation` 加 kind=remove 按节点认（rmdir 项不看状态，mkdir 项只认 reverted），115 的新建目录事件（folder）也一并跳过；监控对所有事件种类都先问一遍
  - 页面在标签页不可见时不轮询（`document.visibilityState`），回到前台 2 秒内会刷新——不是 bug，自动化测试时容易误判，记一笔
- [x] 2026-09-11 真机第二轮（本机 Docker 起 Emby + OpenList，115 真盘造假）：
  - OpenList（Local 存储挂假媒体，ffmpeg 造的小 mkv + 手写 srt / ass / nfo）：多版本电影 `Dune.Part.Two.2024.{2160p.DV.HDR,1080p}` → `沙丘2 (2024) [tmdbid=693134]/沙丘2 (2024) - 2160p.mkv` / `- 1080p.mkv`，字幕跟随并带语言标签（`chs`→`zh-CN`、`eng`→`en`，`.ass` 也跟）；剧集两集 + 字幕 + `tvshow.nfo` 进 `怒呛人生 (2023) [tmdbid=154385]/Season 01/`；OpenList 的 mkdir / rename / move / remove 四个写操作真机通过；撤销全部回原样
  - 115：用 `files/copy` 复制现有文件伪造 `Dune.Part.Two.2024.WEB-DL`（两个 mkv + 两个 nfo），多版本命名和 nfo 跟随通过，监控把 6 条自有事件（含删目录）全认出来；撤销后删掉伪造目录，监控随之清掉本地。115 改名不能改扩展名（`.nfo` 改 `.srt` 会保留 `.nfo`），所以 115 上造不出假字幕；夸克没有复制 / 上传接口，没在夸克上造假
  - Emby（amilys/embyserver，本地 strm 目录挂进容器，库开互联网元数据）：整理完 OpenStrm 触发的 `/Library/Refresh` 生效；`[tmdbid=…]` 目录标签被 Emby 直接认成 ProviderIds.Tmdb=693134 / 154385；`片名 (年) - 1080p` / `- 2160p` 两个文件在 `/Users/{id}/Items` 里合并成一部电影两个版本（`/Items` 端点不合并是 Emby 自己的展示逻辑；同 tmdbid 的目录也会按元数据合并）；strm 里的 `http://host.docker.internal:5244/d/…` 能被 Emby 探测到流信息
  - 真机暴露并修掉的：识别打分只比本地化标题、不比原名，「Dune Part Two」被同名花絮抢走、「BEEF」认成 Celebrity Beef（搜索结果现在带 `originalTitle` 一起打分；标题和原名都没对上时拿前五名的详情看别名，谁命中选谁；搜索缓存键加了版本号让旧形状的条目过期）
- [x] 2026-09-11 v2.5.0-rc.1 发出后用户问「剧集 / 电影没放自己的目录、散在 tv/ 或 movie/ 根下会怎样」：写集成测试一跑抓到 bug——范围根下只要有一个文件带集标记，根下所有散文件都被当成同一部剧并成一个单元，文件没标题时还会拿任务目录名（tv）去搜。现在范围根只看文件标题是否一致，不一致就按标题拆，任务根的名字永远不拿去搜（`units.ts`），随 v2.5.0-rc.2 发出
- [x] 2026-09-11 生产反馈「整理完旧的 strm 还在」：现象是旧剧集目录还在、最深层却是规范后的文件名，另外新目录里也有一份。根因是整理和网盘监控赛跑——整理先原地改名再批量挪，整库整理要跑几分钟，监控在「改了名还没挪走」的窗口里拉到改名事件，而 `findOwnOperation` 只认 done / reverted 的项，pending 的没认出来，监控把本地 strm 原地改了名；等镜像按原名找本地文件找不到，就在新目录另写了一份。修法：`findOwnOperation` 认 pending 且 cur_path 非空的项（改名事件按中间名字、移动事件按目标）；`mirrorRelocate` 加 `oldPathAlt`，原名找不到时按中间名字接着搬。本机小目录几秒跑完、监控插不进来，所以之前真机没暴露。已有的残留用任务全量同步（开「删除多余文件」）或体检清掉
- [ ] 真机没覆盖到的：追更目录改写后的下一次 tick（库里没有追更订阅可用）、夸克上的多版本 / 字幕（造不出文件）
- [x] 2026-09-14 失败项处理已实施并在 OpenList / 115 / 夸克三家真机验过（设计见下一节，实施与设计的出入、真机结论都在那一节末尾的「实施记录」）：后端 `failures.ts`（分类 / 重试谓词）+ `errorKind` / `attempts` / `run.stage` + 迁移 0012 + 执行中临时失败自动重试一次 + `apply` 带 ids + `POST /runs/:id/skip` + 撤销侧 curPath / done 带错 / 再撤销 + 监控按 errorKind 跳过 + Telegram 分类文案；前端 `FailurePanel` 分组给按钮、头部按钮互斥、徽标、历史芯片。后端 647 个测试全过（新增 failures 3、run.itest 8、路由 1、监控 1、通知 1、OpenList 1），前端 typecheck / lint / build 干净。OpenList 真机（Docker Local 存储 + 真 TMDB）走完：预览后移走文件 → `object not found` 归 stale → 面板「重新预览」；本地目录只读 → mirror → 「补本地」；容器停掉再撤销 → ECONNREFUSED 归 transient、自动重试一次、run 已撤销但 1 项没退回 → 起容器「继续撤销」；整理后删掉文件再撤销 → failed + stale「已找不到」→ 放弃；预览后目标被占 → OpenList 回 `code 403 file [x] exists`——原来 Provider 把 403 一律当 auth、整轮按风控停下，已改成只有权限 / token 文案的 403 才算 auth，撞名归 rejected，批量移动失败后逐个定位到那一项，「放弃」先把原地改了名的文件改回原名（真机确认）

## 失败项处理（设计，2026-09-14，未实施）

> 用户提问：「整理或者撤销的时候，关于失败项如何优化」。下面先列现状的问题，再给方案。

### 现状的问题

代码位置：`services/organize/run.ts` 的 `execute` / `revert`、`life/monitor.ts` 的 `findOwnOperation` 跳过规则、`app/organize/page.tsx` 的 `RunView`。

1. **失败只有一种颜色**。`status = failed` + 原始错误文本（`网盘上找不到 /x`、`115 接口返回 405 …`、夸克 code），用户不知道该重试、重新预览还是放弃。
2. **「继续执行」不分青红皂白**。把所有 failed 重来一遍，包括注定失败的（源文件预览后被移走、名字网盘不接受），每次都失败，run 永远挂着「N 项失败」。
3. **没有「放弃」**。没法把某项标掉让 run 收口。
4. **本地镜像失败没有出口**。`done` + `本地镜像失败` 的项不在重试范围，只能等监控（可能没开）或全量同步。
5. **撤销侧的失败是死胡同**：
   - done 项撤销抛错 → 标 `failed`、`cur_path` 空 → 不算 `touched` → 下一次撤销不包含它；run 若已标 `reverted`，撤销按钮也没了。
   - 风控中断撤销 → run 标 `failed` → 前端按「failed + 有 failed 项」反而显示**「继续执行」**，点了会把已经在目标位置的文件按源路径去找，再报「找不到」。
   - 撤销 move 项是先挪回再改名；挪回成功、改名失败时的中间位置没记（apply 侧有 `cur_path`，revert 侧没有），第二次撤销按 `dstPath` 找不到 → 「跳过」，文件卡在 `源目录/新名字`。
   - 撤销中跳过的 done 项（不在目标位置 / 节点变了 / 目录非空）被改成 `skipped`，run 显示「已撤销」，摘要里没有「N 项没退回」——`computeStats` 只按 `action = skip` 计 skipped，按状态 skipped 的不出现在任何数字里。
6. **rmdir 被 115 缓存拖成「目录不是空的」** → `skipped`，不在重试范围，空目录永远留着。
7. **网络抖动直接记 failed**，要人来点；直链那边（`resolveDownload`）早就有 3 次重试的先例。
8. **摘要 / Telegram 只有一个数字**「失败 N」。

### 目标

- 每个失败项回答三个问题：**文件现在在哪**（状态只描述位置）、**为什么失败**（分类 + 原文）、**下一步是什么**（重试 / 重新预览 / 放弃 / 补本地）。
- 一次性失败自己消化：网络抖动在 run 内自动重试；风控 / 登录失效仍整轮停。
- run 一定能收口：所有失败项都有出路，最终 `failed` 归零或被用户明确放弃。
- 撤销和执行对称：半路状态有记录、能续、能再撤，不会把撤销失败当执行失败。

### 1. 失败分类 `errorKind`

`OrganizeItem` 加 `errorKind` 和 `attempts`（DB `error_kind text default ''`、`attempts integer default 0`），`error` 原文保留。分类函数 `classifyFailure(provider, err)` 放 `services/organize/failures.ts`，和 `drive/errors.ts` 一样按三家错误类 instanceof 判：

| kind | 判定 | 意思 | 下一步 |
|---|---|---|---|
| `blocked` | `provider.classifyError` 是 blocked / auth | 风控 / 登录失效 | 整轮停（现状）；修好账号后「重试」 |
| `stale` | 我们自己抛的 `StaleError`（源找不到、父目录没了、目标位置已被占，替换现在的字符串 `Error`）、`RemoteDirNotFoundError`、网盘的「不存在」（115 / axios 404、OpenList 的 object not found、夸克对应 code） | 预览之后网盘变了 | 「重新预览」或「放弃」；默认不重试 |
| `rejected` | 网盘明确拒绝这个名字 / 目标：同名已存在、非法字符、名字过长（各家的码 / 文案实施时按客户端里已有的认；认不出的一律归 transient） | 名字网盘不接受 | 「放弃」，提示改模板 / 识别词后重新预览；默认不重试 |
| `mirror` | 网盘那步成功、`mirrorRelocate` / `mirrorRmdir` 抛错 | 本地 strm 没跟上 | 「重试」只做本地，不碰网盘 |
| `transient` | 其余：网络 / 超时 / 5xx / 夸克任务超时 / 未知 | 临时 | run 内自动重试一次，仍失败留给「重试」 |

未知错误归 transient 是安全默认：改名 / 移动重试一次最多再失败一次，不会造成新的状态。

### 2. 状态只描述位置

不变量：**`curPath` 非空 ⇒ 文件在 `curPath`；否则由状态决定**——`pending` / `failed` 在 `srcPath`，`done` 在 `dstPath`，`reverted` 在 `srcPath`，`skipped` 不再归我们管。

- 执行失败：`failed` + kind（现状，位置语义不变；改名后挪不动的仍是 `failed` + `curPath`）。
- **撤销失败：状态保持 `done`**，只写 `error` / `errorKind`。文件确实还在整理后的位置，`touched` 仍成立，下一次撤销自然包含它；`hasLaterAppliedRun` 也照常认它。
- 撤销中「文件已不在整理后的位置 / 位置上是另一个文件 / 目录非空」：`skipped` + kind `stale`（终态，只列出来）。
- 撤销 move 项先挪回再改名：挪回成功后立刻 `updateItem({ curPath: 源目录/新名字 })`，改名成功再清空并标 `reverted`；改名失败 → `done` + `curPath` + kind。再撤销时 `done && curPath` 只做改名。撤销侧镜像传 `oldPathAlt: curPath`（和 apply 侧对称，监控抢先动了本地也能找到）。
- rmdir「目录不是空的」：仍 `skipped`，但 kind `transient`，重试集合里包含它（一次 listDir + 可能的删除，幂等、便宜）。

监控的跳过规则从 `own.error === ""` 改成 **`own.errorKind !== "mirror"`**：撤销在网盘那步失败的项本地和网盘仍一致，自有事件照旧跳过；只有镜像失败才让事件去补本地。`findOwnOperation` 对 done 项认的中间路径 `源目录/新名字` 恰好也是撤销的中间位置（先挪回再改名），不用改。迁移时把已有 `done` 且 error 以「本地镜像失败」开头的项回填 kind `mirror`，规则切换才不漏。

### 3. `run.stage` 与按钮

`OrganizeRun.stage: "apply" | "revert"`（DB `stage text default 'apply'`）。`revertRun` 开始时置 `revert`，之后不再回到 apply——开始撤销的 run 只能继续撤销。

- `applyRun`：`stage === "revert"` 一律 409「这次整理已经开始撤销，只能继续撤销」。前端 `canApply` 同一条件，彻底堵掉问题 5 的第二条。
- `revertability`：状态在 `done / failed / cancelled / reverted` 之一（多了 `reverted`）+ 仍有 `touched` 项 + 没有更晚的已执行 run。`hasLaterAppliedRun` 的状态列表补上 `reverted`（有剩余 done 项的「已撤销」run 还是占着文件）。
- 撤销收尾的 run 状态：全部退回 → `reverted`；有剩余但没被风控打断 → 仍 `reverted`，`stats.notReverted > 0`，界面「已撤销 · N 项没退回」+「继续撤销」；风控 / 登录中断 → `failed` + error，`stage = revert`，界面「继续撤销」，绝不出现「继续执行」。
- 执行收尾不变：有单项失败仍是 `done`，界面「已完成 · N 项失败」+「重试失败项」。

迁移回填：`status in ('reverted','reverting')` 的 run → `stage = 'revert'`。

### 4. run 内自动重试

写操作统一包一层 `attempt(it, fn)`：失败先 `classifyFailure`，`transient` 且 `attempts < 2` 就等 `RETRY_DELAY_MS = 3000` 再来一次；`blocked` 立即抛出让整轮停；其余直接记失败。每次真实尝试 `attempts + 1`。批量改名 / 移动失败后现有的「改为逐个」本身就是一次重试，transient 时在逐个之前也等 3 秒；`blocked` 不逐个。镜像失败不自动重试（本地 FS 错误基本不是抖动），留给「重试」。

### 5. 重试集合

`applyRun` 加可选 `{ ids?: string[] }`。不给 ids 时按 `retryable(it)` 取：

- mkdir / rename / move：`pending`；`failed` 且 kind ∈ {transient, blocked, ''}；`done` 且 kind `mirror`（只重做镜像，不碰网盘）。
- rmdir：`pending` / `failed` / `skipped` 都重来。
- kind `stale` / `rejected` 的 **只有 ids 里点名才重试**（面板上用户对着那一组点「重试」）。

执行顺序不变：mkdir → 改名 → 移动 → 镜像补做 → rmdir。镜像补做单独一步放在网盘操作之前，网盘被风控时本地也能先补上。

### 6. 「放弃」

`POST /api/organize/runs/:id/skip { ids }`（≤ 500 个；有 job 在跑就 409）：

- `failed` 且 `curPath` 空：直接 `skipped`，kind 保留，error 前缀「已放弃：」。
- `failed` 且 `curPath` 非空（原地改了名、没挪走）：先在网盘上把名字改回 `srcPath` 的名字（一步），成功才 `skipped`；改不回去就仍是 `failed` + 新 error。原则：**放弃 = 用一步把文件放回干净位置，没有这一步的只能重试**。
- `done` + kind `mirror`：`skipped`，error「已放弃：本地未同步，可用全量同步或体检补齐」。
- `stage = revert` 的 `done` + error 且 `curPath` 空：`skipped`，error「已放弃撤销，文件留在整理后的位置」；`curPath` 非空（挪回了没改名）的**不给放弃**，只能重试（改回原名就是那一步失败的操作本身，没有别的干净位置）。兜底出口是删记录。
- 放弃 mkdir 项时把 `dstPath` 在它之下的 pending / failed 项一起放弃（不然它们下次重试全变 stale）。

放弃后重算 stats；`failed` 减少，run 能收口成干净的 `done` / `reverted`。

### 7. 「重新预览」

前端行为，不加接口：对 stale 一组点「重新预览」= 先对这组调 skip，再 `POST /api/organize/runs { taskId, subPath: run.scopePath, paths: run.scopePaths }`（**同范围**）并跳到新 run。幂等性保证已整理好的全是 `keep`，新 run 里只剩真正没做的；TMDB 有缓存，二次识别便宜。不按单元目录重新预览：单元源目录常常已被腾空删掉，按它扫只会得到空 run。

### 8. 摘要与通知

- `stats` 加 `failedByKind: Record<kind, number>`、`notReverted`（stage revert 下 done-带错 + skipped-stale 之和）。stats 是 JSON，不用迁移。
- 历史列表每行带「N 项失败」/「N 项没退回」小徽标。
- Telegram `organize-done`：`失败 3（临时 2、预览后变了 1），到「整理」页重试或放弃`；撤销变体 `N 项没退回`。payload 加 `failedByKind` / `notReverted`。自动模式（auto）的 run 失败也只到这一步：run 内已经自动重试过临时失败，风控停了就是要人管，不再排定时重试。

### 9. 前端

- `RunView` 头部和单元列表之间加 `FailurePanel`，只在有事可做时出现。分组顺序：网盘拒绝 / 需要重新登录 → 临时失败 → 预览后变了 → 名字不被接受 → 本地没跟上 → （stage revert）没退回。每组：数量、一句话解释、按钮（重试 / 重新预览 / 放弃，按上面的规则出现）、展开看项（路径、错误原文、已试 N 次）。
- 头部按钮互斥：`ready` →「执行 N 项」；`stage apply` 且有可重试项 →「重试失败项（N）」；`stage revert` 且 `revertable` →「继续撤销」。
- `ItemStatus` 徽标：`failed` →「失败 · 临时 / 预览后变了 / 名字不被接受 / 网盘拒绝」；`done` + mirror →「完成，本地未同步」（现有）；`stage revert` 的 `done` + error →「未退回」；`done` + `curPath` →「已挪回，待改名」；`skipped` + kind →「已放弃」。
- 放弃的确认框说明半路项会先改回原名。

### 10. 迁移 0012

```sql
ALTER TABLE organize_items ADD COLUMN error_kind text DEFAULT '' NOT NULL;
ALTER TABLE organize_items ADD COLUMN attempts integer DEFAULT 0 NOT NULL;
ALTER TABLE organize_runs ADD COLUMN stage text DEFAULT 'apply' NOT NULL;
UPDATE organize_runs SET stage = 'revert' WHERE status IN ('reverted', 'reverting');
UPDATE organize_items SET error_kind = 'mirror' WHERE status = 'done' AND error LIKE '本地镜像失败%';
```

### 11. 测试（run.itest 追加）

- transient 自动重试：第一次 rename 抛网络错、第二次成功 → 项 `done`、`attempts = 2`、run 无失败。
- blocked 不自动重试、整轮停（现有用例加 kind 断言）。
- stale：预览后删掉源文件 → `failed` + kind `stale`；不带 ids 的重试不碰它；带 ids 重试再失败一次；skip 后 run 收口。
- 放弃半路项：move 失败留 `curPath` → skip → 网盘上名字改回原名、状态 `skipped`。
- mirror 补做：镜像抛错 → `done` + kind `mirror`；再 apply 只做本地、网盘调用计数不变。
- 撤销单项失败：一项 move 回去时抛错 → 状态仍 `done` + kind、run `reverted`、`notReverted = 1`、`revertable.ok`；第二次撤销完成。
- 撤销半路：挪回成功、改名失败 → `done` + `curPath`；第二次撤销只改名（rename 计数 +1、move 不变）；本地镜像回到原位。
- 撤销开始后 apply 409；风控中断撤销的 run 前端条件（`stage`）由 `getRunDetail` 的字段钉住。
- 监控：done + revert 失败（kind transient）的自有事件仍跳过；kind mirror 的不跳（现有用例改按 kind）。
- 迁移回填：旧数据的 reverted run 有 `stage = revert`、镜像失败项有 kind `mirror`。

### 不做

- 不做逐项改目标名（`rejected` 的路是改模板 / 识别词后重新预览）。
- 不做跨 run 的定时自动重试；run 内一次 + Telegram 提醒 + 一键重试够用。
- 不改「run 有单项失败仍算 `done`」的语义。

### 分阶段

1. 后端：`failures.ts` + `errorKind` / `attempts` + run 内自动重试 + stats 分类 + 迁移 0012。
2. 撤销对称：`stage`、done 带错、撤销侧 `curPath`、再撤销、监控按 kind 跳过。
3. skip 接口 + 重试集合 + apply `ids`。
4. 前端面板 / 按钮 / 徽标 + Telegram 文案。
5. 真机：115 上人为制造 stale（预览后手动挪走一个文件）、撤销时断网一次、镜像目录改成只读各走一遍。

### 实施记录（2026-09-14）

- `attempts` 的含义改成「这一项被执行 / 撤销了几轮」（每轮 apply / revert 对处理到的项 +1，执行中的自动重试不算），界面上「已试 N 轮」；原设计的「每次真实尝试」会把 先改名再移动 的正常两步也算成 2 次，用户看着像失败过。
- 撤销时「文件已不在整理后的位置 / 位置上是另一个文件」记成 `failed` + `stale`（不是 skipped）：这样 `notReverted` 能只数 done + failed-stale，执行时就没成的 failed（非 stale，文件还在原处）不算没退回；面板里这组叫「已找不到」，只有「放弃」。
- 撤销循环用 `revertWorkItem(it, true)`：连上一轮「目录不是空的」留下的 skipped 自建目录也再看一眼（文件退回后可能空了）；判断「还有没有事」（revertability、放弃后收口）用不带参数的版本，不然永远退不完。
- 撤销循环里的分支顺序：先 reverted+mirror 补本地 → 再 `curPath && status !== done`（执行侧半路项改回原名）→ 再按 action 分；一开始写成 `status !== done` 让 skipped 的 mkdir 项走进了改名分支，`resolvePath("")` 拿到根目录、把整棵假网盘改了名（itest 抓到的）。
- `retryableItem` 对 rmdir：skipped + stale（目录已经不在）不再试；skipped + transient（不是空的）顺带再看一眼，但 `applicable` 判「有没有事」时不算它，免得每个完成的 run 都挂着「重试失败项」。
- OpenList 的 `classifyError`：`code 403` 只有文案像权限 / token（permission / forbidden / token / login / guest…）才算 auth；`file [x] exists` 这种文件系统层的 403 归 null，由 `classifyFailure` 按文案归 rejected。真机踩到。
- 「重新预览」按 run 的原范围建新 run：范围是子目录（inbox）时，已经挪出去的作品不在范围里，新 run 只剩没做的（可能是 0 部作品）；范围是整个任务时已整理好的全是「不变」。两种都对，界面文案「已经整理好的会显示为不变」在子目录范围时不完全适用，先不改。
- **动手前先看一眼目标目录（2026-09-14 真机之后加的）**：115 的 `files/move` 遇到同名不报错，悄悄把挪进去的文件改成 `xxx(1)`，记账里的 dstPath 和真实名字对不上、本地 strm 指向别人的文件（115 真机撞到）。现在改名前看源目录、移动前看目标目录、撤销挪回前看原位置，有同名就记 `rejected` 不碰网盘（`namesIn` + `occupied` + `clashError`）；刚 mkdir 的目录直接当空的不列。列目录走 `provider.listDir(id, signal, { fresh: true })` 绕过 115 进程内 5 分钟的 `filesListCache`（`DriveProvider.listDir` 多了可选的第三个参数，只有 115 实现），不然预览之后别人放进来的看不见。夸克对同名是明确拒绝（`/file/rename` 400 code 23008 `file is doloading[存在同名文件]`，`同名` 命中 REJECTED_RE），OpenList 回 403 `file [x] exists`。
- **115 / 夸克真机（2026-09-14）**：115 用 `files/copy` 从真文件复制三份到隔离目录 `_orgtest115/BEEF.S01.1080p/`（认成 怒呛人生 154385），夸克把 亿万地堡 的 E01–E03 挪进 `_orgtest/亿万地堡.S01.2025.1080p/` 改成乱名（认成 245648 high），后端用拷到 scratch 的库（监控 / Telegram / Emby / cron 全关，本地 strm 只写 scratch）。走通：预览后挪走文件 → 115 `网盘上找不到` 归 stale（夸克按 id 操作，挪走的文件照样能改名移动，做不出 stale）；预览后目标被占 → 两家都被动手前的检查拦成 rejected、半路项「放弃」改回原名（115 上第一次跑就是这里暴露了悄悄改成 (1) 的问题）；整理后删掉 / 挪走文件再撤销 → `failed + stale`「已找不到」→ 放弃。结束后 115 的伪造目录整个进回收站，夸克目录树和开始时逐字节一致。没覆盖：风控（不能故意触发）、夸克上的 stale（不删真文件做不出来）。另外夸克把目标季目录改名之后整理照样成功——它按缓存里的目录 id 挪，文件进了改名后的目录而记账仍是旧路径，本地 strm 要等监控快照纠正，属于按 id 的网盘固有行为，没改。
- 真机实验的坑：`pkill -f "tsx src/index.ts"` 杀不到（真实进程是 `node …/tsx/dist/cli.mjs src/index.ts`），端口占着新进程起不来还以为重启了；115 进程内目录缓存 5 分钟，脚本在另一个进程里挪了文件、后端预览还按旧清单算冲突，要么等要么重启后端。

### 评审后的修补（2026-09-14 晚，未提交部分随同步失败分类一起在工作区）

代码评审（八个角度 + 核实）在 2d07cd8 上抓到并修掉的：
- **连环改名被误判成撞名**：集偏移这种 E02→E01、E03→E02 的计划，改名前的检查看到目标名被占就拒了。现在占着名字的是本轮自己的节点就不算撞名（`occupied` 认一组「我们的」id），按依赖排序一个个改（占着我目标名的那项先改；A↔B 互占才拒），有连环时不用批量改名接口。移动那步同理：被本轮别的项占着的先推迟，所有批次跑完再来一遍。
- **进程崩溃后重跑把已经挪好的文件判成撞名**：目标目录里那个同名文件就是自己的节点 → 直接记账（含镜像），不再挪；改名那步同样。
- **「放弃」改成显式字段 `givenUp`**（表 `organize_items.given_up`，迁移 0012 重出，仍未发布）：不再靠错误文案前缀。放弃镜像失败的项保留 `errorKind = mirror`（监控见到自有事件仍会把本地补回来），只是不进统计 / 面板 / 重试集合；撤销阶段放弃 done 项也保持 `done`（文件就在那里），`revertWorkItem` 对 givenUp 的 done 不再算有事。
- **撤销循环不再碰放弃掉的失败 mkdir**：skipped 的 mkdir 只在有 nodeId（真建过）且不是放弃的才再看一眼，否则会把别人后来建的同名目录删掉。
- **撤销阶段放弃执行时改了名没挪走的项**：以前直接标 skipped 把位置忘了；现在不管哪个阶段，带 curPath 的 failed / pending 一律先改回原名。
- **放弃时的原名占用检查**改用 `namesIn`（fresh 列目录）+ `occupied`，和执行 / 撤销同一套；`namesIn` / `dirIdOf` 现在只要 `ListCtx`（provider / signal / 两个缓存）。
- **目录缓存原地更新**：改名 / 挪动之后 `noteRenamed` / `noteMoved` 改本轮缓存，不再整个丢掉再 fresh 列一遍（扁平目录几百部电影就是几百次列目录）。刚 mkdir 的目录直接当空的。
- **迁移回填补全**：`stage = revert` 也覆盖被风控 / 取消打断、状态是 failed / cancelled 但已有 reverted 项的 run；`error_kind = mirror` 也覆盖 reverted 状态的旧镜像失败项。
- **OpenList `listDir` 把 `fresh` 传成 `refresh`**：之前忽略了，撞名检查在 OpenList 上读的是它自己的缓存。
- **`notReverted` 只数撤销时找不到的**（撤销给 lost 项记了 finishedAt），执行时就没成的 stale 失败（文件在原处）不算。
- **失败面板分组挪到后端**（`failureGroups` → `OrganizeRunDetail.groups`，含每组的 retry / skip / repreview / held），前端只管文案（`failureGroupMeta`）；`applicability.count` 不再把「目录不是空的」的 rmdir 算进按钮上的数字。
- 清理：`messageOf` 收进 `lib/errors.ts`，`errMsg` / `causeOf` 删掉；两个分类器不再 import 三家客户端的错误类，改用 `drive/errors.ts` 的 `driveErrorFacts`（状态码 / 传输层 / 异步任务 / 登录码）；`REJECTED_RE` 去掉 `invalid`、`missing` 这种泛词；执行前的失败项归零用一条 `updateItems`。
- 没改的（评审提过但不值得）：`curPath` 在执行 / 撤销两个阶段各有含义（靠 status 区分，路径本身相同）；前端 `groups` 之外仍保留 `applicable` / `revertable` 两个后端算的开关。
- 新增用例：连环改名按依赖顺序、上次挪到一半没记账、撤销阶段放弃半路项 + 放弃掉的 mkdir 不碰同名目录；放弃镜像 / 放弃撤销的断言改成看 `givenUp`。
### 真机复测（2026-09-14 晚，评审修补之后）

环境同上一轮：Docker OpenList（Local 存储 + 假媒体）、115 / 夸克真账号、后端跑 scratch 拷贝的库（迁移 0012 在拷贝上跑过，监控 / Telegram / Emby / cron 全关）、真 TMDB。走通：

- A 预览后目标被占 → rejected（动手前的检查拦住，网盘没动）→「放弃」先改回原名 → run 收口成 done → 撤销：放弃项原地不动、其余退回、本地 strm 跟着回。
- B1 已规范命名的目录（在 `done/` 子目录里）带集偏移 +1 → 执行时同目录连环改名按依赖顺序（E03→E04 先）→ 撤销全部退回、目录树和 strm 与开始时一致。
- B2 目录已在库里只改集号（纯 rename 项）→ 撤销。
- C 整理后在网盘外删掉一个文件再撤销 → `failed + stale`「已找不到」→ 放弃 → `notReverted` 归零、run 收口。
- D 本地作品目录只读 → 三项 done + mirror（文案「没有写入 data 目录的权限；检查属主 / PUID / PGID」）→ 放弃一项 → 目录改回可写「重试」只补其余两项 → 撤销连放弃过的那项一起退回。
- 夸克真机：亿万地堡 E06–E08 用 `paths` 圈出来、集偏移 +1 原地连环改名（E08→E09 先）→ 撤销按依赖倒序改回，季目录清单（名字 / id / 大小）逐字节一致。
- 浏览器：整理页 `?run=` 打开 A 的 run，头部徽标、「需要处理的项」面板（名字不被接受 · 1，重试 / 放弃 / 看文件）、放弃对话框、撤销都走了一遍。

复测暴露并修掉的两个 bug（都是撤销侧）：

1. **撤销顺序**。撤销按流水账逆序退，连环改名的项倒回来会撞自己人：E03→E04 先退成 E03，轮到 E02→E03 挪回时中间名 E03 已经被占 → rejected（OpenList 真机就是这样挂的）。新增 `orderRevert`：A 的原名现在被本轮还没退回的 B 占着（同一原目录里 B 现在的名字 == A 的原名）就等 B 先退；跨目录挪回的 A 顶着现在的名字进原目录，撞上还在原目录里的 B 也等 B；转圈互占的单列记 rejected；目录项位置不动。用例两条（跨目录 / 同目录），把排序拿掉都会挂。
2. **放弃过镜像失败的项撤销时不退回**。`revertWorkItem` 对 givenUp 的 done 一律不算事，把「放弃补本地」和「放弃撤销」混成一个了——放弃本地镜像的项网盘那步是做过的，撤销时照样要退，不然 run 标已撤销、文件却留在整理后的位置。现在 done + mirror + givenUp 仍进撤销；撤销侧的结果都是新账（退回 / 网盘失败 / 找不到都把 givenUp 清掉，退回后不再显示「放弃」）；放弃镜像的对话框补一句「之后撤销时照样退回」。用例 + `failures.test` 断言。

顺手：rmdir「目录不是空的」的 115 缓存那句只在 115 上说。没改的观察：撤销时「已找不到」的项，本地 strm 留在整理后的位置（文件本来就不在了），等全量同步 / 体检清掉。

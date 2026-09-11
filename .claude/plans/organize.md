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
- [x] 测试：后端 631 个全过（新增 parse-name 66、rules 7、template 6、units 6、plan 9、identify 7、run.itest 17、organize 路由 4）；前端 typecheck / lint / next build 干净
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
- [ ] 真机没覆盖到的：追更目录改写后的下一次 tick（库里没有追更订阅可用）、夸克上的多版本 / 字幕（造不出文件）

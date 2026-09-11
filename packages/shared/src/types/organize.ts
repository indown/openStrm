/**
 * 整理与规范化命名：把网盘里的原始命名整理成媒体服务器认得的
 * `作品 (年份) [tmdbid=…]/Season 01/作品 - S01E01.ext`。整理作用在网盘上，本地 strm 由整理器镜像。
 * 设计见 .claude/plans/organize.md。
 */

export type OrganizeMediaType = "movie" | "tv";

/** 识别置信度：high 才允许自动执行；none 是没匹配上，预览里单列「待处理」 */
export type OrganizeConfidence = "high" | "medium" | "low" | "none";

/** 一次整理（run）的状态 */
export type OrganizeRunStatus =
  | "planning"
  | "ready"
  | "applying"
  | "done"
  | "failed"
  | "cancelled"
  | "reverting"
  | "reverted";

/** manual 手动预览；review 自动触发但只生成待确认清单；auto 自动触发且把握大的直接执行 */
export type OrganizeRunMode = "manual" | "review" | "auto";

/** 谁发起的：手动、转存、追更、云下载、网盘监控 */
export type OrganizeTrigger = "manual" | "share" | "follow" | "offline" | "monitor";

/** 计划项的动作 */
export type OrganizeAction = "keep" | "rename" | "move" | "mkdir" | "rmdir" | "skip" | "conflict";

export type OrganizeItemStatus = "pending" | "done" | "failed" | "skipped" | "reverted";

/** 文件在整理里的类别 */
export type OrganizeFileKind = "video" | "subtitle" | "nfo" | "image" | "extra" | "dir" | "other";

/** id 标签的写法：Emby `[tmdbid=1]`、Jellyfin `[tmdbid-1]`、Plex `{tmdb-1}`、不写 */
export type OrganizeIdTagStyle = "emby" | "jellyfin" | "plex" | "none";

/** 冒号处理：smart（`: ` → ` - `，其余 → `-`）、delete、dash（`-`）、spaceDash（` -`） */
export type OrganizeColonStyle = "smart" | "delete" | "dash" | "spaceDash";

/** 花絮（trailer / featurette / extras 目录里的）怎么办：不动，或挪进作品目录下的 extras/ */
export type OrganizeExtrasMode = "keep" | "move";

/** 任务级自动整理：off 不自动；review 只生成待确认的 run 并通知；auto 高置信度且无冲突的直接执行 */
export type OrganizeAutoMode = "off" | "review" | "auto";

/** 二级分类规则：全部条件同时满足才命中，按顺序第一条命中的生效；都不中用兜底 */
export interface OrganizeCategoryRule {
  name: string;
  /** TMDB genre id 列表，任一命中即可 */
  genreIds?: number[];
  /** 剧集 origin_country / 电影 production_countries，任一命中即可（ISO 3166-1） */
  countries?: string[];
  /** original_language，任一命中即可（ISO 639-1） */
  languages?: string[];
}

export interface OrganizeCategorySettings {
  enabled?: boolean;
  movie?: OrganizeCategoryRule[];
  tv?: OrganizeCategoryRule[];
}

export interface OrganizeSettings {
  templates?: { movie?: string; tv?: string };
  idTag?: OrganizeIdTagStyle;
  colon?: OrganizeColonStyle;
  /** 拉季详情把集标题写进文件名；每部剧多几次 TMDB 请求 */
  episodeTitle?: boolean;
  categories?: OrganizeCategorySettings;
  /** 自定义识别词，每行一条：屏蔽词 / A => B / 前 <> 后 >> EP+1（集数偏移）/ 直指 tmdbid */
  rules?: string[];
  /** 执行后删掉本次腾空的源目录 */
  cleanupEmptyDirs?: boolean;
  extras?: OrganizeExtrasMode;
  /** 没在任务上单独设置时的默认自动整理策略 */
  auto?: OrganizeAutoMode;
}

/** 任务级整理设置 */
export interface TaskOrganizeSettings {
  mode?: OrganizeAutoMode;
  /** 这个任务的库是电影 / 剧集 / 混合：识别时当作先验，混合按识别结果分流 */
  libraryType?: "movie" | "tv" | "mixed";
}

/* ------------------------------- 识别结果 ------------------------------- */

export interface OrganizeCandidate {
  tmdbId: number;
  mediaType: OrganizeMediaType;
  title: string;
  year: string;
  posterUrl: string;
  overview?: string;
  score: number;
}

export interface OrganizeSeasonInfo {
  season: number;
  episodeCount: number;
  name?: string;
}

/** 一个作品单元的识别结果 */
export interface OrganizeMatch {
  mediaType: OrganizeMediaType;
  tmdbId: number;
  title: string;
  originalTitle: string;
  enTitle?: string;
  year: string;
  posterUrl: string;
  imdbId?: string;
  confidence: OrganizeConfidence;
  /** 一句话：为什么这么认（nfo / 影库 / 记忆 / 识别词 / 标题年份都对上 …） */
  reason: string;
  /** 用来算二级分类 */
  genreIds?: number[];
  countries?: string[];
  originalLanguage?: string;
  seasons?: OrganizeSeasonInfo[];
  /** 备选（预览里「换匹配」时先给这些） */
  candidates?: OrganizeCandidate[];
}

/* ------------------------------- run / unit / item ------------------------------- */

export interface OrganizeRunStats {
  units: number;
  items: number;
  /** 需要动的项（rename / move / mkdir / rmdir） */
  planned: number;
  keep: number;
  conflicts: number;
  skipped: number;
  done: number;
  failed: number;
  /** 置信度分布 */
  confidence: Record<OrganizeConfidence, number>;
  /** 收尾时改写了几条追更 / 云下载回执的目录 */
  rewrittenPaths?: number;
}

export interface OrganizeProgress {
  phase: "walk" | "identify" | "plan" | "apply" | "revert" | "idle";
  done: number;
  total: number;
  message: string;
}

export interface OrganizeRun {
  id: string;
  taskId: string;
  accountName: string;
  /** 相对任务 originPath 的范围目录；"" 是整个任务 */
  scopePath: string;
  /** 自动触发时给的一组新增路径（相对任务 originPath）；手动整理为空 */
  scopePaths: string[];
  mode: OrganizeRunMode;
  trigger: OrganizeTrigger;
  status: OrganizeRunStatus;
  stats: OrganizeRunStats;
  error: string;
  /** 最近的日志行 */
  log: string[];
  /** 秒 */
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** 只有进行中的 run 才有：从内存里带出来 */
  progress?: OrganizeProgress;
}

export interface OrganizeUnit {
  runId: string;
  key: string;
  /** 单元根目录，相对任务 originPath；"" 是范围根 */
  rootPath: string;
  /** 目录名或从文件名综合出来的原始名字，给界面看 */
  rawName: string;
  /** 解析出来的标题 / 年份（用来搜索），识别失败时界面还能显示 */
  parsedTitle: string;
  parsedYear: string;
  match: OrganizeMatch | null;
  /** 用户改过的季 / 集偏移 */
  seasonOverride: number | null;
  episodeOffset: number;
  /** 整理后的作品根目录（相对任务 originPath）；没匹配上为空 */
  dstRoot: string;
  selected: boolean;
  /** 「记住」：把这次的识别结果写进 organize_matches，下次同目录直接用 */
  remember: boolean;
  fileCount: number;
  videoCount: number;
  /** 被追更 / 云下载回执引用的次数：执行后会自动改写 */
  referencedBy: number;
  /** 单元级的问题说明（比如「集数超过该季集数，按绝对集数折算」） */
  notes: string[];
}

export interface OrganizeItem {
  id: string;
  runId: string;
  unitKey: string;
  seq: number;
  kind: OrganizeFileKind;
  action: OrganizeAction;
  /** 网盘绝对路径，带前导 / */
  srcPath: string;
  dstPath: string;
  nodeId: string;
  /** 为什么是这个动作（冲突 / 跳过的原因） */
  reason: string;
  status: OrganizeItemStatus;
  error: string;
  finishedAt: number | null;
  /** 移动项已经原地改了名、还没挪走时的当前路径；挪完为空 */
  curPath: string;
  /** 网盘监控按「整理自己做的」跳过了几条事件 */
  hits: number;
}

/** GET /api/organize/runs/:id 的形状 */
export interface OrganizeRunDetail {
  run: OrganizeRun;
  units: OrganizeUnit[];
  items: OrganizeItem[];
  /** 撤销这次 run 允不允许、为什么不允许 */
  revertable: { ok: boolean; reason?: string };
}

/** 用户在预览里改一个单元 */
export interface OrganizeUnitPatch {
  match?: { mediaType: OrganizeMediaType; tmdbId: number };
  seasonOverride?: number | null;
  episodeOffset?: number;
  selected?: boolean;
  remember?: boolean;
}

/** 用户确认过的识别，按账号 + 目录记住 */
export interface OrganizeMatchMemory {
  accountName: string;
  /** 网盘绝对路径 */
  srcPath: string;
  mediaType: OrganizeMediaType;
  tmdbId: number;
  title: string;
  year: string;
  season: number | null;
  episodeOffset: number;
  updatedAt: number;
}

/** 设置页模板试算 */
export interface OrganizeTemplatePreview {
  movie: string;
  tv: string;
  errors: string[];
}

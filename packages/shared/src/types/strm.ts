/**
 * strm 管理页的接口形状：按同步任务浏览本地 strm 输出目录、体检、校验、修正、重建。
 * 所有 path 都是 POSIX 风格、相对任务 targetPath 的路径，"" 表示任务根目录。
 */

export type StrmEntryKind = "dir" | "strm" | "download" | "part" | "other";

export interface StrmEntry {
  name: string;
  isDir: boolean;
  kind: StrmEntryKind;
  /** 字节；目录为 0 */
  size: number;
  /** 毫秒时间戳 */
  mtime: number;
  /** 符号链接（目录不会被递归进入，删除只删链接本身） */
  isSymlink?: boolean;
}

export interface StrmListResult {
  path: string;
  /** 任务根目录还不存在（任务没跑过）时为 false，entries 为空；子目录不存在则是 404 */
  exists: boolean;
  entries: StrmEntry[];
}

export type StrmSearchHit = StrmEntry & { path: string };

export interface StrmSearchResult {
  hits: StrmSearchHit[];
  /** 命中数超过上限，只返回了前面一部分 */
  truncated: boolean;
}

/**
 * strm 内容解析不出 / 不该重写的原因：
 * empty 空文件；no-ext 内容最后一段没有扩展名；name-mismatch 内容里的文件名和本地文件名对不上（手改过或指错了文件）；
 * prefix-mismatch 前缀和任务现在的 strmPrefix 对不上（仍可按任务配置重写）
 */
export type StrmParseReason = "empty" | "no-ext" | "name-mismatch" | "prefix-mismatch";

export interface StrmFileInfo {
  path: string;
  content: string;
  /** 按任务当前 strmPrefix / originPath / enablePathEncoding 应有的内容 */
  expectedContent: string;
  /** 应有内容对应的网盘路径（不带前缀、未编码） */
  expectedRemotePath: string;
  /** 从现有内容解析出的网盘路径；解析不出为 null */
  actualRemotePath: string | null;
  matches: boolean;
  reason?: StrmParseReason;
}

export type StrmIssueType =
  | "nested-same-name"
  | "empty-dir"
  | "stale-content"
  | "unparsable"
  | "duplicate-episode"
  | "leftover-part"
  | "nonstandard-name";

export interface StrmIssue {
  type: StrmIssueType;
  path: string;
  detail?: string;
  /** 同一问题涉及的其它路径（重复剧集的其余几份） */
  related?: string[];
}

export interface StrmScanResult {
  files: number;
  strm: number;
  dirs: number;
  /** 条目数超过上限，只扫描了一部分 */
  truncated: boolean;
  /** 落在扫描范围内、但属于其它任务的输出目录，整棵跳过 */
  skippedRoots: string[];
  /** 每类问题的总数；issues 里每类最多列出一部分 */
  counts: Record<StrmIssueType, number>;
  issues: StrmIssue[];
}

export interface StrmRewriteResult {
  dryRun: boolean;
  checked: number;
  changed: number;
  /** 同一目录里属于其它任务的 strm，跳过不动 */
  foreign: number;
  skippedRoots: string[];
  unparsable: Array<{ path: string; reason: StrmParseReason }>;
  /** 前几条 from → to 样例 */
  samples: Array<{ path: string; from: string; to: string }>;
}

export type StrmRegenerateMode = "fill" | "rebuild";

export interface StrmRegenerateResult {
  mode: StrmRegenerateMode;
  /** 从 115 导出到的文件数（按 strm 扩展名过滤后） */
  remoteFiles: number;
  generated: number;
  skipped: number;
  /** rebuild 时删掉的本地多余 strm 数 */
  removed: number;
}

export interface StrmVerifyResult {
  checked: number;
  dirs: number;
  missing: Array<{ path: string; remotePath: string; reason: "dir-missing" | "file-missing" }>;
  unparsable: Array<{ path: string; reason: StrmParseReason }>;
  /** 某个网盘目录没查成功（网络等原因），这些文件既不算缺失也不算存在 */
  errors: Array<{ remoteDir: string; message: string }>;
  /** 给界面看的说明：115 目录缓存有延迟，刚转存 / 刚删的可能误报 */
  note: string;
}

export interface StrmDeleteResult {
  deleted: number;
  failed: Array<{ path: string; message: string }>;
}

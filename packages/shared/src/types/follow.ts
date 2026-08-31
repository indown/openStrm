/**
 * 分享追更：盯住一个 115 分享里的目录，周期性地把新增的文件转存到某个同步任务的目录并生成 strm。
 */

export type ShareFollowStatus = "idle" | "checking" | "error" | "expired" | "stale";

/** 快照里的一条：路径相对被盯的目录（watchCid），目录不带尾部斜杠 */
export interface ShareFollowEntry {
  path: string;
  isDir: boolean;
  sha1?: string;
  size?: number;
}

/** 一次有动静的检查：新增了什么、跳过了什么（被替换 / 改名 / 范围目录不见了）、出了什么错 */
export interface ShareFollowRun {
  /** ms */
  at: number;
  /** 这次转存成功的相对路径 */
  added: string[];
  /** "路径：原因" */
  skipped: string[];
  /** 生成的 strm 数 */
  generated: number;
  error?: string;
}

export interface ShareFollow {
  id: string;
  name: string;
  /** 从影库条目建的订阅记一下来源，界面借它的封面；条目删了也不影响订阅 */
  libraryId: string | null;
  shareUrl: string;
  shareCode: string;
  receiveCode: string;
  /** 被盯的分享目录 id，"0" 是分享根目录 */
  watchCid: string;
  /** 展示用：被盯目录在分享里的路径 */
  watchPath: string;
  /**
   * 追更范围，相对 watchCid：`[""]` 表示整个被盯目录（勾了文件时），
   * 否则是勾选的目录名列表（只追这些目录里面的新增）
   */
  scope: string[];
  taskId: string;
  /** 相对 task.originPath 的子目录，已 normalize；空串表示就在 originPath 下 */
  subPath: string;
  enabled: boolean;
  intervalMinutes: number;
  status: ShareFollowStatus;
  lastError: string;
  /** 连续失败次数：退避和"分享失效"判定都看它 */
  errorStreak: number;
  /** ms */
  lastCheckedAt: number | null;
  /** 最近一次真的转存了东西的时间（ms）；判 60 天没更新用 */
  lastChangeAt: number | null;
  /** ms；循环挑到期的看它 */
  nextCheckAt: number;
  known: ShareFollowEntry[];
  /** 最近 20 次有动静的检查，新的在前 */
  recent: ShareFollowRun[];
  /** unix 秒 */
  createdAt: number;
  updatedAt: number;
}

/** 列表接口给的是这个：不带快照本身，只给条数 */
export type ShareFollowSummary = Omit<ShareFollow, "known"> & { knownCount: number };

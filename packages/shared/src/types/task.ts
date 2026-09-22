import type { TaskOrganizeSettings } from "./organize.js";

export interface TaskDefinition {
  id: string;
  account: string;
  accountType?: string;
  originPath: string;
  targetPath: string;
  strmPrefix?: string;
  removeExtraFiles?: boolean;
  enablePathEncoding?: boolean;
  enable302?: boolean;
  cronExpression?: string;
  /** 表单里的 strm 类型（local / …），引擎不读它 */
  strmType?: string;
  /** 整理：库类型先验 + 自动整理策略 */
  organize?: TaskOrganizeSettings;
  /** 复制到 OpenList：这个任务落下新文件时要不要复制走 */
  copyToOpenlist?: TaskCopySettings;
}

/** 任务级「复制到 OpenList」设置 */
export interface TaskCopySettings {
  /** 开着才复制；默认关 */
  enabled?: boolean;
  /** 复制到哪（OpenList 完整路径）；不填用设置页的默认目标目录 */
  dstDir?: string;
  /** 复制成功后把网盘上那份删掉（搬运）。默认关，不可逆 */
  deleteSource?: boolean;
}

/** 列表接口给的是这个：不带 logs。每条记录最多几千行日志，列表里没人看，白传几十 MB */
export type TaskExecutionSummary = Omit<TaskExecutionHistory, "logs">;

/**
 * 单个文件失败的类别（后端 services/download/failure.ts 分类）：决定重不重试、整不整轮停、给用户什么建议。
 *   name-too-long / invalid-name / name-conflict  单个文件，重试没用，要改名（「整理」能做）
 *   no-space / permission / read-only             本地写不进去，整轮停
 *   fs-transient / io-error                       本地临时错误
 *   gone                                          网盘上已经没有这个文件，不用管
 *   auth / blocked                                账号问题，整轮停
 *   network                                       网络抖动，已自动重试
 */
export type FileFailureKind =
  | "name-too-long"
  | "invalid-name"
  | "name-conflict"
  | "no-space"
  | "permission"
  | "read-only"
  | "fs-transient"
  | "io-error"
  | "gone"
  | "auth"
  | "blocked"
  | "network"
  | "unknown";

/** 失败项旁边的按钮：去整理这个目录 / 看账号 / 开设置 */
export type FileFailureAction = { type: "organize"; subPath: string } | { type: "account" } | { type: "settings" };

/** 整轮停：磁盘满、没权限、只读、登录失效、风控这类第一次出现就停；remaining 是没轮到的文件数 */
export interface TaskStopInfo {
  reason: FileFailureKind;
  message: string;
  advice: string;
  remaining: number;
}

/** 一个失败的文件：路径（相对任务目录）、人话说明、处理建议 */
export interface FailedFileBrief {
  file: string;
  message: string;
  advice?: string;
}

export interface TaskExecutionHistory {
  id: string;
  taskId: string;
  startTime: number;
  endTime?: number;
  status: "running" | "completed" | "failed" | "cancelled";
  logs: string[];
  summary: {
    totalFiles: number;
    downloadedFiles: number;
    deletedFiles: number;
    /** 单个文件失败的个数；按类别的摘要在 errorMessage 里 */
    failedFiles?: number;
    errorMessage?: string;
    /** 失败按类别计数（新记录才有） */
    failures?: Partial<Record<FileFailureKind, number>>;
    /** 数量最多那一类的处理建议 */
    advice?: string;
    stopped?: TaskStopInfo;
    /** 最后失败的那几个文件（新记录才有）：看详情不用把整份日志翻一遍 */
    recentFailures?: FailedFileBrief[];
  };
  taskInfo: {
    account: string;
    originPath: string;
    targetPath: string;
    removeExtraFiles: boolean;
  };
}

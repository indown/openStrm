/**
 * 任务进度事件的解析与归并。SSE 推来的和历史里存的都是同一种 JSON 行（见后端 registry.ts 的
 * DownloadProgress），这里把它们统一成 LogEvent，再折进 LogState。旧版本写进历史的几种形状
 * （没有 kind / status / start 事件）也认得，老记录照样能看。
 */

import type { FileFailureAction, FileFailureKind, TaskStopInfo } from "@openstrm/shared";

export type FileKind = "strm" | "download" | "unknown";
export type RunStatus = "running" | "completed" | "failed" | "cancelled";

/** 失败事件里分类相关的字段（新记录才有；老记录只有 error 原文） */
export interface FailureInfo {
  reason?: FileFailureKind;
  message?: string;
  advice?: string;
  action?: FileFailureAction;
  /** false = 写文件前就判定写不进去，没去碰文件系统 */
  attempted?: boolean;
}

export interface FileRow extends FailureInfo {
  path: string;
  kind: FileKind;
  /** 0-100 */
  percent: number;
  error?: string;
}

export type LogEvent =
  /** 启动阶段：正在读取远端目录，文件清单还没出来（只有实时流会发） */
  | { type: "starting"; at: number | null }
  | { type: "start"; total: number; strmTotal: number; downloadTotal: number; at: number | null }
  | { type: "progress"; path: string; kind: FileKind; percent: number; overall: number | null }
  | ({ type: "file-error"; path: string; kind: FileKind; error: string } & FailureInfo)
  | { type: "fatal"; error: string }
  | {
      type: "done";
      status: RunStatus;
      finished: number | null;
      failed: number | null;
      total: number | null;
      overall: number | null;
      message: string | null;
      /** 整轮停的原因（磁盘满 / 没权限 / 登录失效 / 风控） */
      stopped: TaskStopInfo | null;
      at: number | null;
    };

export interface LogState {
  /** 还在启动阶段（读取远端目录）：开始事件一到就结束 */
  starting: boolean;
  total: number | null;
  strmTotal: number | null;
  downloadTotal: number | null;
  /** 按首次出现的顺序；Map 保证插入序 */
  files: Map<string, FileRow>;
  /** 后端算的总进度 0-100；没有就按文件数估 */
  overall: number | null;
  status: RunStatus;
  startedAt: number | null;
  endedAt: number | null;
  /** 任务级错误（不是某个文件） */
  fatalError: string | null;
  /** 结束事件里的说明，比如"3 个文件失败：文件名过长 3" */
  finalMessage: string | null;
  /** 整轮停的原因 */
  stopped: TaskStopInfo | null;
}

export function createLogState(): LogState {
  return {
    starting: false,
    total: null,
    strmTotal: null,
    downloadTotal: null,
    files: new Map(),
    overall: null,
    status: "running",
    startedAt: null,
    endedAt: null,
    fatalError: null,
    finalMessage: null,
    stopped: null,
  };
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const kindOf = (v: unknown): FileKind => (v === "strm" || v === "download" ? v : "unknown");
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const KNOWN_KINDS = new Set<FileFailureKind>(["name-too-long", "invalid-name", "name-conflict", "no-space", "permission", "read-only", "fs-transient", "io-error", "gone", "auth", "blocked", "network", "unknown"]);
/** 不认识的类别（更新的后端）归到 unknown，别让面板出现没标签的组 */
const reasonOf = (v: unknown): FileFailureKind | undefined => (typeof v === "string" && v ? (KNOWN_KINDS.has(v as FileFailureKind) ? (v as FileFailureKind) : "unknown") : undefined);
const actionOf = (v: unknown): FileFailureAction | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const a = v as { type?: unknown; subPath?: unknown };
  if (a.type === "organize") return { type: "organize", subPath: typeof a.subPath === "string" ? a.subPath : "" };
  if (a.type === "account" || a.type === "settings") return { type: a.type };
  return undefined;
};
const stopOf = (v: unknown): TaskStopInfo | null => {
  if (!v || typeof v !== "object") return null;
  const s = v as { reason?: unknown; message?: unknown; advice?: unknown; remaining?: unknown };
  const reason = reasonOf(s.reason);
  if (!reason) return null;
  return { reason, message: str(s.message) ?? "", advice: str(s.advice) ?? "", remaining: num(s.remaining) ?? 0 };
};

/** 一行 JSON（字符串或已解析的对象）→ 事件；认不出的行返回 null */
export function normalizeEvent(raw: unknown): LogEvent | null {
  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (raw && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  } else {
    return null;
  }

  if (obj.starting === true) return { type: "starting", at: num(obj.at) };
  if (obj.start === true) {
    return {
      type: "start",
      total: num(obj.total) ?? 0,
      strmTotal: num(obj.strmTotal) ?? 0,
      downloadTotal: num(obj.downloadTotal) ?? 0,
      at: num(obj.at),
    };
  }
  if (obj.done === true) {
    const status: RunStatus =
      obj.status === "completed" || obj.status === "failed" || obj.status === "cancelled"
        ? obj.status
        : obj.cancelled === true
          ? "cancelled"
          : "completed"; // 旧版的 { done, overallPercent } 只在正常跑完时发
    return {
      type: "done",
      status,
      finished: num(obj.finished),
      failed: num(obj.failed),
      total: num(obj.total),
      overall: num(obj.overallPercent),
      message: typeof obj.message === "string" && obj.message ? obj.message : null,
      stopped: stopOf(obj.stopped),
      at: num(obj.at),
    };
  }
  const path = typeof obj.filePath === "string" ? obj.filePath : "";
  if (typeof obj.error === "string") {
    if (path) {
      return {
        type: "file-error",
        path,
        kind: kindOf(obj.kind),
        error: obj.error,
        reason: reasonOf(obj.reason),
        message: str(obj.message),
        advice: str(obj.advice),
        action: actionOf(obj.action),
        attempted: obj.attempted === false ? false : undefined,
      };
    }
    return { type: "fatal", error: obj.error };
  }
  if (path) {
    return {
      type: "progress",
      path,
      kind: kindOf(obj.kind),
      percent: Math.max(0, Math.min(100, num(obj.percent) ?? 0)),
      overall: num(obj.overallPercent),
    };
  }
  return null;
}

/** 把一批事件折进状态。返回新对象（files 是浅拷贝），旧状态不动 */
export function applyEvents(state: LogState, events: LogEvent[]): LogState {
  if (events.length === 0) return state;
  const next: LogState = { ...state, files: new Map(state.files) };
  for (const ev of events) {
    switch (ev.type) {
      case "starting":
        next.starting = true;
        break;
      case "start":
        next.starting = false;
        next.total = ev.total;
        next.strmTotal = ev.strmTotal;
        next.downloadTotal = ev.downloadTotal;
        if (ev.at != null) next.startedAt = ev.at;
        break;
      case "progress": {
        const prev = next.files.get(ev.path);
        next.files.set(ev.path, {
          path: ev.path,
          kind: ev.kind !== "unknown" ? ev.kind : (prev?.kind ?? "unknown"),
          percent: ev.percent,
          // 重试成功的话把上一次的错误抹掉
          error: undefined,
        });
        if (ev.overall != null) next.overall = ev.overall;
        break;
      }
      case "file-error": {
        const prev = next.files.get(ev.path);
        next.files.set(ev.path, {
          path: ev.path,
          kind: ev.kind !== "unknown" ? ev.kind : (prev?.kind ?? "unknown"),
          percent: prev?.percent ?? 0,
          error: ev.error,
          reason: ev.reason,
          message: ev.message,
          advice: ev.advice,
          action: ev.action,
          attempted: ev.attempted,
        });
        break;
      }
      case "fatal":
        next.fatalError = ev.error;
        break;
      case "done":
        next.starting = false;
        next.status = ev.status;
        next.finalMessage = ev.message;
        next.stopped = ev.stopped;
        if (ev.total != null) next.total = ev.total;
        if (ev.overall != null) next.overall = ev.overall;
        if (ev.at != null) next.endedAt = ev.at;
        break;
    }
  }
  return next;
}

export interface LogCounts {
  total: number | null;
  done: number;
  failed: number;
  active: number;
  /** 还没开始的：总数减去已经出现过的；总数未知时为 null */
  pending: number | null;
  /** 0-100 */
  percent: number;
}

export function countFiles(state: LogState): LogCounts {
  let done = 0;
  let failed = 0;
  let active = 0;
  for (const f of state.files.values()) {
    if (f.error) failed++;
    else if (f.percent >= 100) done++;
    else active++;
  }
  const seen = state.files.size;
  const pending = state.total != null ? Math.max(0, state.total - seen) : null;
  const percent =
    state.overall != null
      ? state.overall
      : state.total
        ? Math.min(100, ((done + failed) / state.total) * 100)
        : 0;
  return { total: state.total, done, failed, active, pending, percent };
}

export interface FailureGroup {
  reason: FileFailureKind;
  /** 这一类的人话说明和建议（取第一条） */
  message: string;
  advice: string;
  action?: FileFailureAction;
  files: FileRow[];
}

/** 失败的文件按类别分组，数量多的在前；老记录没有分类的归 unknown */
export function groupFailures(state: LogState): FailureGroup[] {
  const groups = new Map<FileFailureKind, FailureGroup>();
  for (const f of state.files.values()) {
    if (!f.error) continue;
    const reason = f.reason ?? "unknown";
    const g = groups.get(reason) ?? { reason, message: f.message ?? "", advice: f.advice ?? "", action: f.action, files: [] };
    g.files.push(f);
    if (!g.message && f.message) g.message = f.message;
    if (!g.advice && f.advice) g.advice = f.advice;
    if (!g.action && f.action) g.action = f.action;
    groups.set(reason, g);
  }
  return [...groups.values()].sort((a, b) => b.files.length - a.files.length);
}

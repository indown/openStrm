/**
 * 任务进度事件的解析与归并。SSE 推来的和历史里存的都是同一种 JSON 行（见后端 registry.ts 的
 * DownloadProgress），这里把它们统一成 LogEvent，再折进 LogState。旧版本写进历史的几种形状
 * （没有 kind / status / start 事件）也认得，老记录照样能看。
 */

export type FileKind = "strm" | "download" | "unknown";
export type RunStatus = "running" | "completed" | "failed" | "cancelled";

export interface FileRow {
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
  | { type: "file-error"; path: string; kind: FileKind; error: string }
  | { type: "fatal"; error: string }
  | {
      type: "done";
      status: RunStatus;
      finished: number | null;
      failed: number | null;
      total: number | null;
      overall: number | null;
      message: string | null;
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
  /** 结束事件里的说明，比如"3 个文件失败：a、b、c" */
  finalMessage: string | null;
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
  };
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const kindOf = (v: unknown): FileKind => (v === "strm" || v === "download" ? v : "unknown");

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
      at: num(obj.at),
    };
  }
  const path = typeof obj.filePath === "string" ? obj.filePath : "";
  if (typeof obj.error === "string") {
    if (path) return { type: "file-error", path, kind: kindOf(obj.kind), error: obj.error };
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

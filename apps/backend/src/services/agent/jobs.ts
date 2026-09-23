/**
 * 智能体发起的后台作业（转存后生成 strm 这类可能超过一次工具调用时限的活儿）。
 *
 * 作业不跟请求绑定：客户端断开（新版协议里就是取消请求）只取消那一次等待，活儿照跑，
 * 下次用 job_status 拿结果。这正是现有 SSE 版接口对 agent 不适用的地方——那边连接一断活儿就停。
 * 只在内存里：进程重启就没了，查的时候如实说。
 */
import { randomBytes } from "node:crypto";
import { ToolError, type ToolContext } from "./define.js";
import { fmtTime, toFailure, type ToolFailure } from "./format.js";

export type JobStatus = "running" | "done" | "failed";

export interface JobProgress {
  done?: number;
  total?: number;
  message?: string;
}

export interface Job {
  id: string;
  kind: string;
  /** 去重用：同样的请求算出同一个 key（见 latestJob） */
  key?: string;
  /** 发起方自己记的东西（转存记这次要没要建追更、会不会整理），去重时拿来比 */
  meta?: unknown;
  label: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  progress?: JobProgress;
  result?: unknown;
  error?: ToolFailure;
  /** 结束时 resolve（成功失败都 resolve），等待方只关心「结束了没有」 */
  settled: Promise<void>;
}

export interface JobView {
  jobId: string;
  kind: string;
  label: string;
  status: JobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  progress?: JobProgress;
  result?: unknown;
  failure?: ToolFailure;
}

/** 结束的作业留多久；描述里写明了这个时限 */
export const JOB_RETENTION_MS = 60 * 60 * 1000;
/** 同一类作业最多同时跑几个：模型重试起来很快，别让它把网盘打出风控 */
const MAX_RUNNING_PER_KIND = 2;

const jobs = new Map<string, Job>();

function prune(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== undefined && now - job.finishedAt > JOB_RETENTION_MS) jobs.delete(id);
  }
}

export function startJob(
  kind: string,
  label: string,
  work: (report: (p: JobProgress) => void) => Promise<unknown>,
  opts: { key?: string; meta?: unknown } = {},
): Job {
  prune();
  const running = [...jobs.values()].filter((j) => j.kind === kind && j.status === "running").length;
  if (running >= MAX_RUNNING_PER_KIND) {
    throw new ToolError("BUSY", `同类的后台作业已经有 ${running} 个在跑`, "等它们结束（用 job_status 看）再发起。");
  }
  const job = { id: `job_${randomBytes(6).toString("base64url")}`, kind, key: opts.key, meta: opts.meta, label, status: "running", startedAt: Date.now() } as Job;
  const report = (p: JobProgress) => {
    if (job.status === "running") job.progress = { ...job.progress, ...p };
  };
  // 状态和结束时间一起改：去重按结束时间算窗口，不能有「结束了但还没有结束时间」的一刻
  job.settled = work(report).then(
    (result) => {
      job.result = result;
      job.finishedAt = Date.now();
      job.status = "done";
    },
    (err: unknown) => {
      job.error = toFailure(err);
      job.finishedAt = Date.now();
      job.status = "failed";
    },
  );
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  prune();
  return jobs.get(id);
}

/** 同一类、同一个 key 最近发起的作业（去重用）：还在跑的、刚结束的都算，结束超过保留时限的已经清掉了 */
export function latestJob(kind: string, key: string): Job | undefined {
  prune();
  let hit: Job | undefined;
  for (const job of jobs.values()) {
    if (job.kind === kind && job.key === key && (!hit || job.startedAt >= hit.startedAt)) hit = job;
  }
  return hit;
}

export function viewJob(job: Job): JobView {
  return {
    jobId: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    startedAt: fmtTime(job.startedAt),
    finishedAt: fmtTime(job.finishedAt),
    ...(job.progress ? { progress: job.progress } : {}),
    ...(job.status === "done" ? { result: job.result } : {}),
    ...(job.error ? { failure: job.error } : {}),
  };
}

/** 等作业结束，最多等 ms；客户端断开就不等了（作业照跑） */
export async function waitForJob(job: Job, ms: number, signal?: AbortSignal): Promise<void> {
  if (job.status !== "running" || ms <= 0) return;
  await waitFor(job.settled, ms, signal);
}

/** 等一个 promise，最多 ms 毫秒；signal 触发也提前返回。不抛错 */
export function waitFor(p: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    p.then(done, done);
  });
}

/** 等的时候隔多久取一次进度 */
const PROGRESS_EVERY_MS = 2000;

/** 等待期间推给客户端的一格进度：done 是数到哪了，total 不知道就不给 */
export interface ProgressSnapshot {
  done: number;
  total?: number;
  message?: string;
}

/**
 * 等一个 promise，等的时候顺便推进度（客户端给了 progressToken 才真的发）：客户端能显示进度，
 * 模型那边也看得出没卡死。隔一会儿取一次快照，数字涨了才推——规范要求同一个请求的进度值只增不减，
 * 换阶段时从头数的那几格就不推了
 */
export async function waitWithProgress(
  p: Promise<unknown>,
  ms: number,
  ctx: Pick<ToolContext, "signal" | "progress">,
  snapshot: () => ProgressSnapshot | null,
  everyMs = PROGRESS_EVERY_MS,
): Promise<void> {
  if (ms <= 0) return;
  let last = -1;
  const tick = () => {
    const s = snapshot();
    if (!s || !(s.done > last)) return;
    last = s.done;
    ctx.progress(s.done, s.total, s.message);
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  try {
    await waitFor(p, ms, ctx.signal);
  } finally {
    clearInterval(timer);
  }
}

/** 作业当前的进度，给 waitWithProgress 用 */
export function jobSnapshot(job: Job): ProgressSnapshot | null {
  const p = job.progress;
  if (!p || p.done === undefined) return null;
  return { done: p.done, ...(p.total !== undefined ? { total: p.total } : {}), ...(p.message ? { message: p.message } : {}) };
}

/** 测试用 */
export function __test_resetJobs(): void {
  jobs.clear();
}

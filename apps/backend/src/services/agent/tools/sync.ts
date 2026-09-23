/**
 * 同步工具集：开始 / 取消 / 状态 / 历史。
 *
 * 开始不 await 整个启动：拉 115 的目录树可能要几分钟，远超一次工具调用的时限。
 * 等几秒看有没有当场失败（账号不存在、已在跑……），过了就返回「starting」和下一步，
 * 结果由 sync_status 带 waitSeconds 去等。
 */
import { z } from "zod";
import type { Subscription } from "rxjs";
import type { FailedFileBrief, TaskDefinition, TaskExecutionHistory, TaskExecutionSummary } from "@openstrm/shared";
import { getTask, listTasks } from "../../../db/repositories/tasks.js";
import { moduleLogger } from "../../../lib/logger.js";
import { FILE_FAILURE_LABEL } from "../../download/failure.js";
import type { DownloadProgress } from "../../task/registry.js";
import { cancelRunningTask, getLastStartOutcome, getRunningTask, isTaskRunning, listRunningTaskIds, waitForTaskStart } from "../../task/registry.js";
import { startTask } from "../../task/runner.js";
import { getTaskExecution, getTaskExecutionSummary, queryTaskHistory } from "../../task-history.js";
import { LOCAL_READ, ToolError, defineTool, type ToolContext } from "../define.js";
import { accountHint, fmtTime, openInUi } from "../format.js";
import { waitFor, waitWithProgress } from "../jobs.js";
import { resolveTask, taskBrief } from "../resolve.js";
import { MAX_WAIT_SECONDS, runningState } from "./core.js";

const log = moduleLogger("agent");

/** 发起后等多久看有没有当场失败 */
const START_GRACE_MS = 3000;
/** detail=full 时最多给几条失败文件（runner 也只留最后这么多） */
const FAILED_FILES_LIMIT = 20;

function statusNext(task: TaskDefinition): string {
  return `用 sync_status(task: "${task.id}", waitSeconds: 40) 等结果`;
}

/** 管理界面里看日志的地方：有执行 id 就是那一次的日志，没有就是任务的执行历史 */
function logPath(taskId: string, executionId: string | null | undefined): string {
  if (!executionId) return `/history?${new URLSearchParams({ taskId })}`;
  return `/log?${new URLSearchParams({ taskId, executionId })}`;
}

const UP_TO_DATE = "本地已是最新，没有需要处理的文件";

export const syncStartTool = defineTool({
  name: "sync_start",
  title: "开始同步",
  description:
    "开始一次同步：把任务的网盘目录和本地 strm 目录对齐，缺的生成 strm、下载字幕等附件。会访问网盘接口；任务开了「删除本地多余文件」的话也会删本地多出来的 strm。立刻返回，不等同步做完：拉目录树阶段是 starting，之后用 sync_status 带 waitSeconds 等结果。任务已经在跑就直接返回当前状态，不会重复开跑。",
  scope: "run",
  toolset: "sync",
  annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  input: z.object({
    task: z.string().min(1).max(500).describe("任务 id，或网盘路径 / 本地路径 / 它们的最后一段"),
  }),
  async run(args) {
    const task = resolveTask(args.task);
    const brief = taskBrief(task);
    const live = runningState(task);
    if (live) return { task: brief, ...live, alreadyRunning: true, next: statusNext(task) };

    const pending = startTask(task.id, { trigger: "agent" });
    // 启动阶段后面还会继续跑，失败已经进了执行历史；这里只防 unhandledRejection
    pending.catch((err: unknown) => log.warn({ err, taskId: task.id }, "智能体发起的同步启动失败"));
    const early = await Promise.race([
      pending.then((r) => r, () => null),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), START_GRACE_MS).unref()),
    ]);

    if (early === undefined) {
      return {
        task: brief,
        state: "starting",
        message: "正在拉网盘目录树，大库可能要几分钟",
        next: statusNext(task),
        ...openInUi(logPath(task.id, null)),
      };
    }
    if (early === null) {
      // 启动过程抛了意外错误：执行历史里有记录
      return { task: brief, state: "failed", ...latestFinished(task) };
    }
    const body = early.body as Record<string, unknown>;
    if (early.status === 200) {
      const executionId = typeof body.executionId === "string" ? body.executionId : null;
      // 无事可做也可能带提醒：远端目录是空的、跳过了清理本地多余文件——多半是目录导出出了问题，要告诉用户
      const warning = typeof body.warning === "string" && body.warning ? { warning: body.warning } : {};
      if (!executionId) return { task: brief, state: "up_to_date", message: UP_TO_DATE, ...warning };
      return {
        task: brief,
        state: "running",
        executionId,
        ...(typeof body.total === "number" ? { total: body.total } : {}),
        ...warning,
        next: statusNext(task),
        ...openInUi(logPath(task.id, executionId)),
      };
    }
    if (early.status === 409) {
      const again = runningState(task);
      return { task: brief, ...(again ?? { state: "starting" }), alreadyRunning: true, next: statusNext(task) };
    }
    const message = String(body.message ?? "启动失败");
    const details = typeof body.details === "string" && body.details ? `：${body.details}` : "";
    throw new ToolError("START_FAILED", `${message}${details}`, accountHint(body.issue), { task: brief });
  },
});

export const syncCancelTool = defineTool({
  name: "sync_cancel",
  title: "取消同步",
  description: "取消正在跑的同步。已经生成的 strm 保留。还在拉目录树（starting）的阶段取消不了，等它起跑再取消。没在跑就直接说没在跑。",
  scope: "run",
  toolset: "sync",
  annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
  input: z.object({
    task: z.string().min(1).max(500).describe("任务 id，或网盘路径 / 本地路径 / 它们的最后一段"),
  }),
  async run(args) {
    const task = resolveTask(args.task);
    const brief = taskBrief(task);
    const live = runningState(task);
    if (!live) return { task: brief, state: "idle", message: "没有在跑" };
    if (live.state === "starting") {
      return { task: brief, state: "starting", message: "还在拉目录树，这一阶段取消不了；起跑后再取消", next: statusNext(task) };
    }
    const ok = cancelRunningTask(task.id, "智能体取消");
    return { task: brief, state: ok ? "cancelled" : "idle", message: ok ? "已取消" : "没有在跑" };
  },
});

/** 最近一次（或指定的）执行记录 → 给模型看的结果 */
function finishedView(e: TaskExecutionSummary | TaskExecutionHistory) {
  const s = e.summary;
  const failures = Object.entries(s.failures ?? {}).map(([kind, count]) => ({
    kind,
    label: FILE_FAILURE_LABEL[kind as keyof typeof FILE_FAILURE_LABEL] ?? kind,
    count,
  }));
  return {
    executionId: e.id,
    status: e.status,
    startedAt: fmtTime(e.startTime),
    finishedAt: fmtTime(e.endTime),
    total: s.totalFiles,
    done: s.downloadedFiles,
    failed: s.failedFiles ?? 0,
    deletedLocal: s.deletedFiles,
    ...(s.errorMessage ? { error: s.errorMessage } : {}),
    ...(s.advice ? { advice: s.advice } : {}),
    ...(failures.length ? { failures } : {}),
    ...(s.stopped ? { stopped: { reason: s.stopped.reason, message: s.stopped.message, advice: s.stopped.advice, remaining: s.stopped.remaining } } : {}),
  };
}

function latestExecution(taskId: string): TaskExecutionSummary | undefined {
  return queryTaskHistory({ taskId, limit: 1 }).rows[0];
}

function latestFinished(task: TaskDefinition) {
  const last = latestExecution(task.id);
  return last ? finishedView(last) : { message: "还没有执行记录" };
}

/** 失败的文件：新记录的摘要里直接有；老记录才从进度日志里挑（要把整份日志读出来） */
function failedFilesOf(record: TaskExecutionSummary): FailedFileBrief[] {
  if (record.summary.recentFailures) return record.summary.recentFailures;
  if (!record.summary.failedFiles) return [];
  return failedFilesFromLogs(getTaskExecution(record.id)?.logs ?? []);
}

function failedFilesFromLogs(lines: string[]): FailedFileBrief[] {
  const out: FailedFileBrief[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < FAILED_FILES_LIMIT; i--) {
    let p: DownloadProgress;
    try {
      p = JSON.parse(lines[i]) as DownloadProgress;
    } catch {
      continue;
    }
    if (p.filePath && p.error) out.push({ file: p.filePath, message: p.message || p.error, ...(p.advice ? { advice: p.advice } : {}) });
  }
  return out.reverse();
}

/** 等这个任务跑完，最多 ms；starting 阶段先等它起跑。跑起来之后按已完成的文件数推进度 */
async function waitUntilDone(taskId: string, ms: number, ctx: Pick<ToolContext, "signal" | "progress">): Promise<void> {
  const { signal } = ctx;
  const deadline = Date.now() + ms;
  if (!getRunningTask(taskId) && isTaskRunning(taskId)) {
    await waitFor(waitForTaskStart(taskId, signal), ms, signal);
  }
  const run = getRunningTask(taskId);
  const left = deadline - Date.now();
  if (!run || left <= 0 || signal.aborted) return;
  let sub: Subscription | undefined;
  const done = new Promise<void>((resolve) => {
    sub = run.subject.subscribe({ complete: () => resolve(), error: () => resolve() });
  });
  try {
    await waitWithProgress(done, left, ctx, () => {
      const s = run.stats?.();
      return s ? { done: s.finished, total: s.total, message: `已处理 ${s.finished}/${s.total}${s.failed ? `，失败 ${s.failed}` : ""}` } : null;
    });
  } finally {
    sub?.unsubscribe();
  }
}

export const syncStatusTool = defineTool({
  name: "sync_status",
  title: "同步状态",
  description: `查一次同步的状态：按任务查当前或最近一次，或者按 executionId 查指定的一次。返回进度、失败按原因分组的数量和处理建议。waitSeconds 大于 0 时会等同步做完再返回，最多等这么久（上限 ${MAX_WAIT_SECONDS} 秒），等不到就返回当前进度，可以再调一次接着等，不要连续快速轮询。detail 填 full 会再列出失败的文件（最多 ${FAILED_FILES_LIMIT} 个）。`,
  scope: "read",
  toolset: "sync",
  annotations: LOCAL_READ,
  input: z.object({
    task: z.string().max(500).optional().describe("任务 id，或网盘路径 / 本地路径 / 它们的最后一段；和 executionId 至少给一个"),
    executionId: z.string().max(100).optional().describe("sync_start 或 sync_history 给的 executionId"),
    waitSeconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe(`最多等几秒，0 到 ${MAX_WAIT_SECONDS}，不填就是 0（立刻返回）`),
    detail: z.enum(["brief", "full"]).optional().describe("brief（默认）只给计数和建议；full 再列出失败的文件"),
  }),
  async run(args, ctx) {
    const executionId = args.executionId?.trim() || "";
    let task: TaskDefinition | undefined;
    // 执行记录只取摘要（不带日志）：日志是每条几千行的 JSON，看状态用不着
    let record: TaskExecutionSummary | undefined;
    if (executionId) {
      const runningId = listRunningTaskIds().find((id) => getRunningTask(id)?.executionId === executionId);
      if (!runningId) record = getTaskExecutionSummary(executionId);
      const taskId = runningId ?? record?.taskId;
      if (!taskId) throw new ToolError("EXECUTION_NOT_FOUND", `找不到执行记录 ${executionId}`, "用 sync_history 看最近的执行记录。");
      task = getTask(taskId) ?? undefined;
      if (!task) throw new ToolError("TASK_NOT_FOUND", `这次执行所属的任务 ${taskId} 已经删了`);
    } else if (args.task?.trim()) {
      task = resolveTask(args.task);
    } else {
      throw new ToolError("VALIDATION", "task 和 executionId 至少给一个", "用 tasks_list 看有哪些任务。");
    }

    const wait = (args.waitSeconds ?? 0) * 1000;
    const run = getRunningTask(task.id);
    const watchingThisRun = !executionId || run?.executionId === executionId || (!run && isTaskRunning(task.id));
    if (wait > 0 && watchingThisRun && isTaskRunning(task.id)) {
      await waitUntilDone(task.id, wait, ctx);
      // 等的这段时间里跑完了：记录的状态变了，重新取
      record = undefined;
    }

    const brief = taskBrief(task);
    const full = args.detail === "full";
    const nowRun = getRunningTask(task.id);
    if (nowRun && (!executionId || nowRun.executionId === executionId)) {
      const live = runningState(task)!;
      return {
        task: brief,
        ...live,
        ...(full ? { failedFiles: [...(nowRun.recentFailures ?? [])] } : {}),
        next: statusNext(task),
        ...openInUi(logPath(task.id, nowRun.executionId)),
      };
    }
    if (!executionId && isTaskRunning(task.id)) {
      return { task: brief, state: "starting", message: "正在拉网盘目录树", next: statusNext(task) };
    }

    record ??= executionId ? getTaskExecutionSummary(executionId) : latestExecution(task.id);
    // 最近一次启动是「无事可做」：那次不进执行历史，不能把更早的那条当成这次的结果
    const lastStart = executionId ? undefined : getLastStartOutcome(task.id);
    if (lastStart?.idle && (!record || lastStart.at >= record.startTime)) {
      return {
        task: brief,
        state: "up_to_date",
        message: `最近一次同步（${fmtTime(lastStart.at)}）${UP_TO_DATE}`,
        ...(lastStart.warning ? { warning: lastStart.warning } : {}),
        ...openInUi(logPath(task.id, null)),
      };
    }
    if (!record) return { task: brief, state: "idle", message: "还没有执行记录" };
    return {
      task: brief,
      state: record.status,
      ...finishedView(record),
      ...(full ? { failedFiles: failedFilesOf(record) } : {}),
      ...openInUi(logPath(task.id, record.id)),
    };
  },
});

const HISTORY_LIMIT_DEFAULT = 20;
const HISTORY_LIMIT_MAX = 50;

export const syncHistoryTool = defineTool({
  name: "sync_history",
  title: "同步记录",
  description: `最近的同步执行记录（不带日志），新的在前。可以按任务、状态过滤；默认 ${HISTORY_LIMIT_DEFAULT} 条，最多 ${HISTORY_LIMIT_MAX} 条。要看某一次的详情用 sync_status(executionId)。`,
  scope: "read",
  toolset: "sync",
  annotations: LOCAL_READ,
  input: z.object({
    task: z.string().max(500).optional().describe("只看这个任务：任务 id，或网盘路径 / 本地路径 / 它们的最后一段"),
    status: z.enum(["running", "completed", "failed", "cancelled"]).optional().describe("只看这个状态"),
    limit: z.number().int().min(1).max(HISTORY_LIMIT_MAX).optional().describe(`最多几条，默认 ${HISTORY_LIMIT_DEFAULT}，上限 ${HISTORY_LIMIT_MAX}`),
  }),
  async run(args) {
    const tasks = new Map(listTasks().map((t) => [t.id, t]));
    const task = args.task?.trim() ? resolveTask(args.task) : undefined;
    const limit = args.limit ?? HISTORY_LIMIT_DEFAULT;
    const { rows, total } = queryTaskHistory({ taskId: task?.id, status: args.status, limit });
    return {
      executions: rows.map((e) => {
        const t = tasks.get(e.taskId);
        const v = finishedView(e);
        return { task: t ? taskBrief(t).label : "（已删除的任务）", taskId: e.taskId, ...v };
      }),
      total,
      ...(total > limit ? { truncated: `只列了最近 ${limit} 条，可以按 task / status 过滤` } : {}),
    };
  },
});

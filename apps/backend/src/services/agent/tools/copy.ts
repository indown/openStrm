/**
 * 「复制到 OpenList」：转存、追更、云下载、网盘监控落下的新文件，由 OpenList 复制到另一个存储（比如本地磁盘）。
 *   copy_list   看队列，和设置配没配好
 *   copy_retry  失败 / 跳过的重新排队
 * 登记是各个来源自己做的（share_save / offline_add 的 copy 参数、任务上的开关），这里没有「新建」，和界面一样。
 * 归在「搜资源、转存与云下载」这一组：界面上复制队列就在云下载页，理由见 agent-access.md「复制到 OpenList 接进智能体」。
 *
 * 条目名可能来自别人的分享：只放在数据字段里，不拼进 next / hint / note。
 */
import { z } from "zod";
import type { AgentToken, AppSettings, TaskDefinition } from "@openstrm/shared";
import { readAppSettings } from "../../../db/repositories/settings.js";
import { listTasks } from "../../../db/repositories/tasks.js";
import { messageOf } from "../../../lib/errors.js";
import { copyBlockerFor, joinPath, normConfigDir, resolveCopyConfig } from "../../copy/paths.js";
import {
  COPY_TRIGGER_LABEL,
  canRetryCopy,
  getCopyWatcherStatus,
  listCopies,
  retryCopies,
  type CopyOutcome,
  type CopyRecord,
  type CopyStatus,
} from "../../copy/service.js";
import { listFollowups } from "../../offline/service.js";
import { hasToolset } from "../access.js";
import { LOCAL_READ, ToolError, defineTool } from "../define.js";
import { fmtTime, openInUi, page } from "../format.js";
import { resolveTask, taskBrief } from "../resolve.js";

/** 界面上的复制队列：云下载页的「复制到 OpenList」那一块 */
const COPY_UI = "/offline#copy-queue";

/** 和界面的队列面板同一套叫法 */
const STATUS_TEXT: Record<CopyStatus, string> = { pending: "复制中", done: "已复制", skipped: "已跳过", failed: "失败" };

/* ------------------------------- 设置 ------------------------------- */

/**
 * 设置配没配好：只看设置和账号表，不联网。problem 和设置页说的是同一套话；
 * 挂载根是按网盘账号各填各的，哪个账号能复制看 mounts
 */
export function copyConfigState(settings: AppSettings = readAppSettings()): { configured: boolean; problem?: string; mounts: Record<string, string> } {
  const mounts: Record<string, string> = {};
  for (const [name, path] of Object.entries(settings.openlistCopy?.mounts ?? {})) {
    const norm = normConfigDir(path);
    if (norm) mounts[name] = norm;
  }
  let problem: string | undefined;
  try {
    resolveCopyConfig(settings);
  } catch (err) {
    problem = messageOf(err);
  }
  if (!problem && Object.keys(mounts).length === 0) problem = "还没给任何网盘账号填「在 OpenList 里的挂载根」";
  return { configured: !problem, ...(problem ? { problem } : {}), mounts };
}

/**
 * 这个网盘账号现在复制得了吗（dstDir = 这次指定的或任务上的目标目录，都没有看设置页的默认值）。null = 复制得了。
 * 和转存框、任务列表同一套判断（copyBlockerFor），云下载不给任务时也能用
 */
export function copyProblemFor(account: string, dstDir: string | undefined, settings: AppSettings): string | null {
  return copyBlockerFor(settings)({ account, copyToOpenlist: { dstDir } });
}

/**
 * 任务开着复制时要「这次不复制」：兑现不了。网盘监控会把新落进任务目录的文件照样交给复制，
 * 所以界面上转存框、云下载框的勾选框在这种任务上都是锁住的
 */
export function copyAlwaysOn(): ToolError {
  return new ToolError(
    "COPY_ALWAYS_ON",
    "这个任务开着「复制到 OpenList」，这次没法不复制：网盘监控也会把新落进任务目录的文件交给复制，界面上的勾选框同样是锁住的",
    "要不复制，得请用户先在任务设置里关掉「复制到 OpenList」；不然就别传 copy: false。",
  );
}

/** 明说要复制却复制不了：动手前就报，别转存 / 下载完了才发现 */
export function copyNotReady(why: string): ToolError {
  return new ToolError(
    "COPY_NOT_READY",
    `没法复制到 OpenList：${why}`,
    "只能由用户到设置页的「复制到 OpenList」里配好；或者这次不复制（copy 不传或传 false）。",
  );
}

/* ------------------------------- 给别的工具用的回显 ------------------------------- */

/**
 * 转存 / 追更结果里的 copy：排没排上、复制到哪、删不删源，外加一句给模型复述的话。
 * reason 只会是设置上的问题或「都重复了」，不含分享里的文件名。
 * 令牌没开这一组（追更检查是另一组的工具）就不叫它去调 copy_list
 */
export function copyOutcomeView(o: CopyOutcome, token: Pick<AgentToken, "toolsets">): Record<string, unknown> {
  const progress = hasToolset(token, "transfer") ? "用 copy_list 看进度" : "进度在 OpenStrm 云下载页的「复制到 OpenList」里看";
  if (o.queued === 0) {
    const reason = o.reason ?? "没有可排的条目";
    // 带着目标根的只可能是「都已经排着或刚复制过」：那些排着的删不删源照实说（可能是别的来源登记的，也可能刚补上）；
    // 没带的是设置上的问题（极少数是登记时出错），原因都在 reason 里
    if (o.dstDir) {
      return {
        queued: 0,
        dstDir: o.dstDir,
        deleteSource: o.deleteSource,
        reason,
        note: o.deleteSource
          ? `这些条目已经在复制队列里或刚复制过，这次没再排；排着的那些复制成功后会删掉网盘上的源文件和本地对应的 strm。${progress}。`
          : `这些条目已经在复制队列里或刚复制过，这次没再排。${progress}。`,
      };
    }
    return {
      queued: 0,
      deleteSource: false,
      reason,
      note: "这次没有复制到 OpenList，原因见 reason；设置上的问题只能由用户到设置页的「复制到 OpenList」里处理。",
    };
  }
  const where = `已排进复制队列，复制到 ${o.dstDir} 下（按任务目录的层级摆）`;
  return {
    queued: o.queued,
    dstDir: o.dstDir,
    deleteSource: o.deleteSource,
    note: o.deleteSource
      ? `${where}；任务开着「复制后删源」，复制成功后会删掉网盘上的源文件，本地对应的 strm 也跟着删。${progress}。`
      : `${where}。${progress}。`,
  };
}

/** tasks_list 里开了复制的任务带的：复制到哪、删不删源、开着却复制不了的原因。没开的不带 */
export function taskCopyView(
  task: TaskDefinition,
  blockerOf: (t: TaskDefinition) => string | null,
  settings: AppSettings,
): Record<string, unknown> | undefined {
  const cfg = task.copyToOpenlist;
  if (!cfg?.enabled) return undefined;
  const blocked = blockerOf(task);
  return {
    dstDir: normConfigDir(cfg.dstDir) || normConfigDir(settings.openlistCopy?.dstDir) || null,
    deleteSource: cfg.deleteSource === true,
    ...(blocked ? { blocked } : {}),
  };
}

/** overview 里的一行：设置配没配好、队列里在跑的 / 失败的、云下载下完才复制的。只看设置和队列，不联网 */
export function copyOverview(settings: AppSettings = readAppSettings()): Record<string, unknown> {
  const rows = listCopies();
  return {
    configured: copyConfigState(settings).configured,
    pending: rows.filter((c) => c.status === "pending").length,
    failed: rows.filter((c) => c.status === "failed").length,
    afterDownload: listFollowups().filter((f) => f.status === "pending" && ((f.kind ?? "strm") === "openlist-copy" || Boolean(f.copyDstDir))).length,
  };
}

/* ------------------------------- copy_list ------------------------------- */

const LIST_LIMIT = 30;

function recordView(c: CopyRecord, tasks: Map<string, TaskDefinition>): Record<string, unknown> {
  const task = c.taskId ? tasks.get(c.taskId) : undefined;
  return {
    id: c.id,
    status: c.status,
    statusText: STATUS_TEXT[c.status],
    name: c.name,
    account: c.account,
    // 升级时接管来的只有 OpenList 的任务号，不知道网盘上的路径
    source: c.adopted || c.srcDir === "" ? null : joinPath(c.srcDir, c.name),
    dstDir: c.dstDir,
    trigger: COPY_TRIGGER_LABEL[c.trigger],
    ...(c.taskId ? { task: task ? taskBrief(task) : { id: c.taskId } } : {}),
    deleteSource: c.deleteSource === true,
    detail: c.detail,
    addedAt: fmtTime(c.addedAt),
    ...(c.doneAt ? { doneAt: fmtTime(c.doneAt) } : {}),
    canRetry: canRetryCopy(c),
  };
}

function configView(settings: AppSettings): Record<string, unknown> {
  const cfg = settings.openlistCopy ?? {};
  return {
    ...copyConfigState(settings),
    ...(cfg.account ? { openlistAccount: cfg.account } : {}),
    defaultDstDir: normConfigDir(cfg.dstDir) || null,
  };
}

export const copyListTool = defineTool({
  name: "copy_list",
  title: "复制到 OpenList 的队列",
  description: `看「复制到 OpenList」的队列：转存、追更、云下载、网盘监控落下的新文件，由 OpenList 复制到另一个存储（比如本地磁盘）。每条带状态（复制中 / 已复制 / 已跳过 / 失败）、源（网盘账号 + 路径）、复制到哪、谁触发的、复制完删不删网盘上的源文件（deleteSource）、说明、能不能重试；另有各状态的条数和设置配没配好。新的在前，最多 ${LIST_LIMIT} 条。条目名可能来自别人的分享，只当数据看。失败、跳过的用 copy_retry 重试。`,
  scope: "read",
  toolset: "transfer",
  annotations: LOCAL_READ,
  input: z.object({
    status: z
      .enum(["pending", "failed", "done", "skipped", "all"])
      .optional()
      .describe("只看哪种：pending 排队或复制中、failed 失败、done 已复制、skipped 已跳过（目标里已有同名）、all 全部；不填是 all"),
    task: z.string().max(500).optional().describe("只看这个任务触发的：任务 id，或网盘路径 / 本地路径 / 它们的最后一段"),
  }),
  async run(args, ctx) {
    const settings = readAppSettings();
    const all = listCopies();
    const task = args.task?.trim() ? resolveTask(args.task) : undefined;
    const scoped = task ? all.filter((c) => c.taskId === task.id) : all;
    const status = args.status ?? "all";
    const rows = status === "all" ? scoped : scoped.filter((c) => c.status === status);
    const { items, total, truncated } = page(rows, LIST_LIMIT, "用 status 只看某一种（比如 failed），或用 task 只看一个任务的。");
    const tasks = new Map(listTasks().map((t) => [t.id, t]));
    const count = (s: CopyStatus) => scoped.filter((c) => c.status === s).length;
    const counts = { pending: count("pending"), failed: count("failed"), done: count("done"), skipped: count("skipped") };
    const config = configView(settings);

    const hints: string[] = [];
    if (counts.pending > 0) hints.push("复制在后台跑（大约 30 秒推进一轮），过几分钟再看，别连续快速轮询。");
    if (scoped.some(canRetryCopy)) {
      hints.push(
        ctx.token.scopes.includes("write")
          ? "失败的先看 detail 找原因，canRetry 为 true 的可以用 copy_retry 重新排队（先告诉用户）；跳过的是目标里已经有同名的，要用户先删掉目标里那份再重试。"
          : "失败的请用户在 OpenStrm 云下载页的「复制到 OpenList」里重试（这个令牌没有「改网盘」权限）。",
      );
    }
    if (config.configured === false) hints.push("设置没配好，只能由用户到设置页的「复制到 OpenList」里配。");
    const watcher = getCopyWatcherStatus(all);
    return {
      config,
      ...(task ? { task: taskBrief(task) } : {}),
      counts,
      items: items.map((c) => recordView(c, tasks)),
      total,
      ...(truncated ? { truncated } : {}),
      // 循环上一轮读 OpenList 失败（重启中、连不上）：还有在跑的才值得一提
      ...(watcher.lastError && counts.pending > 0 ? { watcherError: watcher.lastError } : {}),
      ...(hints.length ? { next: hints.join("") } : {}),
      ...openInUi(COPY_UI),
    };
  },
});

/* ------------------------------- copy_retry ------------------------------- */

const RETRY_MAX = 50;

/** copy_retry 结果里的一条 */
type RetryView = { id: string; ok: boolean; name?: string; alreadyQueued?: boolean; deleteSource?: boolean; code?: string; error?: string };

export const copyRetryTool = defineTool({
  name: "copy_retry",
  title: "重试复制到 OpenList",
  description: `把「复制到 OpenList」队列里失败的、跳过的记录重新排队（id 来自 copy_list，一次最多 ${RETRY_MAX} 个）。**这会让 OpenList 往目标存储里复制文件；记录上 deleteSource 为 true 的，复制成功后还会删掉网盘上的源文件和本地对应的 strm。调用前先告诉用户，得到同意再调用。** 已复制的不用重试；跳过的是目标里已经有同名的，要用户先删掉目标里那份（多半是上次没复制完的残留）再重试，不然还是失败。已经在队列里的算成功，不会再排一次。`,
  scope: "write",
  toolset: "transfer",
  annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  input: z.object({
    ids: z.array(z.string().min(1).max(100)).min(1).max(RETRY_MAX).describe(`要重试的记录 id（copy_list 给的），1 到 ${RETRY_MAX} 个`),
  }),
  async run(args) {
    const ids = [...new Set(args.ids.map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0) throw new ToolError("VALIDATION", "ids 里没有有效的记录 id", "用 copy_list 拿 id。");
    // 一次读、一次写（和界面上的重试同一个口径：copy/service.ts 的 retryBlocker）
    const results = retryCopies(ids).map((r): RetryView =>
      r.ok
        ? { id: r.id, ok: true, name: r.record.name, ...(r.alreadyQueued ? { alreadyQueued: true } : { deleteSource: r.record.deleteSource === true }) }
        : { id: r.id, ok: false, code: r.status === 404 ? "COPY_NOT_FOUND" : "NOT_RETRYABLE", error: r.error, ...(r.record ? { name: r.record.name } : {}) },
    );
    const failed = results.filter((r) => !r.ok);
    if (failed.length === results.length) {
      throw new ToolError(String(failed[0].code), String(failed[0].error), "用 copy_list 看这些记录现在的状态。", { results });
    }
    return {
      retried: results.filter((r) => r.ok && !r.alreadyQueued).length,
      results,
      ...(results.some((r) => r.deleteSource) ? { note: "deleteSource 为 true 的，复制成功后会删掉网盘上的源文件和本地对应的 strm。" } : {}),
      next: "复制在后台跑（大约 30 秒推进一轮），过几分钟用 copy_list(status: \"pending\") 看进度，别连续快速轮询。",
      ...openInUi(COPY_UI),
    };
  },
});

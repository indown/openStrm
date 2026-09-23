/**
 * strm 管理工具集：按文件名找、体检、到网盘核对、修正 / 补齐、按网盘重建、删除。和界面上的「strm 管理」页同一套规则
 * （services/strm/manage.ts）。路径一律相对任务的本地 strm 目录，"" 是根。
 *
 * 体检、核对、补齐、重建都可能要一两分钟（大库要读上万个 strm、要列网盘目录）：先等一会儿，做不完转成作业，
 * 用 job_status 等。作业不跟请求绑定——SSE 版的核对是连接一断就停，agent 用不了。
 */
import { z } from "zod";
import type { StrmIssueType, StrmParseReason, TaskDefinition } from "@openstrm/shared";
import { providerForTask } from "../../drive/registry.js";
import { STRM_LIMITS, countUnder, deletePaths, normalizeRel, readStrm, regenerate, rewrite, scan, search, verify } from "../../strm/manage.js";
import { LOCAL_READ, REMOTE_READ, ToolError, confirmFirst, defineTool, type ToolContext } from "../define.js";
import { openInUi } from "../format.js";
import { JOB_RETENTION_MS, jobSnapshot, startJob, viewJob, waitWithProgress, type Job } from "../jobs.js";
import { resolveTask, taskBrief } from "../resolve.js";
import { MAX_WAIT_SECONDS } from "./core.js";

const taskArg = z.string().min(1).max(500).describe("任务 id，或网盘路径 / 本地路径 / 它们的最后一段");
const pathArg = z.string().max(4096).optional().describe("相对任务本地 strm 目录的路径，用 / 分隔；不填是整个任务");

const uiPath = (task: TaskDefinition, rel = "") => `/strm?${new URLSearchParams({ taskId: task.id, ...(rel ? { path: rel } : {}) })}`;

/** 体检问题的叫法和下一步（和 strm 管理页同一套说法，前端 lib/strm.ts 的 ISSUE_META） */
const ISSUE_TEXT: Record<StrmIssueType, { label: string; hint: string }> = {
  "nested-same-name": { label: "同名嵌套", hint: "目录里套了一个同名子目录，多半是重复生成的一层：确认后用 strm_delete 删掉里层" },
  "empty-dir": { label: "空目录", hint: "整棵目录里一个文件都没有：可以用 strm_delete 删掉" },
  "stale-content": { label: "内容过期", hint: "strm 内容和任务现在的前缀 / 网盘路径 / 编码设置对不上：用 strm_fix 重写（先 dryRun 看样例）" },
  unparsable: { label: "无法解析", hint: "看不出这个 strm 指向哪个文件：用 strm_fix(mode: fill) 或 strm_rebuild 按网盘目录重建" },
  "duplicate-episode": { label: "疑似重复剧集", hint: "同一集有多个 strm，播放器里会显示成多条；也可能只是不同画质的版本，先问用户" },
  "leftover-part": { label: "残留分段", hint: "下载中断留下的 .part 文件：可以用 strm_delete 删掉" },
  "nonstandard-name": { label: "命名不规范", hint: "文件名带发布组 / 画质 / 编码这类噪音：可以用 organize_preview 整理成标准命名" },
};

const REASON_TEXT: Record<StrmParseReason, string> = {
  empty: "文件是空的",
  "no-ext": "内容里没有文件扩展名",
  "name-mismatch": "内容里的文件名和本地文件名对不上",
  "prefix-mismatch": "前缀和任务现在的设置对不上",
};

/** 路径和 strm 管理页同一套规则：每段原样保留（目录名前后带空格是合法的），只去掉空段和 . ，拒绝 .. */
const normRel = (p: string | undefined): string => normalizeRel(p ?? "");

/** strm 内容里 URL 带的账号密码（http://用户:密码@…）不给模型 */
const hideUrlCredentials = (content: string): string => content.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1***@");

/** 作业等多久：做完就直接给结果，做不完给 jobId */
const INLINE_WAIT_MS = 40_000;

/** 先等一会儿，做不完转成作业：和 share_save 同一个形状 */
async function runAsJob(ctx: ToolContext, kind: string, label: string, work: (report: (p: { done?: number; total?: number; message?: string }) => void) => Promise<unknown>) {
  const job: Job = startJob(kind, label, work);
  await waitWithProgress(job.settled, INLINE_WAIT_MS, ctx, () => jobSnapshot(job));
  const view = viewJob(job);
  if (view.status === "running") {
    return { state: "running", jobId: job.id, message: "还在做，范围大时要一两分钟", next: `用 job_status(jobId: "${job.id}", waitSeconds: ${MAX_WAIT_SECONDS}) 等结果（结果保留 ${JOB_RETENTION_MS / 60000} 分钟）` };
  }
  if (view.status === "failed") {
    const { error, code, hint, ...extra } = view.failure ?? { error: "失败", code: "FAILED" };
    throw new ToolError(code, error, hint ?? (code === "HTTP_409" ? "任务正在同步、或者有别的 strm 操作在进行：等它做完再来。" : undefined), { ...extra, jobId: job.id });
  }
  return { state: "done", jobId: job.id, ...(view.result as object) };
}

/* ------------------------------- 看 ------------------------------- */

const SEARCH_DEFAULT = 20;
const SEARCH_MAX = 50;
/** 前几个 strm 顺带给内容和解析出的网盘路径 */
const SEARCH_READ = 10;

export const strmSearchTool = defineTool({
  name: "strm_search",
  title: "找 strm",
  description: `在一个任务的本地 strm 目录里按文件名找（包含即可，不分大小写）。前 ${SEARCH_READ} 个 strm 顺带给出内容、按任务现在的设置应有的网盘路径、内容对不对得上。默认 ${SEARCH_DEFAULT} 条，最多 ${SEARCH_MAX} 条。`,
  scope: "read",
  toolset: "strm",
  annotations: LOCAL_READ,
  input: z.object({
    task: taskArg,
    query: z.string().min(1).max(200).describe("文件名里的一段"),
    limit: z.number().int().min(1).max(SEARCH_MAX).optional().describe(`最多几条，1 到 ${SEARCH_MAX}，默认 ${SEARCH_DEFAULT}`),
  }),
  async run(args) {
    const task = resolveTask(args.task);
    const r = await search(task, args.query, args.limit ?? SEARCH_DEFAULT);
    let read = 0;
    const hits = [];
    for (const h of r.hits) {
      const base = { path: h.path, kind: h.kind, ...(h.isDir ? { isDir: true } : {}) };
      if (h.kind !== "strm" || read >= SEARCH_READ) {
        hits.push(base);
        continue;
      }
      read++;
      try {
        const info = await readStrm(task, h.path);
        hits.push({
          ...base,
          content: hideUrlCredentials(info.content),
          remotePath: info.actualRemotePath ?? info.expectedRemotePath,
          matches: info.matches,
          ...(info.reason ? { problem: REASON_TEXT[info.reason] } : {}),
        });
      } catch {
        hits.push(base);
      }
    }
    return {
      task: taskBrief(task),
      hits,
      ...(r.truncated ? { truncated: "命中的太多，只给了前面一部分：换个更具体的词。" } : {}),
      ...(hits.length === 0 ? { message: "没找到。strm 的文件名跟着网盘文件名走，可以换一段试试，或者用 drive_browse 看网盘上叫什么。" } : {}),
      ...openInUi(uiPath(task)),
    };
  },
});

const ISSUES_LIST = 30;

export const strmCheckTool = defineTool({
  name: "strm_check",
  title: "strm 体检",
  description: `体检一个任务（或它的一个子目录）的本地 strm，只读本地、不访问网盘：同名嵌套、空目录、内容过期、无法解析、疑似重复剧集、残留分段、命名不规范。每类给数量、最多 ${ISSUES_LIST} 条例子和下一步建议。大库要读上万个 strm，${INLINE_WAIT_MS / 1000} 秒内做不完就转成作业，用 job_status 等。`,
  scope: "read",
  toolset: "strm",
  annotations: LOCAL_READ,
  input: z.object({ task: taskArg, path: pathArg }),
  async run(args, ctx) {
    const task = resolveTask(args.task);
    const rel = normRel(args.path);
    return runAsJob(ctx, "strm_check", `体检 ${taskBrief(task).label}${rel ? `/${rel}` : ""}`, async (report) => {
      report({ message: "读本地 strm" });
      const r = await scan(task, rel);
      const types = (Object.keys(r.counts) as StrmIssueType[]).filter((t) => r.counts[t] > 0);
      return {
        task: taskBrief(task),
        path: rel || "（整个任务）",
        files: r.files,
        strm: r.strm,
        dirs: r.dirs,
        ...(r.truncated ? { truncated: "条目太多，只查了一部分：换一个更小的目录。" } : {}),
        ...(r.skippedRoots.length ? { skippedRoots: r.skippedRoots } : {}),
        problems: types.map((t) => ({ type: t, label: ISSUE_TEXT[t].label, count: r.counts[t], hint: ISSUE_TEXT[t].hint })),
        examples: r.issues.slice(0, ISSUES_LIST).map((i) => ({ type: i.type, path: i.path, ...(i.detail ? { detail: i.detail } : {}), ...(i.related?.length ? { related: i.related.slice(0, 3) } : {}) })),
        ...(types.length === 0 ? { message: "没发现问题。" } : {}),
        ...openInUi(uiPath(task, rel)),
      };
    });
  },
});

const VERIFY_LIST = 30;

export const strmVerifyTool = defineTool({
  name: "strm_verify",
  title: "strm 网盘核对",
  description: `到网盘核对一个任务（或它的一个子目录）的 strm 指向的文件还在不在：列出指向了不存在的文件或目录的 strm（最多 ${VERIFY_LIST} 条）、看不出指向哪的，以及没核对成的网盘目录。一次最多 ${STRM_LIMITS.VERIFY_FILES} 个 strm，大目录请分批。只读网盘、不改任何东西。要一会儿，${INLINE_WAIT_MS / 1000} 秒内做不完就转成作业，用 job_status 等。`,
  scope: "run",
  toolset: "strm",
  annotations: REMOTE_READ,
  input: z.object({ task: taskArg, path: pathArg }),
  async run(args, ctx) {
    const task = resolveTask(args.task);
    const rel = normRel(args.path);
    const provider = providerForTask(task);
    return runAsJob(ctx, "strm_verify", `核对 ${taskBrief(task).label}${rel ? `/${rel}` : ""}`, async (report) => {
      const r = await verify(task, provider, rel, { onProgress: (p) => report({ done: p.done, total: p.total || undefined, message: p.message }) });
      return {
        task: taskBrief(task),
        path: rel || "（整个任务）",
        checked: r.checked,
        dirs: r.dirs,
        missing: r.missing.length,
        ...(r.missing.length
          ? {
              missingSample: r.missing.slice(0, VERIFY_LIST).map((m) => ({ path: m.path, remotePath: m.remotePath, reason: m.reason === "dir-missing" ? "网盘目录不在了" : "网盘文件不在了" })),
            }
          : {}),
        ...(r.unparsable.length ? { unparsable: r.unparsable.slice(0, 20).map((u) => ({ path: u.path, reason: REASON_TEXT[u.reason] })) } : {}),
        ...(r.errors.length ? { errors: r.errors.slice(0, 10) } : {}),
        ...(r.note ? { note: r.note } : {}),
        next: r.missing.length
          ? "指向不存在文件的 strm：网盘上确实删了的，可以用 strm_delete 删掉（先征得用户同意），或者用 strm_rebuild 按网盘重建这个目录；刚转存 / 刚删的可能是网盘目录缓存还没更新，过几分钟再核对。"
          : "都对得上。",
        ...openInUi(uiPath(task, rel)),
      };
    });
  },
});

/* ------------------------------- 改 ------------------------------- */

export const strmFixTool = defineTool({
  name: "strm_fix",
  title: "修正 strm",
  description:
    "修正一个任务（或它的一个子目录）的本地 strm，不删东西：mode 为 rewrite（默认）时，把内容和任务现在的前缀 / 网盘路径 / 编码设置对不上的 strm 重写成应有的内容，dryRun 默认 true，只给要改几个和前几条样例，看过再传 dryRun: false 真改；mode 为 fill 时，按网盘目录把缺的 strm 补齐（要读网盘，不能对整个任务做，整个任务请用 sync_start）。**真改之前先把要改什么告诉用户，得到同意再调用。** 任务正在同步时不能做。",
  scope: "write",
  toolset: "strm",
  annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  input: z.object({
    task: taskArg,
    path: pathArg,
    mode: z.enum(["rewrite", "fill"]).optional().describe("rewrite（默认）重写内容过期的；fill 按网盘补齐缺的"),
    dryRun: z.boolean().optional().describe("rewrite 时只看不改，默认 true"),
  }),
  async run(args, ctx) {
    const task = resolveTask(args.task);
    const rel = normRel(args.path);
    if ((args.mode ?? "rewrite") === "fill") {
      if (!rel) throw new ToolError("VALIDATION", "fill 不能对整个任务做", "整个任务请用 sync_start 跑一次同步；这里给一个子目录。");
      const provider = providerForTask(task);
      return runAsJob(ctx, "strm_fill", `补齐 ${taskBrief(task).label}/${rel}`, async (report) => {
        report({ message: "读网盘目录" });
        const r = await regenerate(task, provider, rel, { mode: "fill" });
        return { task: taskBrief(task), path: rel, remoteFiles: r.remoteFiles, generated: r.generated, skipped: r.skipped, ...openInUi(uiPath(task, rel)) };
      });
    }
    const dryRun = args.dryRun ?? true;
    const r = await rewrite(task, rel, { dryRun });
    return {
      task: taskBrief(task),
      path: rel || "（整个任务）",
      dryRun,
      checked: r.checked,
      [dryRun ? "wouldChange" : "changed"]: r.changed,
      ...(r.foreign ? { foreign: r.foreign } : {}),
      ...(r.skippedRoots.length ? { skippedRoots: r.skippedRoots } : {}),
      ...(r.unparsable.length ? { unparsable: r.unparsable.slice(0, 20).map((u) => ({ path: u.path, reason: REASON_TEXT[u.reason] })) } : {}),
      ...(r.samples.length ? { samples: r.samples.slice(0, 5).map((x) => ({ path: x.path, from: hideUrlCredentials(x.from), to: hideUrlCredentials(x.to) })) } : {}),
      next: dryRun && r.changed > 0 ? "把要改几个、样例告诉用户，同意后传 dryRun: false 真改。" : undefined,
      ...openInUi(uiPath(task, rel)),
    };
  },
});

export const strmRebuildTool = defineTool({
  name: "strm_rebuild",
  title: "按网盘重建 strm",
  description:
    "按网盘现状重建一个任务的某个子目录（不能是整个任务）的 strm：网盘上有的补齐，本地多出来的 strm 会删掉（附件和别的任务的不动）。**会删本地 strm：调用前先告诉用户要重建哪个目录，得到同意再调用。** 要读网盘，可能要一两分钟，做不完转成作业，用 job_status 等。任务正在同步时不能做。",
  scope: "danger",
  toolset: "strm",
  annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: true },
  input: z.object({ task: taskArg, path: z.string().min(1).max(4096).describe("相对任务本地 strm 目录的子目录，用 / 分隔；不能是整个任务") }),
  async run(args, ctx) {
    const task = resolveTask(args.task);
    const rel = normRel(args.path);
    if (!rel) throw new ToolError("VALIDATION", "不能重建整个任务", "整个任务请用 sync_start 跑一次同步（任务开了「删除本地多余文件」的会顺带清掉多余的）。");
    const provider = providerForTask(task);
    // 确认框里不放目录名（网盘里的名字，常常来自别人的分享），说清是多大一片
    const local = await countUnder(task, [rel]);
    confirmFirst(
      ctx,
      `按网盘重建「${taskBrief(task).label}」下的一个子目录（本地现在有 ${local.strm}${local.truncated ? "+" : ""} 个 strm）：网盘上有的补齐，本地多出来的 strm 会删掉。`,
    );
    return runAsJob(ctx, "strm_rebuild", `重建 ${taskBrief(task).label}/${rel}`, async (report) => {
      report({ message: "读网盘目录" });
      const r = await regenerate(task, provider, rel, { mode: "rebuild" });
      return { task: taskBrief(task), path: rel, remoteFiles: r.remoteFiles, generated: r.generated, skipped: r.skipped, removed: r.removed, ...openInUi(uiPath(task, rel)) };
    });
  },
});

const DELETE_MAX = 100;

export const strmDeleteTool = defineTool({
  name: "strm_delete",
  title: "删除 strm",
  description: `删掉一个任务本地 strm 目录里的文件或目录（目录连里面的一起删），最多 ${DELETE_MAX} 项。只删本地，不动网盘；但下次同步时网盘上还在的会重新生成。不能删任务目录本身，也不能删属于别的任务的目录。**调用前先把要删哪些告诉用户，得到同意再调用。** 任务正在同步时不能删。`,
  scope: "danger",
  toolset: "strm",
  annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
  input: z.object({
    task: taskArg,
    paths: z.array(z.string().min(1).max(4096)).min(1).max(DELETE_MAX).describe(`要删的路径（相对任务本地 strm 目录），最多 ${DELETE_MAX} 项`),
  }),
  async run(args, ctx) {
    const task = resolveTask(args.task);
    const paths = [...new Set(args.paths.map(normRel).filter(Boolean))];
    if (paths.length === 0) throw new ToolError("VALIDATION", "不能删任务目录本身", "给任务目录下的具体路径。");
    // 确认框里不列路径名（网盘里的名字，常常来自别人的分享），按实际数出来的说：几个目录、里面一共多少 strm——
    // 夹在一串小文件里的一整个大目录，从数字上一眼看得出来
    const c = await countUnder(task, paths);
    const more = c.truncated ? "+" : "";
    const what = [c.dirs ? `${c.dirs} 个目录` : "", c.topFiles ? `${c.topFiles} 个文件` : "", c.missing ? `${c.missing} 项已经不在了` : ""].filter(Boolean).join("、");
    const others = c.files - c.strm;
    confirmFirst(
      ctx,
      `删除「${taskBrief(task).label}」本地 strm 目录里的 ${paths.length} 项（只删本地，不动网盘）：${what}；一共会删掉 ${c.strm}${more} 个 strm${others > 0 ? `和 ${others}${more} 个别的文件` : ""}。`,
    );
    const r = await deletePaths(task, paths);
    return {
      task: taskBrief(task),
      deleted: r.deleted,
      ...(r.failed.length ? { failed: r.failed.slice(0, 20) } : {}),
      ...openInUi(uiPath(task)),
    };
  },
});

/**
 * 全量同步任务的执行引擎。
 *
 * 路由、cron、Telegram 按钮、影库转存的 async 模式都直接调这里，
 * 不再经由 app.inject 自签 JWT 绕一圈 HTTP 鉴权。返回值就是 HTTP 语义的
 * `{ status, body }`，路由原样透传，其它调用方按 status 判断成败。
 */
import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import { catchError, EMPTY, from, merge, mergeMap, Subject, Subscription, tap } from "rxjs";
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { listAccounts, updateAccount } from "../../db/repositories/accounts.js";
import { getTask } from "../../db/repositories/tasks.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { resolveInDataDir } from "../../paths.js";
import { DEFAULT_TIMEOUT_MS } from "../../lib/http.js";
import { moduleLogger } from "../../lib/logger.js";
import { mapLimit } from "../../lib/async.js";
import { isDirectoryEntry } from "../../lib/fs.js";
import { Cloud115Error, exportDirParse, fsDirGetId } from "../cloud-115/client.js";
import {
  downloadOrCreateStrm,
  downloadOrCreateStrmLimited,
  getRealDownloadLink,
} from "../download/rate-limited.js";
import {
  addLogsToTaskExecution,
  completeTaskExecution,
  createTaskExecution,
  updateTaskExecution,
} from "../task-history.js";
import { refreshEmbyNow } from "../media-server.js";
import { extOf, extSet } from "../strm/naming.js";
import { sendTelegramNotification } from "../telegram.js";
import {
  getRunningTask,
  registerRunningTask,
  releaseTaskStart,
  reserveTaskStart,
  unregisterRunningTask,
  type DownloadProgress,
  type RunningTask,
} from "./registry.js";
import { LogBatcher } from "./log-batch.js";
import { flattenTree, planSync } from "./plan.js";
import { buildTree, collectFilesAndTopEmptyDirs, TreeBuilder, type TreeNode } from "./tree.js";

export interface StartTaskResult {
  /** HTTP 语义的状态码：200 已受理（可能是"无事可做"），其余为失败 */
  status: number;
  body: Record<string, unknown>;
}

const log = moduleLogger("task");

const fail = (status: number, message: string, detail?: string): StartTaskResult => ({
  status,
  body: detail ? { message, details: detail } : { message },
});

/* ------------------------------- 本地目录 ------------------------------- */

/**
 * 本地已有的目录树。一个库几万个文件，同步版会把 API 进程的事件循环卡住几秒到几分钟
 * （SSE、健康检查、cron 全停），所以整条链路都走异步 fs。
 */
async function getLocalTree(dirPath: string, parentKey = 0, depth = 0, keySeed = { value: 1 }): Promise<TreeNode[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return []; // 第一次同步，目录还不存在
  }
  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    const node: TreeNode = { key: keySeed.value++, name: entry.name, parent_key: parentKey, depth, children: [] };
    if (await isDirectoryEntry(dirPath, entry)) {
      node.children = await getLocalTree(path.join(dirPath, entry.name), node.key, depth + 1, keySeed);
    }
    nodes.push(node);
  }
  return nodes;
}

async function removeExtraFiles(extraLocally: string[], saveDir: string): Promise<void> {
  const removeEmptyParents = async (dir: string): Promise<void> => {
    if (!dir.startsWith(saveDir) || dir === saveDir) return;
    try {
      if ((await fsp.readdir(dir)).length === 0) {
        await fsp.rmdir(dir);
        await removeEmptyParents(path.dirname(dir));
      }
    } catch { /* 非空或已不存在 */ }
  };
  await mapLimit(extraLocally, 8, async (rel) => {
    const fp = path.join(saveDir, rel);
    try {
      // 文件、目录都行；已经不存在也不报错
      await fsp.rm(fp, { recursive: true, force: true });
      await removeEmptyParents(path.dirname(fp));
    } catch { /* 单个失败不影响其余 */ }
  });
}

/* ------------------------------- 远端目录 ------------------------------- */

async function getOpenlistTreeData(baseUrl: string, token: string, originPath: string): Promise<TreeNode[]> {
  const allPaths: string[] = [];
  async function collect(cur: string) {
    const r = await axios.post(
      `${baseUrl}/api/fs/list`,
      { path: cur, page: 1, per_page: 0, refresh: true },
      { headers: { Authorization: token }, timeout: DEFAULT_TIMEOUT_MS },
    );
    if (r.data.code !== 200) throw new Error(`Failed to list ${cur}: ${r.data.message}`);
    for (const item of r.data.data.content || []) {
      const p = cur.endsWith("/") ? `${cur}${item.name}` : `${cur}/${item.name}`;
      allPaths.push(p);
      if (item.is_dir) await collect(p);
    }
  }
  await collect(originPath);

  const parts = originPath.split("/").filter(Boolean);
  const lastDir = parts[parts.length - 1] || "";
  const prefix = originPath.substring(0, originPath.lastIndexOf("/" + lastDir));
  const cleaned = allPaths
    .map((p) => {
      if (prefix.length === 0) return p;
      if (p.startsWith(prefix + "/")) return p.substring(prefix.length + 1);
      if (p.startsWith(prefix)) {
        const c = p.substring(prefix.length);
        return c.startsWith("/") ? c.substring(1) : c;
      }
      return p;
    })
    .filter(Boolean);

  const tree = new TreeBuilder();
  for (const full of cleaned) tree.add(full.split("/").filter(Boolean));
  return tree.nodes;
}

async function loadRemoteTree(
  task: TaskDefinition,
  accountInfo: AccountInfo,
): Promise<{ tree: TreeNode[] } | { fail: StartTaskResult }> {
  const { account, originPath } = task;

  if (accountInfo.accountType === "115") {
    if (!accountInfo.cookie) return { fail: fail(500, `115 账号 ${account} 没有 cookie`) };
    try {
      const idRes = await fsDirGetId(originPath, { accountInfo });
      const data = await exportDirParse({
        exportFileIds: idRes.id,
        targetPid: 0,
        layerLimit: 0,
        deleteAfter: true,
        timeoutMs: 300000,
        checkIntervalMs: 1000,
        accountInfo,
      });
      return { tree: buildTree(data) };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const blocked =
        (error instanceof Cloud115Error && error.status === 405) ||
        msg.includes("<!doctypehtml>") ||
        msg.includes("您的访问被阻断");
      if (blocked) {
        return { fail: fail(403, "115账号被封控", "账号访问被阿里云阻断，请检查账号状态或稍后重试") };
      }
      // ensureOk 的 message 自带"115："前缀，这里外面还有一层"读取 115 目录失败"，别叠成"…失败：115：…"
      return { fail: fail(500, "读取 115 目录失败", msg.replace(/^115：/, "")) };
    }
  }

  if (accountInfo.accountType === "openlist") {
    if (!accountInfo.account || !accountInfo.password || !accountInfo.url) {
      return { fail: fail(500, "OpenList 账号缺少地址或用户名/密码") };
    }
    let token = accountInfo.token;
    if (!token || (accountInfo.expiresAt && Date.now() / 1000 > accountInfo.expiresAt)) {
      const lr = await axios.post(
        `${accountInfo.url}/api/auth/login`,
        { username: accountInfo.account, password: accountInfo.password },
        { timeout: DEFAULT_TIMEOUT_MS },
      );
      if (lr.data.code !== 200) return { fail: fail(500, `OpenList 登录失败：${lr.data.message ?? lr.data.code}`) };
      token = lr.data.data.token;
      accountInfo.token = token;
      accountInfo.expiresAt = Math.floor(Date.now() / 1000) + 47 * 3600;
      updateAccount(accountInfo.name, { token, expiresAt: accountInfo.expiresAt });
    }
    if (!token) return { fail: fail(500, "OpenList 登录失败：没有拿到 token") };
    return { tree: buildTree(await getOpenlistTreeData(accountInfo.url, token, originPath)) };
  }

  // AccountInfo 是判别联合，到这里已经穷尽；留一条兜底以防将来加类型
  return { fail: fail(400, "Unknown account type") };
}

/* --------------------------------- 入口 --------------------------------- */

export async function startTask(taskId: string): Promise<StartTaskResult> {
  const task = getTask(taskId);
  if (!task) return fail(404, "Task not found");
  // 第一个 await 之前就占住：拉远端目录树可能要几分钟，只查 running 表挡不住这期间的第二次启动
  if (!reserveTaskStart(taskId)) return fail(409, "Task is already running");
  try {
    const result = await launch(task);
    if (result.status !== 200) recordFailedStart(task, result.body);
    return result;
  } catch (err) {
    recordFailedStart(task, { message: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    // 到这里要么已经注册进 running，要么是提前失败返回；占位都可以放掉了
    releaseTaskStart(taskId);
  }
}

/**
 * 起不来也要进历史。cookie 失效、封控、目录不存在这些最常见的失败都发生在拉目录树阶段，
 * 以前只在响应里说一句，历史页看不到"为什么没跑"——定时触发的更是无人知晓。
 * "无事可做"的 200 不算失败，照旧不留记录，不然每 30 分钟一条空记录。
 */
function recordFailedStart(task: TaskDefinition, body: Record<string, unknown>): void {
  const message = typeof body.message === "string" && body.message ? body.message : "启动失败";
  const details = typeof body.details === "string" && body.details ? `：${body.details}` : "";
  try {
    const execution = createTaskExecution(task.id, {
      account: task.account,
      originPath: task.originPath,
      targetPath: task.targetPath,
      removeExtraFiles: task.removeExtraFiles,
    });
    completeTaskExecution(execution.id, "failed", { errorMessage: `${message}${details}` });
  } catch (err) {
    log.warn({ err, taskId: task.id }, "写入失败的执行记录失败");
  }
}

async function launch(task: TaskDefinition): Promise<StartTaskResult> {
  const { id, account, originPath, targetPath, strmPrefix } = task;
  const accounts = listAccounts();
  const accountInfo = accounts.find((a) => a.name === account);
  if (!accountInfo) return fail(500, `账号不存在：${account}`);

  const saveDir = resolveInDataDir(targetPath);
  if (!saveDir) return fail(400, `targetPath 越出了数据目录: ${targetPath}`);

  const loaded = await loadRemoteTree(task, accountInfo);
  if ("fail" in loaded) return loaded.fail;

  await fsp.mkdir(saveDir, { recursive: true });

  const settings = readAppSettings();
  const strmExts = extSet(settings.strmExtensions);
  const dlExts = extSet(settings.downloadExtensions);

  // 对照规则在 plan.ts，有单测钉着；这里只负责把两边的清单喂进去
  const remoteEntries = flattenTree(loaded.tree);
  const localEntries = collectFilesAndTopEmptyDirs(await getLocalTree(saveDir));
  const { missing: missingLocally, extra: extraLocally } = planSync(remoteEntries, localEntries, strmExts, dlExts);

  let warning: string | undefined;
  if (task.removeExtraFiles && extraLocally.length > 0) {
    if (remoteEntries.length === 0) {
      // 远端一个文件都没有而本地有一堆，十有八九是导出出了问题（空导出、解析没对上），
      // 不是用户真把网盘清空了。删错的代价是整个库，宁可跳过；真要清空有"清空目录"
      warning = `远端目录为空而本地有 ${localEntries.length} 个条目，像是目录导出失败，已跳过清理本地多余文件`;
      log.warn({ taskId: id, local: localEntries.length }, warning);
    } else {
      await removeExtraFiles(extraLocally, saveDir);
    }
  }
  if (missingLocally.length === 0) return { status: 200, body: { message: "no files to download", warning } };

  const total = missingLocally.length;
  const subject = new Subject<DownloadProgress>();
  const perFile = new Map<string, number>(missingLocally.map((fp) => [fp, 0]));
  const execution = createTaskExecution(id, { account, originPath, targetPath, removeExtraFiles: task.removeExtraFiles });
  updateTaskExecution(execution.id, {
    summary: { totalFiles: total, downloadedFiles: 0, deletedFiles: task.removeExtraFiles ? extraLocally.length : 0 },
  });

  const running: RunningTask = { subject, subscription: new Subscription(), logs: [] };
  registerRunningTask(id, running);
  sendTelegramNotification(`<b>Task ID:</b> ${id}\n<b>Account:</b> ${account}\n<b>Files:</b> ${total}`, "start");

  // 落库的日志攒批写；取消时随订阅一起 flush（见下面的 subscription.add）
  const history = new LogBatcher((lines) => addLogsToTaskExecution(execution.id, lines));
  const pushLog = (log: DownloadProgress) => {
    // 被取消之后不再往流里写：订阅者早就收到 done 了
    if (getRunningTask(id) !== running) return;
    const line = JSON.stringify(log);
    running.logs.push(line);
    if (running.logs.length > 20000) running.logs.shift();
    subject.next(log);
    // 历史只留有价值的行：开始、单个文件完成/失败、任务级错误、结束；每一步进度不落库
    if (log.start || (log.filePath && (log.percent === 100 || log.error)) || log.done || log.error) history.push(line);
  };

  const strmFiles = missingLocally.filter((fp) => strmExts.has(extOf(fp)));
  const downloadFiles = missingLocally.filter((fp) => dlExts.has(extOf(fp)));
  // 第一条事件：总数和两类各多少。晚打开日志页的人从回放里也能拿到
  pushLog({ start: true, total, strmTotal: strmFiles.length, downloadTotal: downloadFiles.length, at: Date.now() });

  // 总进度用累计值：每来一个事件就把 perFile 全部加一遍是 O(n)，几万个文件就是 O(n²)
  let sumPercent = 0;
  const finished = new Set<string>();
  const failedFiles: string[] = [];
  const overall = () => (total > 0 ? (sumPercent / total).toFixed(2) : "100.00");
  const report = (p: { filePath?: string; percent?: number }, kind: "strm" | "download") => {
    const fp = p.filePath!;
    const pct = Math.min(100, Math.max(0, p.percent ?? 0));
    sumPercent += pct - (perFile.get(fp) ?? 0);
    perFile.set(fp, pct);
    if (pct === 100) finished.add(fp);
    pushLog({ filePath: fp, kind, percent: pct, overallPercent: overall() });
  };
  /**
   * 单个文件失败：记一行、计数，任务继续。
   * 以前下载那条流没有接住，一个文件 404 会把整条 merge 炸掉：剩下的下载全部中止，
   * 历史里 downloadedFiles 记 0，错误信息里连是哪个文件都没有。
   */
  const failOne = (filePath: string, kind: "strm" | "download", err: unknown) => {
    failedFiles.push(filePath);
    pushLog({ filePath, kind, error: err instanceof Error ? err.message : String(err) });
    return EMPTY;
  };
  const finish = (status: "completed" | "failed", fatal?: string) => {
    const message = fatal ?? (failedFiles.length > 0 ? describeFailures(failedFiles) : undefined);
    pushLog({
      done: true, status, total, finished: finished.size, failed: failedFiles.length,
      overallPercent: overall(), message, at: Date.now(),
    });
    history.flush();
    subject.complete();
    completeTaskExecution(execution.id, status, {
      totalFiles: total, downloadedFiles: finished.size, failedFiles: failedFiles.length, errorMessage: message,
    });
    unregisterRunningTask(id);
  };
  // 取消（界面按钮、进程退出）时由 registry 调：退订已经中止了下载，这里只管把账记平
  running.onCancel = (reason) => {
    history.flush();
    completeTaskExecution(execution.id, "cancelled", {
      totalFiles: total, downloadedFiles: finished.size, failedFiles: failedFiles.length, errorMessage: reason,
    });
  };

  // strm 只是写一个小文本文件，不限流；但几万个也别一口气全扔出去
  const strm$ = from(strmFiles).pipe(
    mergeMap(
      (filePath) =>
        downloadOrCreateStrm(`${originPath}/${filePath}`, path.join(saveDir, filePath), {
          asStrm: true,
          displayPath: filePath,
          strmPrefix,
          enablePathEncoding: task.enablePathEncoding,
        }).pipe(
          tap((p) => report(p, "strm")),
          catchError((err: unknown) => failOne(filePath, "strm", err)),
        ),
      32,
    ),
  );

  // 真正要下载的文件走账号级限流；取直链失败和下载失败都算这一个文件的失败
  const download$ = from(downloadFiles).pipe(
    mergeMap(
      (filePath) =>
        from(getRealDownloadLink(`${originPath}/${filePath}`, account, accounts)).pipe(
          mergeMap((url) =>
            downloadOrCreateStrmLimited(url, path.join(saveDir, filePath), account, {
              asStrm: false,
              displayPath: filePath,
            }),
          ),
          tap((p) => report(p, "download")),
          catchError((err: unknown) => failOne(filePath, "download", err)),
        ),
      10,
    ),
  );

  // 两条一起跑完才算完成：以前 strm 那条不在订阅里，纯 strm 的任务会在文件还没写完时就报"完成"
  running.subscription = merge(strm$, download$).subscribe({
    complete: () => {
      const status = failedFiles.length > 0 ? "failed" : "completed";
      finish(status);
      if (status === "completed") {
        sendTelegramNotification(`<b>Task ID:</b> ${id}\n<b>Files:</b> ${total}\n<b>Status:</b> Completed`, "complete");
      } else {
        sendTelegramNotification(
          `<b>Task ID:</b> ${id}\n<b>Files:</b> ${total}\n<b>Failed:</b> ${failedFiles.length}\n${describeFailures(failedFiles)}`,
          "error",
        );
      }
      // 失败的只是个别文件，写好的那些一样要让媒体库看到
      refreshEmbyNow("全量任务完成");
    },
    error: (err: Error) => {
      // 单个文件的失败都在上面接住了，走到这里是流本身出了意外
      pushLog({ error: err.message });
      finish("failed", err.message);
      sendTelegramNotification(`<b>Task ID:</b> ${id}\n<b>Error:</b> ${err.message}`, "error");
    },
  });
  // 退订（取消、进程退出）时把还没落库的行写掉；正常结束时上面已经 flush 过，这里是空操作
  running.subscription.add(() => history.flush());

  return {
    status: 200,
    body: {
      message: `${total} files to download`,
      taskId: id,
      extraFilesCount: extraLocally.length,
      willDeleteExtraFiles: task.removeExtraFiles || false,
      warning,
    },
  };
}

/** 失败文件的一句话说明：前几个名字 + 总数 */
function describeFailures(files: string[]): string {
  const shown = files.slice(0, 3).map((f) => path.basename(f)).join("、");
  return `${files.length} 个文件失败：${shown}${files.length > 3 ? " 等" : ""}`;
}

/**
 * 全量同步任务的执行引擎。
 *
 * 路由、cron、Telegram 按钮、影库转存的 async 模式都直接调这里，
 * 不再经由 app.inject 自签 JWT 绕一圈 HTTP 鉴权。返回值就是 HTTP 语义的
 * `{ status, body }`，路由原样透传，其它调用方按 status 判断成败。
 */
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { from, mergeMap, Subject, Subscription } from "rxjs";
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { listAccounts, updateAccount } from "../../db/repositories/accounts.js";
import { getTask } from "../../db/repositories/tasks.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { resolveInDataDir } from "../../paths.js";
import { exportDirParse, fsDirGetId } from "../cloud-115/client.js";
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
  isTaskRunning,
  registerRunningTask,
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

const fail = (status: number, message: string, detail?: string): StartTaskResult => ({
  status,
  body: detail ? { message, details: detail } : { message },
});

/* ------------------------------- 本地目录 ------------------------------- */

function getLocalTree(dirPath: string, parentKey = 0, depth = 0, keySeed = { value: 1 }): TreeNode[] {
  if (!fs.existsSync(dirPath)) return [];
  const nodes: TreeNode[] = [];
  for (const name of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, name);
    const stat = fs.statSync(full);
    const node: TreeNode = { key: keySeed.value++, name, parent_key: parentKey, depth, children: [] };
    if (stat.isDirectory()) node.children = getLocalTree(full, node.key, depth + 1, keySeed);
    nodes.push(node);
  }
  return nodes;
}

function removeExtraFiles(extraLocally: string[], saveDir: string): void {
  const removeEmptyParents = (dir: string) => {
    if (!dir.startsWith(saveDir) || dir === saveDir) return;
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        removeEmptyParents(path.dirname(dir));
      }
    } catch { /* 非空或已不存在 */ }
  };
  for (const rel of extraLocally) {
    const fp = path.join(saveDir, rel);
    try {
      if (!fs.existsSync(fp)) continue;
      const s = fs.statSync(fp);
      if (s.isFile()) fs.unlinkSync(fp);
      else if (s.isDirectory()) fs.rmSync(fp, { recursive: true, force: true });
      removeEmptyParents(path.dirname(fp));
    } catch { /* 单个失败不影响其余 */ }
  }
}

/* ------------------------------- 远端目录 ------------------------------- */

async function getOpenlistTreeData(baseUrl: string, token: string, originPath: string): Promise<TreeNode[]> {
  const allPaths: string[] = [];
  async function collect(cur: string) {
    const r = await axios.post(
      `${baseUrl}/api/fs/list`,
      { path: cur, page: 1, per_page: 0, refresh: true },
      { headers: { Authorization: token } },
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
    if (!accountInfo.cookie) return { fail: fail(500, `Missing cookie for 115 account: ${account}`) };
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
      if (msg.includes("<!doctypehtml>") || msg.includes("405") || msg.includes("您的访问被阻断")) {
        return { fail: fail(403, "115账号被封控", "账号访问被阿里云阻断，请检查账号状态或稍后重试") };
      }
      return { fail: fail(500, "Failed to parse 115 directory", msg) };
    }
  }

  if (accountInfo.accountType === "openlist") {
    if (!accountInfo.account || !accountInfo.password || !accountInfo.url) {
      return { fail: fail(500, "Missing openlist credentials") };
    }
    let token = accountInfo.token;
    if (!token || (accountInfo.expiresAt && Date.now() / 1000 > accountInfo.expiresAt)) {
      const lr = await axios.post(`${accountInfo.url}/api/auth/login`, {
        username: accountInfo.account,
        password: accountInfo.password,
      });
      if (lr.data.code !== 200) return { fail: fail(500, "Openlist login failed") };
      token = lr.data.data.token;
      accountInfo.token = token;
      accountInfo.expiresAt = Math.floor(Date.now() / 1000) + 47 * 3600;
      updateAccount(accountInfo.name, { token, expiresAt: accountInfo.expiresAt });
    }
    if (!token) return { fail: fail(500, "Openlist login failed") };
    return { tree: buildTree(await getOpenlistTreeData(accountInfo.url, token, originPath)) };
  }

  // AccountInfo 是判别联合，到这里已经穷尽；留一条兜底以防将来加类型
  return { fail: fail(400, "Unknown account type") };
}

/* --------------------------------- 入口 --------------------------------- */

export async function startTask(taskId: string): Promise<StartTaskResult> {
  const task = getTask(taskId);
  if (!task) return fail(404, "Task not found");
  if (isTaskRunning(taskId)) return fail(409, "Task is already running");

  const { id, account, originPath, targetPath, strmPrefix } = task;
  const accounts = listAccounts();
  const accountInfo = accounts.find((a) => a.name === account);
  if (!accountInfo) return fail(500, `No account found: ${account}`);

  const saveDir = resolveInDataDir(targetPath);
  if (!saveDir) return fail(400, `targetPath 越出了数据目录: ${targetPath}`);

  const loaded = await loadRemoteTree(task, accountInfo);
  if ("fail" in loaded) return loaded.fail;

  fs.mkdirSync(saveDir, { recursive: true });

  const settings = readAppSettings();
  const strmExts = extSet(settings.strmExtensions);
  const dlExts = extSet(settings.downloadExtensions);

  // 对照规则在 plan.ts，有单测钉着；这里只负责把两边的清单喂进去
  const { missing: missingLocally, extra: extraLocally } = planSync(
    flattenTree(loaded.tree),
    collectFilesAndTopEmptyDirs(getLocalTree(saveDir)),
    strmExts,
    dlExts,
  );

  if (task.removeExtraFiles) removeExtraFiles(extraLocally, saveDir);
  if (missingLocally.length === 0) return { status: 200, body: { message: "no files to download" } };

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
    if ((log.filePath && log.percent === 100) || log.done || log.error) history.push(line);
  };

  // strm 只是写一个小文本文件，不限流
  for (const filePath of missingLocally.filter((fp) => strmExts.has(extOf(fp)))) {
    downloadOrCreateStrm(`${originPath}/${filePath}`, path.join(saveDir, filePath), {
      asStrm: true,
      displayPath: filePath,
      strmPrefix,
      enablePathEncoding: task.enablePathEncoding,
    }).subscribe({
      next: (p) => {
        perFile.set(p.filePath!, 100);
        pushLog({ filePath: p.filePath, percent: 100 });
      },
      error: (err) => pushLog({ error: err.message }),
    });
  }

  // 真正要下载的文件走账号级限流
  const downloadFiles = missingLocally.filter((fp) => dlExts.has(extOf(fp)));
  running.subscription = from(downloadFiles)
    .pipe(
      mergeMap(
        (filePath) =>
          from(getRealDownloadLink(`${originPath}/${filePath}`, account, accounts)).pipe(
            mergeMap((url) =>
              downloadOrCreateStrmLimited(url, path.join(saveDir, filePath), account, {
                asStrm: false,
                displayPath: filePath,
              }),
            ),
          ),
        10,
      ),
    )
    .subscribe({
      next: (p) => {
        perFile.set(p.filePath!, Math.min(100, Math.max(0, p.percent ?? 0)));
        const sum = [...perFile.values()].reduce((a, b) => a + b, 0);
        pushLog({ filePath: p.filePath, percent: p.percent, overallPercent: (sum / total).toFixed(2) });
      },
      complete: () => {
        pushLog({ done: true, overallPercent: "100.00" });
        history.flush();
        subject.complete();
        sendTelegramNotification(`<b>Task ID:</b> ${id}\n<b>Files:</b> ${total}\n<b>Status:</b> Completed`, "complete");
        completeTaskExecution(execution.id, "completed", { totalFiles: total, downloadedFiles: total });
        refreshEmbyNow("全量任务完成");
        unregisterRunningTask(id);
      },
      error: (err) => {
        pushLog({ error: err.message });
        history.flush();
        sendTelegramNotification(`<b>Task ID:</b> ${id}\n<b>Error:</b> ${err.message}`, "error");
        completeTaskExecution(execution.id, "failed", { totalFiles: total, downloadedFiles: 0, errorMessage: err.message });
        subject.complete();
        unregisterRunningTask(id);
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
    },
  };
}

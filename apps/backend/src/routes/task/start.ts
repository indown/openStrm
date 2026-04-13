import type { FastifyInstance } from "fastify";
import { from, mergeMap, Subject, Subscription } from "rxjs";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import type { DownloadProgress } from "../../plugins/task-manager.js";
import { exportDirParse, fs_dir_getid } from "../../services/cloud-115/client.js";
import {
  getRealDownloadLink,
  downloadOrCreateStrmLimited,
  downloadOrCreateStrm,
} from "../../services/download/rate-limited.js";
import {
  createTaskExecution,
  updateTaskExecution,
  addLogToTaskExecution,
  completeTaskExecution,
} from "../../services/task-history.js";
import { sendTelegramNotification } from "../../services/telegram.js";

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), "data");
const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(process.cwd(), "config");

type TreeNode = { depth: number; key: number; name: string; parent_key: number; children?: TreeNode[] };

function buildTree(list: TreeNode[]): TreeNode[] {
  const map = new Map<number, TreeNode>();
  const roots: TreeNode[] = [];
  list.forEach((n) => map.set(n.key, { ...n, children: [] }));
  list.forEach((n) => {
    if (n.parent_key === 0) roots.push(map.get(n.key)!);
    else map.get(n.parent_key)?.children!.push(map.get(n.key)!);
  });
  return roots;
}

function collectFilesAndTopEmptyDirs(nodes: TreeNode[], parentPath = ""): string[] {
  const result: string[] = [];
  function dfs(nodeList: TreeNode[], basePath: string): boolean {
    let hasFile = false;
    for (const node of nodeList) {
      const cur = basePath ? `${basePath}/${node.name}` : node.name;
      if ((!node.children || node.children.length === 0) && /\.[a-z0-9]+$/i.test(node.name)) {
        result.push(cur); hasFile = true;
      } else if (node.children && node.children.length > 0) {
        if (dfs(node.children, cur)) hasFile = true;
      }
    }
    if (!hasFile && basePath) { result.push(basePath); return true; }
    return hasFile;
  }
  dfs(nodes, parentPath);
  return result;
}

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

function normalizeToStrm(p: string): string {
  return p.replace(/\.(mp4|mp3|mkv)$/i, ".strm");
}

function removeExtraFiles(extraLocally: string[], saveDir: string) {
  const removeEmptyParents = (dir: string) => {
    if (!dir.startsWith(saveDir) || dir === saveDir) return;
    try { if (fs.readdirSync(dir).length === 0) { fs.rmdirSync(dir); removeEmptyParents(path.dirname(dir)); } } catch {}
  };
  for (const rel of extraLocally) {
    const fp = path.join(saveDir, rel);
    try {
      if (!fs.existsSync(fp)) continue;
      const s = fs.statSync(fp);
      if (s.isFile()) fs.unlinkSync(fp);
      else if (s.isDirectory()) fs.rmSync(fp, { recursive: true, force: true });
      removeEmptyParents(path.dirname(fp));
    } catch {}
  }
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "settings.json"), "utf-8") || "{}"); } catch { return {}; }
}

function notifyEmbyRefresh() {
  try {
    const s = readSettings();
    if (!s.emby?.url || !s.emby?.apiKey) return;
    const url = `${s.emby.url.replace(/\/$/, "")}/Library/Refresh?api_key=${encodeURIComponent(s.emby.apiKey)}`;
    axios.post(url).catch(() => {});
  } catch {}
}

async function getOpenlistTreeData(baseUrl: string, token: string, originPath: string): Promise<TreeNode[]> {
  const allPaths: string[] = [];
  async function collect(cur: string) {
    const r = await axios.post(`${baseUrl}/api/fs/list`, { path: cur, page: 1, per_page: 0, refresh: true }, { headers: { Authorization: token } });
    if (r.data.code !== 200) throw new Error(`Failed to list ${cur}: ${r.data.message}`);
    for (const item of r.data.data.content || []) {
      const p = cur.endsWith("/") ? `${cur}${item.name}` : `${cur}/${item.name}`;
      allPaths.push(p);
      if (item.is_dir) await collect(p);
    }
  }
  await collect(originPath);
  // Clean and convert
  const parts = originPath.split("/").filter(Boolean);
  const lastDir = parts[parts.length - 1] || "";
  const prefix = originPath.substring(0, originPath.lastIndexOf("/" + lastDir));
  const cleaned = allPaths.map((p) => {
    if (prefix.length === 0) return p;
    if (p.startsWith(prefix + "/")) return p.substring(prefix.length + 1);
    if (p.startsWith(prefix)) { const c = p.substring(prefix.length); return c.startsWith("/") ? c.substring(1) : c; }
    return p;
  }).filter(Boolean);

  const data: TreeNode[] = [{ depth: 0, key: 0, name: "", parent_key: 0 }];
  const nodeMap = new Map<string, number>();
  let counter = 1;
  for (const full of cleaned) {
    const segs = full.split("/").filter(Boolean);
    let parentKey = 0; let cur = "";
    for (let i = 0; i < segs.length; i++) {
      cur = i === 0 ? segs[i] : `${cur}/${segs[i]}`;
      const nk = `${i + 1}-${segs[i]}-${parentKey}`;
      if (!nodeMap.has(nk)) { const k = counter++; data.push({ depth: i + 1, key: k, name: segs[i], parent_key: parentKey }); nodeMap.set(nk, k); parentKey = k; }
      else parentKey = nodeMap.get(nk)!;
    }
  }
  return data;
}

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/startTask", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body as { id: string };
    const tasks = fastify.readTasks();
    const task = tasks.find((t) => t.id === body.id);
    if (!task) return reply.code(404).send({ message: "Task not found" });

    const { id, account, originPath, targetPath, strmPrefix } = task;
    const accounts = fastify.readAccounts();
    const accountInfo = accounts.find((a: any) => a.name === account) as any;
    if (!accountInfo) return reply.code(500).send({ message: `No account found: ${account}` });

    const accountType = accountInfo.accountType;
    let tree: TreeNode[];

    if (accountType === "115") {
      if (!accountInfo.cookie) return reply.code(500).send({ message: `Missing cookie for 115 account: ${account}` });
      const idRes = await fs_dir_getid(originPath, { accountInfo });
      const data = await exportDirParse({ exportFileIds: (idRes as any).id, targetPid: 0, layerLimit: 0, deleteAfter: true, timeoutMs: 300000, checkIntervalMs: 1000, accountInfo });
      tree = buildTree(data as any);
    } else if (accountType === "openlist") {
      if (!accountInfo.account || !accountInfo.password || !accountInfo.url) return reply.code(500).send({ message: `Missing openlist credentials` });
      let token = accountInfo.token;
      if (!token || (accountInfo.expiresAt && Date.now() / 1000 > accountInfo.expiresAt)) {
        const lr = await axios.post(`${accountInfo.url}/api/auth/login`, { username: accountInfo.account, password: accountInfo.password });
        if (lr.data.code !== 200) return reply.code(500).send({ message: `Openlist login failed` });
        token = lr.data.data.token;
        accountInfo.token = token; accountInfo.expiresAt = Math.floor(Date.now() / 1000) + 47 * 3600;
        fastify.writeAccounts(accounts);
      }
      tree = buildTree(await getOpenlistTreeData(accountInfo.url, token, originPath));
    } else {
      return reply.code(400).send({ message: `Unknown account type: ${accountType}` });
    }

    const saveDir = path.resolve(DATA_DIR, targetPath);
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

    const remoteFiles: string[] = [];
    for (const node of tree) {
      if (node.children?.length) remoteFiles.push(...collectFilesAndTopEmptyDirs(node.children));
      else if (/\.[a-z0-9]+$/i.test(node.name)) remoteFiles.push(node.name);
    }

    const remotePaths = new Set(remoteFiles.map(normalizeToStrm));
    const localPaths = new Set(collectFilesAndTopEmptyDirs(getLocalTree(saveDir)));
    const missingLocally = remoteFiles.filter((p) => !localPaths.has(normalizeToStrm(p)));
    const extraLocally = [...localPaths].filter((p) => !remotePaths.has(p));

    if (task.removeExtraFiles) removeExtraFiles(extraLocally, saveDir);
    if (missingLocally.length === 0) return { message: "no files to download" };

    // Start download task
    const total = missingLocally.length;
    const taskSubject = new Subject<DownloadProgress>();
    const perFile = new Map<string, number>();
    missingLocally.forEach((fp) => perFile.set(fp, 0));
    const executionHistory = createTaskExecution(id, { account, originPath, targetPath, removeExtraFiles: task.removeExtraFiles });
    updateTaskExecution(executionHistory.id, { summary: { totalFiles: total, downloadedFiles: 0, deletedFiles: 0 } });

    fastify.downloadTasks[id] = { subject: taskSubject, subscription: new Subscription(), logs: [] };
    sendTelegramNotification(`<b>Task ID:</b> ${id}\n<b>Account:</b> ${account}\n<b>Files:</b> ${total}`, "start");

    const pushLog = (log: DownloadProgress) => {
      const line = JSON.stringify(log);
      const dt = fastify.downloadTasks[id];
      if (dt) { dt.logs.push(line); if (dt.logs.length > 20000) dt.logs.shift(); dt.subject.next(log); }
      if ((log.filePath && log.percent === 100) || log.done || log.error) addLogToTaskExecution(executionHistory.id, line);
    };

    const settings = readSettings();
    const strmExts = (settings.strmExtensions || []).map((e: string) => e.toLowerCase());
    const dlExts = (settings.downloadExtensions || []).map((e: string) => e.toLowerCase());

    // strm files
    missingLocally.filter((fp) => strmExts.includes(path.extname(fp).toLowerCase())).forEach((filePath) => {
      downloadOrCreateStrm(originPath + "/" + filePath, path.join(saveDir, filePath), { asStrm: true, displayPath: filePath, strmPrefix, enablePathEncoding: task.enablePathEncoding })
        .subscribe({ next: (p) => { perFile.set(p.filePath!, 100); pushLog({ filePath: p.filePath, percent: 100 }); }, error: (err) => pushLog({ error: err.message }) });
    });

    // download files
    const downloadFiles = missingLocally.filter((fp) => dlExts.includes(path.extname(fp).toLowerCase()));
    const subscription = from(downloadFiles).pipe(
      mergeMap((filePath) => from(getRealDownloadLink(originPath + "/" + filePath, account, accounts)).pipe(
        mergeMap((url) => downloadOrCreateStrmLimited(url, path.join(saveDir, filePath), account, { asStrm: false, displayPath: filePath }))
      ), 10)
    ).subscribe({
      next: (p) => {
        perFile.set(p.filePath!, Math.min(100, Math.max(0, p.percent)));
        const sum = [...perFile.values()].reduce((a, b) => a + b, 0);
        pushLog({ filePath: p.filePath, percent: p.percent, overallPercent: (sum / total).toFixed(2) });
      },
      complete: () => {
        pushLog({ done: true, overallPercent: "100.00" }); taskSubject.complete();
        sendTelegramNotification(`<b>Task ID:</b> ${id}\n<b>Files:</b> ${total}\n<b>Status:</b> Completed`, "complete");
        completeTaskExecution(executionHistory.id, "completed", { totalFiles: total, downloadedFiles: total });
        notifyEmbyRefresh(); delete fastify.downloadTasks[id];
      },
      error: (err) => {
        pushLog({ error: err.message });
        sendTelegramNotification(`<b>Task ID:</b> ${id}\n<b>Error:</b> ${err.message}`, "error");
        completeTaskExecution(executionHistory.id, "failed", { totalFiles: total, downloadedFiles: 0, errorMessage: err.message });
        taskSubject.complete(); delete fastify.downloadTasks[id];
      },
    });

    if (fastify.downloadTasks[id]) fastify.downloadTasks[id].subscription = subscription;

    return {
      message: `${missingLocally.length} files to download`,
      taskId: id,
      extraFilesCount: extraLocally.length,
      willDeleteExtraFiles: task.removeExtraFiles || false,
    };
  });
}

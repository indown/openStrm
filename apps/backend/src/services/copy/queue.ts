/**
 * 「复制到 OpenList」的队列：记录形状、落库、去重、裁剪。
 *
 * 和云下载回执一样落在 settings 表的一个键里（`copy.queue`），进程重启不丢。
 * 不碰网络，纯读写 + 计算，好测。
 */
import { readKv, writeKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";

/** 谁把这条活儿丢进来的，给界面和通知看 */
export type CopyTrigger = "offline" | "share" | "follow" | "monitor" | "manual";
export type CopyStatus = "pending" | "done" | "skipped" | "failed";
/** pending 的两个阶段：waiting=等产物在 OpenList 里可见；copying=已提交，盯复制任务 */
export type CopyStage = "waiting" | "copying";

export interface CopyRecord {
  /** 队列内唯一，重试 / 删除按它来 */
  id: string;
  /** 网盘账号名（115 / 夸克 / 以后的），用来查挂载根，删源时也用它取 Provider */
  account: string;
  /** 源条目所在目录的网盘绝对路径 */
  srcDir: string;
  /** 源条目名（文件或目录） */
  name: string;
  /** 已知是目录就记上；不知道不填 */
  isDir?: boolean;
  /** 已知的网盘节点 id：删源时核对，整理把文件挪走之后不会删错 */
  nodeId?: string;
  /** 目标目录（OpenList 绝对路径），登记时就算好冻结住 */
  dstDir: string;
  /** 触发时的同步任务；没有就是空串 */
  taskId: string;
  trigger: CopyTrigger;
  /** 复制成功后把网盘上那份删掉（搬运）。登记时按任务设置冻结，之后改设置不影响在途的 */
  deleteSource?: boolean;
  addedAt: number;
  status: CopyStatus;
  stage: CopyStage;
  detail: string;
  doneAt?: number;
  /** 提交 /fs/copy 的尝试次数：只有接口报错才加 */
  attempts: number;
  /** waiting 阶段：产物连续几轮没出现在 OpenList 的源目录里 */
  waits: number;
  /** copying 阶段：OpenList 的任务列表里连续几轮找不到这次复制 */
  misses: number;
  /** OpenList 建出来的复制任务 id */
  copyTaskId?: string;
  /** 提交时间（ms）：把 done 列表里的陈年同名任务滤掉 */
  submittedAt?: number;
}

const QUEUE_KEY = KEY.copyQueue;
/**
 * 失败的留 7 天、办完的留 2 天，上限 500。
 * 分开留是因为监控是一个文件一条记录：一季 40 集成功之后，如果和失败共用一个窗口 + 300 条上限，
 * 唯一还能动手的那些失败记录会被成功记录挤掉。
 */
const KEEP_FAILED_MS = 7 * 24 * 3600_000;
const KEEP_SETTLED_MS = 2 * 24 * 3600_000;
const MAX_RECORDS = 500;
/** 刚办完的同一条不重复排：监控重来一轮（pullMode=all）会把同一批文件再报一遍 */
export const RECENT_DONE_MS = 24 * 3600_000;

export function listCopies(): CopyRecord[] {
  const rows = readKv<CopyRecord[]>(QUEUE_KEY);
  return Array.isArray(rows) ? rows : [];
}

export function saveCopies(rows: CopyRecord[], now = Date.now()): void {
  const kept = rows
    .filter((c) => {
      if (c.status === "pending") return true;
      const age = now - (c.doneAt ?? c.addedAt);
      return age < (c.status === "failed" ? KEEP_FAILED_MS : KEEP_SETTLED_MS);
    })
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, MAX_RECORDS);
  writeKv(QUEUE_KEY, kept);
}

/** 同一个来源、同一个目标 */
export function sameTarget(a: Pick<CopyRecord, "account" | "srcDir" | "name" | "dstDir">, b: Pick<CopyRecord, "account" | "srcDir" | "name" | "dstDir">): boolean {
  return a.account === b.account && a.srcDir === b.srcDir && a.name === b.name && a.dstDir === b.dstDir;
}

/**
 * 已经排着一条一样的、或者刚复制完没多久，就不重复登记。
 * 重试（retryCopy）走的是另一条路，不看这里。
 */
export function isDuplicate(rows: CopyRecord[], next: CopyRecord, now = Date.now()): boolean {
  return rows.some(
    (r) => sameTarget(r, next) && (r.status === "pending" || ((r.status === "done" || r.status === "skipped") && now - (r.doneAt ?? 0) < RECENT_DONE_MS)),
  );
}

export const hasPendingCopies = (): boolean => listCopies().some((c) => c.status === "pending");

/** 仅供测试 / 重置：清空队列 */
export function clearCopies(): void {
  writeKv(QUEUE_KEY, []);
}

/**
 * 整理把任务下的目录挪走后，队列里**还没提交**的待办跟着改（同 rewriteOfflineSubPaths / rewriteFollowSubPaths）。
 * 已经提交给 OpenList 的不动：源路径改了也追不回来，让它按 OpenList 的报错自然结束，用户可以重试。
 * 记录里存的是网盘绝对路径，而 mappings 是任务相对的，所以要先脱掉 originPath 再拼回去。
 * dryRun 只返回会受影响的相对路径。
 */
export function rewriteCopyPaths(
  taskId: string,
  originPath: string,
  mappings: Array<{ from: string; to: string }>,
  dryRun = false,
): string[] {
  const rows = listCopies();
  const root = originPath.replace(/^\/+|\/+$/g, "");
  const hit: string[] = [];
  let changed = false;
  for (const c of rows) {
    if (c.taskId !== taskId || c.status !== "pending" || c.stage !== "waiting") continue;
    const abs = c.srcDir.replace(/^\/+/, "");
    const rel = root === "" ? abs : abs === root ? "" : abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null;
    if (rel === null) continue;
    if (dryRun) {
      hit.push(rel);
      continue;
    }
    const m = mappings.find((x) => rel === x.from || rel.startsWith(`${x.from}/`));
    if (!m) continue;
    hit.push(rel);
    const nextRel = rel === m.from ? m.to : `${m.to}${rel.slice(m.from.length)}`;
    c.srcDir = root === "" ? `/${nextRel}` : `/${root}/${nextRel}`.replace(/\/+$/, "");
    changed = true;
  }
  if (changed) saveCopies(rows);
  return hit;
}

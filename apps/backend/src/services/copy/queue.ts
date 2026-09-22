/**
 * 「复制到 OpenList」的队列：记录形状、落库、去重、裁剪。
 *
 * 和云下载回执一样落在 settings 表的一个键里（`copy.queue`），进程重启不丢。
 * 不碰网络，纯读写 + 计算，好测。
 *
 * **写法上有一条硬要求**：推进队列的循环里夹着好几秒的网络等待，这期间监控 / 转存 / 追更
 * 随时会往同一个键里加记录，界面也可能重试或删掉某一条。所以绝不能「开头读一份、结尾整份写回」，
 * 那样会把期间别人写的东西整片抹掉。循环里的改动一律走 commitCopies（重读、按 id 合并、再写）。
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
  /** 目标目录（OpenList 绝对路径）= dstBase + 源路径相对 rootPath 的那段层级 */
  dstDir: string;
  /** 目标的根（设置里的默认目标目录，或任务 / 这一次指定的）；整理挪了目录之后靠它重算 dstDir */
  dstBase: string;
  /** 源路径相对哪个根算层级（通常是任务的 originPath）；没有就是平铺 */
  rootPath?: string;
  /** 触发时的同步任务；没有就是空串 */
  taskId: string;
  trigger: CopyTrigger;
  /** 复制成功后把网盘上那份删掉（搬运）。登记时按任务设置冻结，之后改设置不影响在途的 */
  deleteSource?: boolean;
  /** 升级时从老的云下载回执接管过来的：只有 OpenList 任务 id，没有网盘路径 */
  adopted?: boolean;
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
  /** 用户点过「重试」：目标里已经有同名的时候不再当「复制过了」悄悄跳过 */
  retried?: boolean;
}

const QUEUE_KEY = KEY.copyQueue;
/**
 * 失败的留 7 天、办完的留 2 天，**只对办完 / 失败的**限 500 条。
 * 分开留是因为监控是一个文件一条记录：一季 40 集成功之后，如果和失败共用一个窗口 + 一个上限，
 * 唯一还能动手的那些失败记录会被挤掉。上限也不能套在 pending 上——一次大批量入队
 * 会把还在跑的（甚至已经提交给 OpenList 的）挤出去，那些复制就再没人跟了。
 */
const KEEP_FAILED_MS = 7 * 24 * 3600_000;
const KEEP_SETTLED_MS = 2 * 24 * 3600_000;
/** 办完 / 跳过的上限；失败的单独算，不然一批成功就把能动手的那些冲没了 */
const MAX_SETTLED_RECORDS = 500;
const MAX_FAILED_RECORDS = 200;
/** 刚办完的同一条不重复排：监控重来一轮（pullMode=all）会把同一批文件再报一遍 */
export const RECENT_DONE_MS = 24 * 3600_000;

export function listCopies(): CopyRecord[] {
  const rows = readKv<CopyRecord[]>(QUEUE_KEY);
  return Array.isArray(rows) ? rows : [];
}

/** 整份写回。只给「这一份就是全部」的调用方（登记、接管、重置）用，循环里别用 */
export function saveCopies(rows: CopyRecord[], now = Date.now()): void {
  const pending: CopyRecord[] = [];
  const failed: CopyRecord[] = [];
  const settled: CopyRecord[] = [];
  for (const c of rows) {
    if (c.status === "pending") pending.push(c);
    else if (c.status === "failed") {
      if (now - (c.doneAt ?? c.addedAt) < KEEP_FAILED_MS) failed.push(c);
    } else if (now - (c.doneAt ?? c.addedAt) < KEEP_SETTLED_MS) settled.push(c);
  }
  const newest = (a: CopyRecord, b: CopyRecord) => b.addedAt - a.addedAt;
  failed.sort(newest);
  settled.sort(newest);
  writeKv(
    QUEUE_KEY,
    [...pending, ...failed.slice(0, MAX_FAILED_RECORDS), ...settled.slice(0, MAX_SETTLED_RECORDS)].sort(newest),
  );
}

/**
 * 把改过的记录合并回库：重读一份、按 id 覆盖，别人期间新加的照旧留着、删掉的不复活。
 * 读—改—写之间没有 await，对别的 JS 代码是原子的。
 */
export function commitCopies(changed: CopyRecord[], now = Date.now()): void {
  if (changed.length === 0) return;
  const byId = new Map(listCopies().map((r) => [r.id, r]));
  let touched = false;
  for (const c of changed) {
    if (!byId.has(c.id)) continue; // 期间被删掉了，不复活
    byId.set(c.id, c);
    touched = true;
  }
  if (touched) saveCopies([...byId.values()], now);
}

/** 同一个来源、同一个目标 */
function sameTarget(
  a: Pick<CopyRecord, "account" | "srcDir" | "name" | "dstDir">,
  b: Pick<CopyRecord, "account" | "srcDir" | "name" | "dstDir">,
): boolean {
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

/**
 * 整理把任务下的东西改名 / 挪走之后，队列里**还没提交**的待办跟着改
 * （同 rewriteOfflineSubPaths / rewriteFollowSubPaths）。已经提交给 OpenList 的不动：
 * 源路径改了也追不回来，让它按 OpenList 的结果自然结束，用户可以重试。
 *
 * mappings 是**任务相对**的整条路径（目录或文件都行），记录里存的是网盘绝对路径，
 * 所以先脱掉 originPath、改完再拼回去；目标目录按 dstBase 重算，免得停在改名前的层级上。
 * dryRun 只返回会受影响的相对路径。
 */
export function rewriteCopyPaths(
  taskId: string,
  originPath: string,
  mappings: Array<{ from: string; to: string }>,
  dryRun = false,
  layout?: (dstBase: string, rootPath: string | undefined, srcPath: string) => string,
): string[] {
  const rows = listCopies();
  const root = originPath.replace(/^\/+|\/+$/g, "");
  const hit: string[] = [];
  const changed: CopyRecord[] = [];
  for (const c of rows) {
    if (c.taskId !== taskId || c.status !== "pending" || c.stage !== "waiting") continue;
    const abs = `${c.srcDir.replace(/^\/+|\/+$/g, "")}/${c.name}`;
    const rel = root === "" ? abs : abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null;
    if (rel === null) continue;
    if (dryRun) {
      hit.push(rel);
      continue;
    }
    // 整条路径命中（文件自己被改名）或它上面某一层目录被挪走，都要跟着改
    const m = mappings.find((x) => rel === x.from || rel.startsWith(`${x.from}/`));
    if (!m) continue;
    hit.push(rel);
    const nextRel = rel === m.from ? m.to : `${m.to}${rel.slice(m.from.length)}`;
    const nextAbs = root === "" ? `/${nextRel}` : `/${root}/${nextRel}`;
    const segs = nextAbs.split("/").filter(Boolean);
    c.name = segs.pop() ?? c.name;
    c.srcDir = segs.length ? `/${segs.join("/")}` : "/";
    if (layout) c.dstDir = layout(c.dstBase, c.rootPath, nextAbs);
    changed.push(c);
  }
  if (changed.length > 0) commitCopies(changed);
  return hit;
}

/** 仅供测试 / 重置：清空队列 */
export function clearCopies(): void {
  writeKv(QUEUE_KEY, []);
}

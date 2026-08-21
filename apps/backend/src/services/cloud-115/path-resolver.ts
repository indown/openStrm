/**
 * 115 cid/file_id → 绝对网盘路径 的解析器。
 *
 * 生活事件里只有 parent_id，没有路径，所以每条事件都要先把 cid 还原成路径。
 * 三级回退：内存 LRU → path_cache 表 → 115 接口。
 * 走接口时一次拿回整条祖先链，把每一级都写进缓存，后续同目录的事件就不再打接口了。
 */
import { LRUCache } from "lru-cache";
import type { AccountInfo } from "./client.js";
import { fetchAncestors } from "./life.js";
import {
  getPathCacheRow,
  upsertPathCache,
  type PathCacheInput,
} from "../../db/repositories/life.js";

const memo = new LRUCache<string, string>({ max: 20_000, ttl: 30 * 60 * 1000 });

function memoKey(accountName: string, fileId: string): string {
  return `${accountName}:${fileId}`;
}

/** 115 的路径分隔符是 /，文件名里出现的 / 需要转义，和全量任务的处理保持一致 */
function sanitizeName(name: string): string {
  return name.replace(/\//g, "\\/");
}

export function joinPanPath(dir: string, name: string): string {
  const base = dir === "/" ? "" : dir.replace(/\/+$/, "");
  return `${base}/${sanitizeName(name)}`;
}

/** 主动写入一条 id → path 映射（新增/改名/移动后调用，让后续事件能查到旧路径） */
export function rememberPath(entry: PathCacheInput): void {
  upsertPathCache([entry]);
  memo.set(memoKey(entry.accountName, entry.fileId), entry.path);
}

export function rememberPaths(entries: PathCacheInput[]): void {
  upsertPathCache(entries);
  for (const e of entries) memo.set(memoKey(e.accountName, e.fileId), e.path);
}

/** 只查缓存，不打接口。用于 move/rename 找旧路径——查不到就是查不到，不该为此发请求 */
export function lookupCachedPath(accountName: string, fileId: string): string | null {
  const id = String(fileId);
  if (id === "0" || id === "") return "/";
  const hit = memo.get(memoKey(accountName, id));
  if (hit) return hit;
  const row = getPathCacheRow(id);
  if (row?.path) {
    memo.set(memoKey(accountName, id), row.path);
    return row.path;
  }
  return null;
}

export function forgetPath(accountName: string, fileId: string): void {
  memo.delete(memoKey(accountName, String(fileId)));
}

/** 清空内存层（DB 层由调用方决定是否一起清） */
export function clearPathMemo(): void {
  memo.clear();
}

/**
 * 把目录 cid 解析成绝对路径，必要时打接口。
 * 返回 null 表示目录已不存在或接口拿不到（调用方应跳过该事件而不是猜路径）。
 */
export async function resolveDirPath(
  accountInfo: AccountInfo,
  cid: string,
): Promise<string | null> {
  const id = String(cid);
  if (id === "0" || id === "") return "/";

  const cached = lookupCachedPath(accountInfo.name, id);
  if (cached) return cached;

  const ancestors = await fetchAncestors(accountInfo, id);
  if (!ancestors || ancestors.length === 0) return null;

  // ancestors[0] 是根（cid=0，name 为空），逐级拼出每一层的绝对路径并一次性缓存
  const rows: PathCacheInput[] = [];
  let acc = "";
  for (const a of ancestors) {
    if (a.cid === "0") {
      acc = "";
      continue;
    }
    acc = `${acc}/${sanitizeName(a.name)}`;
    rows.push({
      fileId: a.cid,
      parentId: a.pid,
      name: a.name,
      path: acc,
      isDir: true,
      accountName: accountInfo.name,
    });
  }
  if (rows.length === 0) return "/";
  rememberPaths(rows);

  const self = rows.find((r) => r.fileId === id);
  return self?.path ?? null;
}

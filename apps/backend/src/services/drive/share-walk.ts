/**
 * 分享内按路径逐级找条目：两家的分享接口都只按目录 id 列，没有路径接口。
 * 中间段必须是目录；最后一段文件、目录都行。找不到返回 null。
 */
import type { ShareEntry, ShareProvider, ShareSession } from "./types.js";
import { splitPath } from "./types.js";

export async function listWholeShareDir(share: ShareProvider, session: ShareSession, dirId: string, signal?: AbortSignal): Promise<ShareEntry[]> {
  const out: ShareEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await share.list(session, dirId, cursor, { signal });
    out.push(...page.entries);
    if (!page.next || page.entries.length === 0) return out;
    cursor = page.next;
  }
}

export async function resolveSharePath(share: ShareProvider, session: ShareSession, path: string, signal?: AbortSignal): Promise<ShareEntry | null> {
  const segs = splitPath(path);
  if (segs.length === 0) return null;
  let dirId = "0";
  let hit: ShareEntry | null = null;
  for (let i = 0; i < segs.length; i++) {
    const isLast = i === segs.length - 1;
    const entries = await listWholeShareDir(share, session, dirId, signal);
    hit = entries.find((e) => e.name.trim() === segs[i] && (isLast || e.isDir)) ?? null;
    if (!hit) return null;
    dirId = hit.id;
  }
  return hit;
}

/**
 * 从收藏夹转存过什么：转存（界面、智能体都走 saveSelectionToTask）成功以后，按分享码 + 条目 id 找到收藏夹里对应的作品单元记一笔，
 * 收藏夹里这部作品就显示「已经有了」（另一个来源是本地 strm 目录里认得出 tmdbId 的，见 owned.ts）。
 *
 * 存的是单元自己的目录、它的上级目录，或者它下面的一部分（某一季、几个文件），都算存过这个单元；
 * 散放在分类目录里的那种单元（没有自己的目录）只认存了它的文件、或者存了它所在的目录（及以上）
 */
import { getNode } from "../../db/repositories/library-nodes.js";
import { recordSaves, unitsOfSource } from "../../db/repositories/library-units.js";
import { listByShareCode } from "../../db/repositories/media-library.js";

const under = (child: string, parent: string) => parent === "" || child === parent || child.startsWith(`${parent}/`);

/** 记下来的单元个数（这个分享不在收藏夹里就是 0） */
export function recordLibrarySave(
  opts: { shareCode: string; itemIds: string[]; taskId: string; subPath: string },
  now = Math.floor(Date.now() / 1000),
): number {
  const ids = new Set(opts.itemIds);
  const rows: Array<{ sourceId: string; unitKey: string; taskId: string; subPath: string }> = [];
  for (const source of listByShareCode(opts.shareCode)) {
    const paths = [...ids].map((id) => getNode(source.id, id)?.path).filter((p): p is string => p !== undefined);
    if (paths.length === 0) continue;
    for (const u of unitsOfSource(source.id)) {
      if (u.status === "ignored") continue;
      const hit = u.ownsDir ? paths.some((p) => under(u.path, p) || under(p, u.path)) : u.fileIds.some((f) => ids.has(f)) || paths.some((p) => under(u.path, p));
      if (hit) rows.push({ sourceId: source.id, unitKey: u.unitKey, taskId: opts.taskId, subPath: opts.subPath });
    }
  }
  recordSaves(rows, now);
  return rows.length;
}

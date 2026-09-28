/**
 * 影库索引的节点：来源下抄来的目录树。热路径（一次写几百个子节点、搜索）直接用 better-sqlite3 的预编译语句。
 * 语句用到时才准备：模块可能在迁移跑完之前就被引进来。
 */
import type { Statement } from "better-sqlite3";
import { sqlite } from "../client.js";

export interface NodeRow {
  sourceId: string;
  nodeId: string;
  parentId: string;
  name: string;
  path: string;
  isDir: boolean;
  depth: number;
  size: number | null;
  token: string | null;
  gen: number;
  listedGen: number;
  videoCount: number;
  videoTotal: number;
  missing: boolean;
  searchText: string;
}

interface RawNode {
  source_id: string;
  node_id: string;
  parent_id: string;
  name: string;
  path: string;
  is_dir: number;
  depth: number;
  size: number | null;
  token: string | null;
  gen: number;
  listed_gen: number;
  video_count: number;
  video_total: number;
  missing: number;
  search_text: string;
}

function toNode(r: RawNode): NodeRow {
  return {
    sourceId: r.source_id,
    nodeId: r.node_id,
    parentId: r.parent_id,
    name: r.name,
    path: r.path,
    isDir: r.is_dir === 1,
    depth: r.depth,
    size: r.size,
    token: r.token,
    gen: r.gen,
    listedGen: r.listed_gen,
    videoCount: r.video_count,
    videoTotal: r.video_total ?? 0,
    missing: r.missing === 1,
    searchText: r.search_text,
  };
}

const stmts = new Map<string, Statement>();
function stmt(key: string, sql: string): Statement {
  let s = stmts.get(key);
  if (!s) {
    s = sqlite.prepare(sql);
    stmts.set(key, s);
  }
  return s;
}

/** 写一个节点（子节点入库、来源根入库都走它） */
export interface NodeInput {
  nodeId: string;
  parentId: string;
  name: string;
  path: string;
  isDir: boolean;
  depth: number;
  size: number | null;
  token: string | null;
  /** 目录：路径 + 名字的 search_text（列过下一层后再补文件名）；文件留空 */
  searchText: string;
}

/**
 * 批量写节点，同一轮（gen）。已有的节点：名字 / 路径没变的目录保留上一轮的 search_text、大小和视频数
 * （刷新期间还没重新列到它，按文件名也照样搜得到）；名字或路径变了的用新的。
 * 同一轮里标了 missing 的保持 missing（重列上一级时它还在列表里，但进不去），下一轮再试
 */
export function upsertNodes(sourceId: string, gen: number, nodes: NodeInput[]): void {
  if (nodes.length === 0) return;
  const s = stmt(
    "upsert",
    `INSERT INTO library_nodes (source_id, node_id, parent_id, name, path, is_dir, depth, size, token, gen, listed_gen, video_count, missing, search_text)
     VALUES (@sourceId, @nodeId, @parentId, @name, @path, @isDir, @depth, @size, @token, @gen, 0, 0, 0, @searchText)
     ON CONFLICT(source_id, node_id) DO UPDATE SET
       parent_id = excluded.parent_id,
       is_dir = excluded.is_dir,
       depth = excluded.depth,
       token = excluded.token,
       gen = excluded.gen,
       missing = CASE WHEN library_nodes.gen = excluded.gen THEN library_nodes.missing ELSE 0 END,
       size = CASE WHEN excluded.is_dir = 1 AND library_nodes.name = excluded.name AND library_nodes.path = excluded.path THEN library_nodes.size ELSE excluded.size END,
       video_count = CASE WHEN library_nodes.name = excluded.name AND library_nodes.path = excluded.path THEN library_nodes.video_count ELSE 0 END,
       search_text = CASE WHEN library_nodes.name = excluded.name AND library_nodes.path = excluded.path AND library_nodes.search_text <> '' THEN library_nodes.search_text ELSE excluded.search_text END,
       name = excluded.name,
       path = excluded.path`,
  );
  const tx = sqlite.transaction((rows: NodeInput[]) => {
    for (const n of rows) {
      s.run({ sourceId, gen, ...n, isDir: n.isDir ? 1 : 0 });
    }
  });
  tx(nodes);
}

/** 本轮还没列过下一层的目录里最浅的一个（宽度优先；同层按路径排） */
export function nextUnlistedDir(sourceId: string, gen: number): NodeRow | null {
  const r = stmt(
    "nextUnlisted",
    `SELECT * FROM library_nodes WHERE source_id = ? AND is_dir = 1 AND gen = ? AND listed_gen < ? AND missing = 0
     ORDER BY depth, path LIMIT 1`,
  ).get(sourceId, gen, gen) as RawNode | undefined;
  return r ? toNode(r) : null;
}

/**
 * 列完一个目录：补上文件名进 search_text、直接视频数，记这一轮列过了。
 * 大小先填直接放着的文件合计（作品目录这就是准数，还在抄的时候搜出来也有大小）；抄完 finalizeSizes 换成整棵子树的，
 * 刷新时已经有上一轮的合计就不动
 */
export function markListed(sourceId: string, nodeId: string, gen: number, searchText: string, videoCount: number, directSize = 0): void {
  stmt(
    "markListed",
    `UPDATE library_nodes SET listed_gen = ?, search_text = ?, video_count = ?, size = COALESCE(size, ?) WHERE source_id = ? AND node_id = ?`,
  ).run(gen, searchText, videoCount, directSize, sourceId, nodeId);
}

/** 本轮的进度：发现了几个目录、列过几个、节点一共多少 */
export function crawlProgress(sourceId: string, gen: number): { dirsTotal: number; dirsListed: number; nodes: number } {
  const r = stmt(
    "progress",
    `SELECT
       SUM(CASE WHEN is_dir = 1 THEN 1 ELSE 0 END) AS dirs,
       SUM(CASE WHEN is_dir = 1 AND listed_gen = ? THEN 1 ELSE 0 END) AS listed,
       COUNT(*) AS nodes
     FROM library_nodes WHERE source_id = ? AND gen = ?`,
  ).get(gen, sourceId, gen) as { dirs: number | null; listed: number | null; nodes: number };
  return { dirsTotal: r.dirs ?? 0, dirsListed: r.listed ?? 0, nodes: r.nodes };
}

/** 刷新抄完：上一轮有、这一轮没抄到的（分享里删了）清掉 */
export function deleteStale(sourceId: string, gen: number): number {
  return stmt("deleteStale", `DELETE FROM library_nodes WHERE source_id = ? AND gen < ?`).run(sourceId, gen).changes;
}

export function deleteAll(sourceId: string): void {
  stmt("deleteAll", `DELETE FROM library_nodes WHERE source_id = ?`).run(sourceId);
}

/** 抄完回填：目录的子树大小、子树视频数；返回整个来源的统计 */
export function finalizeSizes(sourceId: string, isVideo: (name: string) => boolean): { nodeCount: number; videoCount: number; totalSize: number } {
  const rows = stmt(
    "allForSizes",
    `SELECT node_id, parent_id, is_dir, size, depth, name FROM library_nodes WHERE source_id = ? AND missing = 0`,
  ).all(sourceId) as Array<{ node_id: string; parent_id: string; is_dir: number; size: number | null; depth: number; name: string }>;
  const sizes = new Map<string, number>();
  const videos = new Map<string, number>();
  let videoCount = 0;
  // 从深到浅：文件的大小、是不是视频加到父目录，目录的合计再往上加
  const ordered = [...rows].sort((a, b) => b.depth - a.depth);
  for (const r of ordered) {
    const dir = r.is_dir === 1;
    const own = dir ? (sizes.get(r.node_id) ?? 0) : (r.size ?? 0);
    const ownVideos = dir ? (videos.get(r.node_id) ?? 0) : isVideo(r.name) ? 1 : 0;
    if (dir) {
      sizes.set(r.node_id, own);
      videos.set(r.node_id, ownVideos);
    } else videoCount += ownVideos;
    if (r.parent_id) {
      sizes.set(r.parent_id, (sizes.get(r.parent_id) ?? 0) + own);
      videos.set(r.parent_id, (videos.get(r.parent_id) ?? 0) + ownVideos);
    }
  }
  const update = stmt("setSize", `UPDATE library_nodes SET size = ?, video_total = ? WHERE source_id = ? AND node_id = ?`);
  const tx = sqlite.transaction(() => {
    for (const r of rows) if (r.is_dir === 1) update.run(sizes.get(r.node_id) ?? 0, videos.get(r.node_id) ?? 0, sourceId, r.node_id);
  });
  tx();
  const root = rows.find((r) => r.depth === 0);
  return { nodeCount: rows.length, videoCount, totalSize: root ? (sizes.get(root.node_id) ?? 0) : 0 };
}

/**
 * 按库里已有的目录树重算一个来源所有目录的 search_text（归一化规则变了用，不用重抄网盘）。
 * compute 和抄目录时同一个口径：路径各段（整个分享的根用它自己的名字）+ 直接文件名
 */
export function rebuildSearchTexts(sourceId: string, compute: (pathSegments: string[], fileNames: string[]) => string): number {
  const rows = stmt(
    "allForText",
    `SELECT node_id, parent_id, is_dir, depth, path, name FROM library_nodes WHERE source_id = ?`,
  ).all(sourceId) as Array<{ node_id: string; parent_id: string; is_dir: number; depth: number; path: string; name: string }>;
  const files = new Map<string, string[]>();
  for (const r of rows) {
    if (r.is_dir === 1) continue;
    const list = files.get(r.parent_id) ?? [];
    list.push(r.name);
    files.set(r.parent_id, list);
  }
  const update = stmt("setText", `UPDATE library_nodes SET search_text = ? WHERE source_id = ? AND node_id = ?`);
  let n = 0;
  const tx = sqlite.transaction(() => {
    for (const r of rows) {
      if (r.is_dir !== 1) continue;
      const segs = r.depth === 0 && !r.path ? [r.name] : r.path.split("/");
      update.run(compute(segs, files.get(r.node_id) ?? []), sourceId, r.node_id);
      n++;
    }
  });
  tx();
  return n;
}

/** 直接放着视频的目录有几个：抄完判断「是不是一部作品」（一部才去刮海报，整包不刮） */
export function countVideoDirs(sourceId: string): number {
  const r = stmt("videoDirs", `SELECT COUNT(*) AS n FROM library_nodes WHERE source_id = ? AND is_dir = 1 AND video_count > 0 AND missing = 0`).get(sourceId) as { n: number };
  return r.n;
}

export function getNode(sourceId: string, nodeId: string): NodeRow | null {
  const r = stmt("getNode", `SELECT * FROM library_nodes WHERE source_id = ? AND node_id = ?`).get(sourceId, nodeId) as RawNode | undefined;
  return r ? toNode(r) : null;
}

/** 一个目录下的直接子节点 */
export function childrenOf(sourceId: string, parentId: string): NodeRow[] {
  return (stmt("children", `SELECT * FROM library_nodes WHERE source_id = ? AND parent_id = ? AND missing = 0`).all(sourceId, parentId) as RawNode[]).map(toNode);
}

/** 这个目录连同子孙标成打不开了（分享还在，上传者删了 / 挪了） */
export function markMissing(sourceId: string, node: Pick<NodeRow, "nodeId" | "path">): void {
  stmt(
    "markMissing",
    `UPDATE library_nodes SET missing = 1 WHERE source_id = ? AND (node_id = ? OR substr(path, 1, ?) = ?)`,
  ).run(sourceId, node.nodeId, node.path.length + 1, `${node.path}/`);
}

/** 让一个目录下一轮重新列（它的子节点不对了） */
export function markUnlisted(sourceId: string, nodeId: string): void {
  stmt("markUnlisted", `UPDATE library_nodes SET listed_gen = 0 WHERE source_id = ? AND node_id = ?`).run(sourceId, nodeId);
}

/** 这个分享码下哪些来源收着这个节点（分享观察者报「这个目录打不开」时用） */
export function findNode(shareCode: string, nodeId: string): NodeRow[] {
  return (
    stmt(
      "findNode",
      `SELECT n.* FROM library_nodes n JOIN media_library s ON s.id = n.source_id WHERE s.share_code = ? AND n.node_id = ?`,
    ).all(shareCode, nodeId) as RawNode[]
  ).map(toNode);
}

/* ------------------------------- 搜索 ------------------------------- */

export interface SearchRow extends NodeRow {
  shareCode: string;
  shareUrl: string;
  shareTitle: string;
  sourceTitle: string;
  sourcePath: string;
  indexedAt: number | null;
  shareStatus: string | null;
  shareReason: string | null;
  checkedAt: number | null;
  expiredAt: number | null;
}

/**
 * 候选：每个词都要在 search_text 里（LIKE 子串）。词已经归一化过，没有 % _ 这类通配符，也不会跨段。
 * 只要目录；打不开的（missing）不要。limit 封顶，排序、收拢在上层做
 */
export function searchCandidates(terms: string[], limit: number, sourceId?: string): SearchRow[] {
  if (terms.length === 0) return [];
  const where = terms.map(() => "n.search_text LIKE ?").join(" AND ");
  const params: unknown[] = terms.map((t) => `%${t}%`);
  const scope = sourceId ? " AND n.source_id = ?" : "";
  if (sourceId) params.push(sourceId);
  params.push(limit);
  const rows = sqlite
    .prepare(
      `SELECT n.*, s.share_code AS share_code, s.share_url AS share_url, s.share_title AS share_title, s.title AS source_title,
              s.share_path AS source_path, s.indexed_at AS indexed_at,
              h.status AS share_status, h.reason AS share_reason, h.checked_at AS checked_at, h.expired_at AS expired_at
       FROM library_nodes n
       JOIN media_library s ON s.id = n.source_id
       LEFT JOIN library_shares h ON h.share_code = s.share_code
       WHERE n.is_dir = 1 AND n.missing = 0 AND ${where}${scope}
       LIMIT ?`,
    )
    .all(...params) as Array<
    RawNode & {
      share_code: string;
      share_url: string;
      share_title: string;
      source_title: string;
      source_path: string;
      indexed_at: number | null;
      share_status: string | null;
      share_reason: string | null;
      checked_at: number | null;
      expired_at: number | null;
    }
  >;
  return rows.map((r) => ({
    ...toNode(r),
    shareCode: r.share_code,
    shareUrl: r.share_url,
    shareTitle: r.share_title,
    sourceTitle: r.source_title,
    sourcePath: r.source_path,
    indexedAt: r.indexed_at,
    shareStatus: r.share_status,
    shareReason: r.share_reason,
    checkedAt: r.checked_at,
    expiredAt: r.expired_at,
  }));
}

function childrenOfDirs(sourceId: string, dirIds: string[], isDir: boolean): NodeRow[] {
  if (dirIds.length === 0) return [];
  const out: NodeRow[] = [];
  // SQLite 的参数个数有上限：分批
  for (let i = 0; i < dirIds.length; i += 400) {
    const batch = dirIds.slice(i, i + 400);
    const rows = sqlite
      .prepare(
        `SELECT * FROM library_nodes WHERE source_id = ? AND is_dir = ? AND missing = 0 AND parent_id IN (${batch.map(() => "?").join(",")})`,
      )
      .all(sourceId, isDir ? 1 : 0, ...batch) as RawNode[];
    out.push(...rows.map(toNode));
  }
  return out;
}

/** 一批目录的直接文件（结果里挑视频文件名、给人判断） */
export function filesOfDirs(sourceId: string, dirIds: string[]): NodeRow[] {
  return childrenOfDirs(sourceId, dirIds, false);
}

/** 一批目录的直接子目录（剧目录下的季目录：结果里报名字、挑样例文件） */
export function subdirsOfDirs(sourceId: string, dirIds: string[]): NodeRow[] {
  return childrenOfDirs(sourceId, dirIds, true);
}

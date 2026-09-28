/**
 * 测试用：直接往影库里种一个抄完的来源（不走抄目录），分享标成刚查过——搜索时不会真去问网盘。
 */
import { dirSearchText, isVideoName } from "../services/library/search-text.js";
import { freshIndexFields, insert, remove } from "../db/repositories/media-library.js";
import { finalizeSizes, markListed, upsertNodes, type NodeInput } from "../db/repositories/library-nodes.js";
import { deleteShareIfUnused, ensureShare, updateShare } from "../db/repositories/library-shares.js";

export interface SeedSource {
  id: string;
  shareCode: string;
  shareUrl: string;
  shareTitle: string;
  /** 分享内的文件路径（不带前导 /）→ 大小；目录按路径自动建 */
  files: Record<string, number>;
  /** 分享死活，缺省 ok */
  status?: "ok" | "suspect" | "expired" | "locked" | "unknown";
}

export function seedLibrarySource(src: SeedSource): void {
  const now = Math.floor(Date.now() / 1000);
  insert({
    id: src.id,
    shareUrl: src.shareUrl,
    shareCode: src.shareCode,
    receiveCode: "",
    sharePath: "",
    shareRootCid: "",
    rawName: src.shareTitle,
    title: src.shareTitle,
    fileCount: 0,
    coverUrl: "",
    tags: [],
    notes: "",
    mediaType: "unknown",
    tmdbId: null,
    year: "",
    overview: "",
    scrapeStatus: "done",
    createdAt: now,
    updatedAt: now,
    shareTitle: src.shareTitle,
    ...freshIndexFields(),
    indexStatus: "done",
    indexedAt: now,
  });
  ensureShare(src.shareCode, "115");
  updateShare(src.shareCode, { status: src.status ?? "ok", checkedAt: now, lastOkAt: now, ...(src.status === "expired" ? { expiredAt: now } : {}) });

  // 目录按路径建；id 用路径本身（测试里够用）
  const dirs = new Map<string, NodeInput>();
  dirs.set("", { nodeId: "0", parentId: "", name: src.shareTitle, path: "", isDir: true, depth: 0, size: null, token: null, searchText: dirSearchText([src.shareTitle]) });
  const files: NodeInput[] = [];
  for (const [path, size] of Object.entries(src.files)) {
    const segs = path.split("/");
    for (let i = 1; i < segs.length; i++) {
      const p = segs.slice(0, i).join("/");
      if (!dirs.has(p)) {
        const parent = segs.slice(0, i - 1).join("/");
        dirs.set(p, { nodeId: `d:${p}`, parentId: parent ? `d:${parent}` : "0", name: segs[i - 1], path: p, isDir: true, depth: i, size: null, token: null, searchText: dirSearchText(segs.slice(0, i)) });
      }
    }
    const parent = segs.slice(0, -1).join("/");
    files.push({ nodeId: `f:${path}`, parentId: parent ? `d:${parent}` : "0", name: segs[segs.length - 1], path, isDir: false, depth: segs.length, size, token: null, searchText: "" });
  }
  upsertNodes(src.id, 1, [...dirs.values(), ...files]);
  for (const d of dirs.values()) {
    const own = files.filter((f) => f.parentId === d.nodeId);
    markListed(src.id, d.nodeId, 1, dirSearchText(d.path ? d.path.split("/") : [src.shareTitle], own.map((f) => f.name)), own.filter((f) => isVideoName(f.name)).length);
  }
  finalizeSizes(src.id, isVideoName);
}

export function unseedLibrarySource(id: string, shareCode: string): void {
  remove(id);
  deleteShareIfUnused(shareCode);
}

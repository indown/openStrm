import type { DriveProvider, SubtreeEntry } from "./types.js";

/**
 * 目录树里没有类型时按名字猜：带扩展名的当文件，其余当目录。
 * 和 115 导出树的判断（task/tree.ts 的 collectFilesAndTopEmptyDirs）用同一条规则，别处（整理、手动复制）都引这里的
 */
export const looksLikeFileName = (name: string): boolean => /\.[a-z0-9]+$/i.test(name);

/**
 * 整棵子树，路径相对 abs：有 walkSubtree 的网盘（夸克 / OpenList）带 id 和类型；
 * 115 只有文件路径 + 顶层空目录，中间每一级目录从路径里推出来、没有 id（要 id 的到用时再钉）
 */
export async function subtreeEntries(provider: DriveProvider, abs: string, opts: { id?: string; signal?: AbortSignal } = {}): Promise<SubtreeEntry[]> {
  if (provider.walkSubtree) return provider.walkSubtree(abs, opts);
  const seen = new Map<string, SubtreeEntry>();
  for (const p of await provider.listSubtree(abs, opts)) {
    const segs = p.split("/").filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join("/");
      if (!seen.has(dir)) seen.set(dir, { path: dir, id: "", isDir: true });
    }
    const rel = segs.join("/");
    if (rel && !seen.has(rel)) seen.set(rel, { path: rel, id: "", isDir: !looksLikeFileName(segs[segs.length - 1] ?? "") });
  }
  return [...seen.values()];
}

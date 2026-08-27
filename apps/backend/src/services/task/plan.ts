/**
 * 全量同步的对照计划：远端有什么、本地有什么 → 缺什么、多什么。
 *
 * 纯函数，不碰磁盘和网络，runner 只负责把两边的清单喂进来。
 * 单独抽出来是因为这里出过一次静默的错：strm 扩展名一度写死成 mp4/mp3/mkv，
 * 其余扩展名的文件每次都被同时判成"缺失"和"多余"——先删再重建，且永远报不出
 * "no files to download"。规则改动必须先过 plan.test.ts。
 */
import { extOf, localNameFor } from "../strm/naming.js";
import { collectFilesAndTopEmptyDirs, type TreeNode } from "./tree.js";

export interface SyncPlan {
  /** 远端有、本地没有、且属于 strm 或下载白名单的条目（远端相对路径） */
  missing: string[];
  /** 本地有、远端对不上的条目（本地相对路径） */
  extra: string[];
}

/** 把导出的目录树摊平成相对路径：文件 + 顶层空目录 */
export function flattenTree(tree: TreeNode[]): string[] {
  const entries: string[] = [];
  for (const node of tree) {
    if (node.children?.length) entries.push(...collectFilesAndTopEmptyDirs(node.children));
    else if (/\.[a-z0-9]+$/i.test(node.name)) entries.push(node.name);
  }
  return entries;
}

/**
 * @param remote 远端条目（相对路径，文件带原始扩展名，目录不带）
 * @param local  本地条目（相对路径，strm 类已经是 .strm）
 */
export function planSync(
  remote: string[],
  local: string[],
  strmExts: Set<string>,
  dlExts: Set<string>,
): SyncPlan {
  // 本地对照时，strm 类条目在本地叫 .strm，下载类和目录保持原名
  const expectedLocal = new Set(remote.map((p) => localNameFor(p, strmExts)));
  const localSet = new Set(local);
  // 白名单之外的远端文件既不会生成也不会下载，不能算"缺失"，否则永远同步不完
  const actionable = remote.filter((p) => strmExts.has(extOf(p)) || dlExts.has(extOf(p)));
  return {
    missing: actionable.filter((p) => !localSet.has(localNameFor(p, strmExts))),
    extra: local.filter((p) => !expectedLocal.has(p)),
  };
}

/**
 * 把「相对根的路径段」列表摊成同步视图：文件 + 没有文件的顶层空目录。
 * 口径和 115 导出树完全一致（collectFilesAndTopEmptyDirs），三家网盘的同步任务才能用同一套对照规则。
 */
import { buildTree, collectFilesAndTopEmptyDirs, TreeBuilder } from "../task/tree.js";

export function syncViewFromPaths(paths: Iterable<string[]>): string[] {
  const tree = new TreeBuilder();
  for (const segs of paths) if (segs.length > 0) tree.add(segs);
  return collectFilesAndTopEmptyDirs(buildTree(tree.nodes));
}

import path from "node:path";

// Resolve project root from this file's location: apps/backend/src/paths.ts → 3 levels up
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(new URL(".", import.meta.url).pathname, "../../../");

export const CONFIG_DIR = process.env.CONFIG_DIR || path.join(PROJECT_ROOT, "config");
export const DATA_DIR = process.env.DATA_DIR || path.join(PROJECT_ROOT, "data");

/**
 * 把用户给的相对路径解析到 DATA_DIR 之下；解析结果跑出 DATA_DIR（`../` 之类）就返回 null。
 *
 * 任务的 targetPath、清空目录、本地目录浏览都必须经过它——
 * 否则 `../config` 这样的值能把数据库整个删掉。
 */
export function resolveInDataDir(rel: string | undefined): string | null {
  const root = path.resolve(DATA_DIR);
  const target = path.resolve(root, rel ?? "");
  return target === root || target.startsWith(root + path.sep) ? target : null;
}

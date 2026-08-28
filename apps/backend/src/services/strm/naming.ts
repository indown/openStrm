/**
 * 远端文件 ↔ 本地文件的命名规则。全量任务、生活事件、分享转存三条链路共用，
 * 任何一处自己写替换逻辑，迟早会在"哪些扩展名算 strm"上分叉。
 */
import path from "node:path";

/** 扩展名白名单：统一小写、带点 */
export function extSet(list?: string[]): Set<string> {
  return new Set((list ?? []).map((e) => e.toLowerCase()));
}

export function extOf(p: string): string {
  return path.extname(p).toLowerCase();
}

/** 把扩展名换成 .strm；没有扩展名就直接加。只看最后一段，目录名里的点不受影响 */
export function toStrmPath(p: string): string {
  const ext = path.extname(p);
  return ext ? `${p.slice(0, -ext.length)}.strm` : `${p}.strm`;
}

/** 远端条目落到本地后的名字：strm 类换成 .strm，其余（下载类、目录）保持原名 */
export function localNameFor(remote: string, strmExts: Set<string>): string {
  return strmExts.has(extOf(remote)) ? toStrmPath(remote) : remote;
}

/** 用户填的子目录：去掉空段和首尾空白，`a//b / c` → `a/b/c` */
export function normalizeSubPath(input: string | undefined): string {
  return (input ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
}

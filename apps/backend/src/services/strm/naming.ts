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

/** 按路径段做 URL 编码，保留 `/`。encodeURI 不管 `# ? % + &`，文件名里带这些的 URL 照样是坏的 */
export function encodePathSegments(p: string): string {
  return p.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

/**
 * strm 文件的内容：`${前缀}/${网盘路径}`。
 * 开了路径编码时网盘路径按段 encodeURIComponent；前缀（`http://host:5244/d` 或 `/mnt/pan`）
 * 只过 encodeURI，scheme、host 和 `/` 都得留着。302 代理那头用 decodeURIComponent 还原，两种写法都认。
 */
export function strmContent(strmPrefix: string | undefined, remotePath: string, encode: boolean): string {
  const prefix = strmPrefix ?? "";
  return encode ? `${encodeURI(prefix)}/${encodePathSegments(remotePath)}` : `${prefix}/${remotePath}`;
}

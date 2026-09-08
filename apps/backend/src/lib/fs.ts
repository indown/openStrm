import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Dirent.isDirectory() 对符号链接返回 false；链接指向目录的也算目录（老代码用 statSync 时是这样） */
export async function isDirectoryEntry(parent: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await fsp.stat(path.join(parent, entry.name))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * dir 空了就删掉，再看它的父目录，直到 stopAt 为止（stopAt 本身不删，stopAt 之外的一律不碰）。
 * 非空或已不存在就停。全量任务清多余文件、生活事件删文件、strm 重建都用它。
 */
export async function removeEmptyParents(dir: string, stopAt: string): Promise<void> {
  if (dir === stopAt || !dir.startsWith(stopAt + path.sep)) return;
  try {
    if ((await fsp.readdir(dir)).length === 0) {
      await fsp.rmdir(dir);
      await removeEmptyParents(path.dirname(dir), stopAt);
    }
  } catch {
    /* 目录非空或已不存在，停止 */
  }
}

export interface WalkEntry {
  /** 相对 root 的 POSIX 路径 */
  rel: string;
  name: string;
  full: string;
  isDir: boolean;
}

/**
 * 深度优先遍历一棵目录树，每个目录里的条目按名字排序。
 * 只认 dirent.isDirectory()：符号链接一律当文件对待、不进入，既防环也防顺着链接跑出根目录。
 * root 不存在或读不了就什么都不产出。
 * @param skipDir 返回 true 的目录整棵跳过（连它本身也不产出）
 */
export async function* walkTree(
  root: string,
  opts: { skipDir?: (rel: string) => boolean } = {},
): AsyncGenerator<WalkEntry> {
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const dirFull = relDir ? path.join(root, ...relDir.split("/")) : root;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dirFull, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs: string[] = [];
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const isDir = e.isDirectory();
      if (isDir && opts.skipDir?.(rel)) continue;
      yield { rel, name: e.name, full: path.join(dirFull, e.name), isDir };
      if (isDir) subdirs.push(rel);
    }
    // 倒序压栈，弹出来就是字典序
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
}

/** 读小文本文件。超过 maxBytes 返回 null：strm 只有几百字节，误命名的大文件别整个读进内存 */
export async function readTextCapped(full: string, maxBytes: number): Promise<string | null> {
  const handle = await fsp.open(full, "r");
  try {
    const { size } = await handle.stat();
    if (size > maxBytes) return null;
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buf, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buf.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

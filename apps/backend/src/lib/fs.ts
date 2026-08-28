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

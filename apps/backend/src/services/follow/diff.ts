/**
 * 追更的对照规则：分享目录现在有什么 vs 快照里有什么 → 哪些要转存、哪些只记一笔。
 *
 * 纯函数，不碰网络和数据库；service 只负责把两边的清单喂进来。
 * 条目的身份是「相对路径 + sha1」：路径决定它会落在网盘和本地的哪里，sha1 认得出改名和搬家。
 * 规则改动先过 diff.test.ts。
 */
import type { ShareFollowEntry } from "@openstrm/shared";

/** 现在列出来的一条：比快照多一个分享侧的 file id，转存要用 */
export interface ListedEntry extends ShareFollowEntry {
  id: string;
}

export interface FollowDiff {
  /** 要转存的：新文件，以及整个新目录（目录里的东西随目录一起来，不再单列） */
  added: ListedEntry[];
  /** 同一路径 sha1 变了：分享者换了文件。只记一笔，不动网盘里的那份 */
  replaced: ListedEntry[];
  /** 路径是新的但 sha1 早就有：改名或搬家。只记一笔，不再转存一份 */
  moved: ListedEntry[];
}

const depthOf = (p: string): number => p.split("/").length;
const isUnder = (p: string, dir: string): boolean => p.startsWith(`${dir}/`);

export const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
export const parentOf = (p: string): string => {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? "" : p.slice(0, idx);
};

export function diffShareListing(known: ShareFollowEntry[], current: ListedEntry[]): FollowDiff {
  const knownByPath = new Map(known.map((e) => [e.path, e]));
  const knownSha = new Set(known.filter((e) => !e.isDir && e.sha1).map((e) => e.sha1 as string));
  const added: ListedEntry[] = [];
  const replaced: ListedEntry[] = [];
  const moved: ListedEntry[] = [];
  // 整体处理过的目录（新目录、搬家的目录）：它们下面的条目不再单独看
  const wholeDirs: string[] = [];
  // 浅的先看：父目录判成"整个是新的"之后，子孙直接跳过
  const sorted = [...current].sort((a, b) => depthOf(a.path) - depthOf(b.path) || a.path.localeCompare(b.path));

  for (const e of sorted) {
    if (wholeDirs.some((d) => isUnder(e.path, d))) continue;
    const k = knownByPath.get(e.path);
    if (k) {
      if (!e.isDir && !k.isDir && e.sha1 && k.sha1 && e.sha1 !== k.sha1) replaced.push(e);
      continue;
    }
    if (e.isDir) {
      wholeDirs.push(e.path);
      const files = current.filter((c) => !c.isDir && isUnder(c.path, e.path));
      // 里面全是早就见过的文件：这是分享者把旧文件整理进了新目录，不是新内容
      if (files.length > 0 && files.every((f) => f.sha1 && knownSha.has(f.sha1))) moved.push(e);
      else added.push(e);
      continue;
    }
    if (e.sha1 && knownSha.has(e.sha1)) moved.push(e);
    else added.push(e);
  }
  return { added, replaced, moved };
}

/**
 * 检查之后的新快照：原有的 + 这次列到的，转存失败的除外（下次还要再试）。
 * 分享里已经删掉的条目也留着：分享者删了再传同一个文件，不该被当成新增再转存一份。
 * 被替换 / 搬家的条目按现在的样子记进去，同一件事不会每轮都报一次。
 */
export function mergeKnown(
  known: ShareFollowEntry[],
  current: ListedEntry[],
  excludePaths: Iterable<string> = [],
): ShareFollowEntry[] {
  const skip = [...excludePaths];
  const byPath = new Map(known.map((e) => [e.path, e]));
  for (const e of current) {
    if (skip.some((x) => e.path === x || isUnder(e.path, x))) continue;
    const entry: ShareFollowEntry = { path: e.path, isDir: e.isDir };
    if (e.sha1) entry.sha1 = e.sha1;
    if (e.size != null) entry.size = e.size;
    byPath.set(e.path, entry);
  }
  return [...byPath.values()];
}

export interface ReceiveGroup {
  /** 相对被盯目录的父目录路径，"" 是被盯目录本身 */
  parent: string;
  items: ListedEntry[];
}

/** 转存按落点分组：115 的 receive 一次只能指定一个目标目录 */
export function groupByParent(entries: ListedEntry[]): ReceiveGroup[] {
  const groups = new Map<string, ListedEntry[]>();
  for (const e of entries) {
    const parent = parentOf(e.path);
    groups.set(parent, [...(groups.get(parent) ?? []), e]);
  }
  return [...groups]
    .map(([parent, items]) => ({ parent, items }))
    .sort((a, b) => (a.parent === "" ? -1 : b.parent === "" ? 1 : depthOf(a.parent) - depthOf(b.parent) || a.parent.localeCompare(b.parent)));
}

/**
 * 从这次勾选推追更范围：勾了文件就是整个当前目录（`[""]`），只勾目录就只追这些目录里面。
 * 什么都没勾（影库整个转存那种）也是整个目录。
 */
export function scopeFromSelection(items: Array<{ name: string; isDir: boolean }>): string[] {
  if (items.length === 0 || items.some((i) => !i.isDir)) return [""];
  return [...new Set(items.map((i) => i.name.trim()).filter(Boolean))];
}

/** 范围是否包含被盯目录本身 */
export const scopeIsWhole = (scope: string[]): boolean => scope.length === 0 || scope.includes("");

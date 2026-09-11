/**
 * OpenList 的 Provider：id 就是路径。只有同步 / 浏览 / 直链，没有分享和变更监控。
 * 列子树时 refresh:true 绕过 OpenList 的目录缓存（115 刚下完的文件必须这么刷一下才看得见）；浏览时不刷。
 */
import type { AccountOpenlist } from "@openstrm/shared";
import { readAppSettings } from "../../../db/repositories/settings.js";
import { scheduleForAccount } from "../../download/rate-limited.js";
import {
  OpenlistError,
  openlistListDir,
  openlistMkdir,
  openlistMove,
  openlistRawUrl,
  openlistRemove,
  openlistRename,
  type OpenlistFsEntry,
} from "../../openlist/client.js";
import { syncViewFromPaths } from "../subtree.js";
import {
  normalizePath,
  RemoteDirNotFoundError,
  splitPath,
  type AccountIssue,
  type DriveEntry,
  type DriveNode,
  type DriveProvider,
  type DriveWriteOps,
  type SubtreeEntry,
  type WriteNode,
} from "../types.js";

const join = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);

/** OpenList 明确说没有这个路径（不是连不上） */
const isMissing = (err: unknown): boolean =>
  err instanceof OpenlistError && !err.transport && /not found|不存在|no such/i.test(err.message);

function modifiedAtOf(e: OpenlistFsEntry): number | undefined {
  if (!e.modified) return undefined;
  const t = Date.parse(e.modified);
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

export class OpenlistProvider implements DriveProvider {
  readonly kind = "openlist" as const;
  readonly capabilities = { share: false, changes: false, write: true };
  readonly rootId = "/";
  readonly write: DriveWriteOps;

  constructor(readonly account: AccountOpenlist) {
    this.write = new OpenlistWrite(account);
  }

  async resolvePath(path: string, signal?: AbortSignal): Promise<DriveNode | null> {
    const p = normalizePath(path);
    if (p === "/") return { id: "/", isDir: true };
    const segs = splitPath(p);
    const name = segs[segs.length - 1];
    const parent = normalizePath(segs.slice(0, -1).join("/"));
    let entries: OpenlistFsEntry[];
    try {
      entries = await openlistListDir(this.account, parent, { signal });
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    const hit = entries.find((e) => e.name === name);
    return hit ? { id: p, isDir: hit.is_dir } : null;
  }

  async listDir(id: string, signal?: AbortSignal): Promise<DriveEntry[]> {
    const dir = normalizePath(id);
    const entries = await openlistListDir(this.account, dir, { signal });
    return entries.map((e) => ({
      id: join(dir, e.name),
      name: e.name,
      isDir: e.is_dir,
      size: e.size,
      modifiedAt: modifiedAtOf(e),
    }));
  }

  private async walk(root: string, signal?: AbortSignal): Promise<SubtreeEntry[]> {
    const out: SubtreeEntry[] = [];
    const collect = async (cur: string, rel: string[]): Promise<void> => {
      let entries: OpenlistFsEntry[];
      try {
        entries = await openlistListDir(this.account, cur, { refresh: true, signal });
      } catch (err) {
        if (rel.length === 0 && isMissing(err)) throw new RemoteDirNotFoundError(root);
        throw err;
      }
      for (const e of entries) {
        const segs = [...rel, e.name];
        const p = join(cur, e.name);
        out.push({ path: segs.join("/"), id: p, isDir: e.is_dir, size: e.size, modifiedAt: modifiedAtOf(e) });
        if (e.is_dir) await collect(p, segs);
      }
    };
    await collect(root, []);
    return out;
  }

  async listSubtree(path: string, opts?: { id?: string; signal?: AbortSignal }): Promise<string[]> {
    const entries = await this.walk(normalizePath(opts?.id ?? path), opts?.signal);
    return syncViewFromPaths(entries.map((e) => e.path.split("/")));
  }

  async walkSubtree(path: string, opts?: { id?: string; signal?: AbortSignal }): Promise<SubtreeEntry[]> {
    return this.walk(normalizePath(opts?.id ?? path), opts?.signal);
  }

  async downloadLink(path: string, opts?: { token?: string; signal?: AbortSignal }): Promise<{ url: string }> {
    const p = normalizePath(path);
    const maxConcurrent = readAppSettings().download?.linkMaxConcurrent || 2;
    const url = await scheduleForAccount(
      `${this.account.name}:normal`,
      () => openlistRawUrl(this.account, p, opts?.signal),
      maxConcurrent,
      opts?.signal,
    );
    return { url };
  }

  classifyError(err: unknown): AccountIssue | null {
    if (err instanceof OpenlistError && (err.code === 401 || err.code === 403)) return "auth";
    return null;
  }
}

/** OpenList 的 id 就是路径：改名 / 移动之后返回新路径当 id */
class OpenlistWrite implements DriveWriteOps {
  constructor(private readonly account: AccountOpenlist) {}

  async mkdir(parent: { id: string; path: string }, name: string, signal?: AbortSignal): Promise<DriveNode> {
    const p = join(normalizePath(parent.path), name);
    await openlistMkdir(this.account, p, signal);
    return { id: p, isDir: true };
  }

  async rename(node: WriteNode, newName: string, signal?: AbortSignal): Promise<{ id: string }> {
    const p = normalizePath(node.path);
    await openlistRename(this.account, p, newName, signal);
    return { id: join(normalizePath(splitPath(p).slice(0, -1).join("/")), newName) };
  }

  async move(nodes: WriteNode[], to: { id: string; path: string }, signal?: AbortSignal): Promise<Array<{ id: string }>> {
    const dst = normalizePath(to.path);
    const bySrc = new Map<string, string[]>();
    for (const n of nodes) {
      const p = normalizePath(n.path);
      const dir = normalizePath(splitPath(p).slice(0, -1).join("/"));
      const list = bySrc.get(dir) ?? [];
      list.push(splitPath(p).pop() ?? "");
      bySrc.set(dir, list);
    }
    for (const [dir, names] of bySrc) await openlistMove(this.account, dir, dst, names, signal);
    return nodes.map((n) => ({ id: join(dst, splitPath(n.path).pop() ?? "") }));
  }

  async rmdirIfEmpty(node: WriteNode, signal?: AbortSignal): Promise<boolean> {
    const p = normalizePath(node.path);
    const entries = await openlistListDir(this.account, p, { refresh: true, signal });
    if (entries.length > 0) return false;
    await openlistRemove(this.account, normalizePath(splitPath(p).slice(0, -1).join("/")), [splitPath(p).pop() ?? ""], signal);
    return true;
  }
}

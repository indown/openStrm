/**
 * 夸克网盘的 Provider。同步 / 浏览 / 直链走 quark/client.ts；分享（阶段三）和快照变更源（阶段五）后补。
 * 夸克没有整树导出：子树靠逐层列目录，同一层的目录并发列（在飞上限 4，真正的节流是账号限流器）。
 * 名字里带 / 的条目按路径根本找不回来，跳过并告警。
 */
import type { AccountQuark } from "@openstrm/shared";
import { mapLimit } from "../../../lib/async.js";
import { PermanentError } from "../../../lib/errors.js";
import { moduleLogger } from "../../../lib/logger.js";
import { QuarkError, quarkDownloadLink, quarkListDir, quarkResolvePath, type QuarkEntry } from "../../quark/client.js";
import { syncViewFromPaths } from "../subtree.js";
import {
  RemoteDirNotFoundError,
  ShareGoneError,
  type AccountIssue,
  type DriveEntry,
  type DriveLink,
  type DriveNode,
  type DriveProvider,
  type SubtreeEntry,
} from "../types.js";

const log = moduleLogger("quark");

function toEntry(e: QuarkEntry): DriveEntry {
  return { id: e.fid, name: e.name, isDir: e.isDir, size: e.size, token: e.fid, modifiedAt: e.modifiedAt || undefined };
}

export class QuarkProvider implements DriveProvider {
  readonly kind = "quark" as const;
  readonly capabilities = { share: false, changes: false };
  readonly rootId = "0";

  constructor(readonly account: AccountQuark) {}

  async resolvePath(path: string, signal?: AbortSignal): Promise<DriveNode | null> {
    try {
      const { fid, entry } = await quarkResolvePath(this.account, path, signal);
      return { id: fid, isDir: entry ? entry.isDir : true };
    } catch (err) {
      // 找不到、中间段是文件：都是「没有这个路径」
      if (err instanceof PermanentError) return null;
      throw err;
    }
  }

  async listDir(id: string, signal?: AbortSignal): Promise<DriveEntry[]> {
    return (await quarkListDir(this.account, id, signal)).map(toEntry);
  }

  private async walk(rootFid: string, signal?: AbortSignal): Promise<SubtreeEntry[]> {
    const out: SubtreeEntry[] = [];
    let frontier: Array<{ fid: string; rel: string[] }> = [{ fid: rootFid, rel: [] }];
    while (frontier.length > 0) {
      const listed = await mapLimit(frontier, 4, (dir) => quarkListDir(this.account, dir.fid, signal));
      const next: typeof frontier = [];
      frontier.forEach((dir, i) => {
        for (const item of listed[i]) {
          if (item.name.includes("/")) {
            log.warn({ account: this.account.name, dir: dir.rel.join("/"), name: item.name }, "夸克条目名字里带 /，按路径找不回来，跳过");
            continue;
          }
          const segs = [...dir.rel, item.name];
          out.push({ path: segs.join("/"), id: item.fid, isDir: item.isDir, size: item.size, modifiedAt: item.modifiedAt || undefined });
          if (item.isDir) next.push({ fid: item.fid, rel: segs });
        }
      });
      frontier = next;
    }
    return out;
  }

  private async rootFid(path: string, id: string | undefined, signal?: AbortSignal): Promise<string> {
    if (id) return id;
    const node = await this.resolvePath(path, signal);
    if (!node || !node.isDir) throw new RemoteDirNotFoundError(path);
    return node.id;
  }

  async listSubtree(path: string, opts?: { id?: string; signal?: AbortSignal }): Promise<string[]> {
    const entries = await this.walk(await this.rootFid(path, opts?.id, opts?.signal), opts?.signal);
    return syncViewFromPaths(entries.map((e) => e.path.split("/")));
  }

  async walkSubtree(path: string, opts?: { id?: string; signal?: AbortSignal }): Promise<SubtreeEntry[]> {
    return this.walk(await this.rootFid(path, opts?.id, opts?.signal), opts?.signal);
  }

  async downloadLink(path: string, opts?: { token?: string; signal?: AbortSignal }): Promise<DriveLink> {
    let fid = opts?.token;
    if (!fid) {
      const { fid: id, entry } = await quarkResolvePath(this.account, path, opts?.signal);
      if (!entry || entry.isDir) throw new PermanentError(`Not a file: ${path}`);
      fid = id;
    }
    return quarkDownloadLink(this.account, fid, opts?.signal);
  }

  classifyError(err: unknown): AccountIssue | null {
    if (err instanceof ShareGoneError) return "gone";
    if (err instanceof QuarkError) {
      if (err.code === 31001 || err.code === 31004 || err.status === 401) return "auth";
      if (err.status === 403 || err.status === 429) return "blocked";
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/require login|st invalid/i.test(msg)) return "auth";
    return null;
  }
}

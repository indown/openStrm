/**
 * 夸克网盘的 Provider。同步 / 浏览 / 直链走 quark/client.ts，分享走 quark/share.ts；快照变更源在 services/life/sources/quark.ts。
 * 夸克没有整树导出：子树靠逐层列目录，同一层的目录并发列（在飞上限 4，真正的节流是账号限流器）。
 * 名字里带 / 的条目按路径根本找不回来，跳过并告警。
 */
import type { AccountQuark } from "@openstrm/shared";
import { mapLimit } from "../../../lib/async.js";
import { PermanentError } from "../../../lib/errors.js";
import { moduleLogger } from "../../../lib/logger.js";
import { QuarkError, quarkDownloadLink, quarkListDir, quarkResolvePath, type QuarkEntry } from "../../quark/client.js";
import {
  QUARK_SHARE_PAGE_SIZE,
  QuarkShareError,
  quarkShareList,
  quarkShareSave,
  quarkShareToken,
  quarkWaitTask,
  type QuarkShareFile,
} from "../../quark/share.js";
import { listWholeShareDir, resolveSharePath } from "../share-walk.js";
import { syncViewFromPaths } from "../subtree.js";
import {
  RemoteDirNotFoundError,
  ShareGoneError,
  type AccountIssue,
  type DriveEntry,
  type DriveLink,
  type DriveNode,
  type DriveProvider,
  type ReceiveItem,
  type ReceiveResult,
  type ShareEntry,
  type ShareInfo,
  type ShareListPage,
  type ShareProvider,
  type ShareRef,
  type ShareSession,
  type SubtreeEntry,
} from "../types.js";

const log = moduleLogger("quark");

function toEntry(e: QuarkEntry): DriveEntry {
  return { id: e.fid, name: e.name, isDir: e.isDir, size: e.size, token: e.fid, modifiedAt: e.modifiedAt || undefined };
}

function toShareEntry(f: QuarkShareFile): ShareEntry {
  return { id: f.fid, name: f.name, isDir: f.isDir, size: f.isDir ? undefined : f.size, token: f.token, modifiedAt: f.modifiedAt || undefined };
}

/* ------------------------------- 分享 ------------------------------- */

const SHARE_URL = /https?:\/\/pan\.quark\.cn\/s\/([a-z0-9]+)(\?[^\s"'<>]*)?/i;
const PASSCODE_IN_TEXT = /提取码[:：]?\s*([a-z0-9]{4,8})/i;

/** 只认 pan.quark.cn/s/<pwd_id>；提取码可以在 ?pwd= 里，也可以在链接后面的「提取码：xxxx」里 */
export function parseQuarkShareLink(text: string): ShareRef | null {
  const m = SHARE_URL.exec(text);
  if (!m) return null;
  const code = m[1];
  let password = "";
  if (m[2]) {
    const q = new URLSearchParams(m[2].slice(1));
    password = (q.get("pwd") ?? q.get("passcode") ?? "").trim();
  }
  if (!password) password = PASSCODE_IN_TEXT.exec(text)?.[1] ?? "";
  return { kind: "quark", code, password, url: `https://pan.quark.cn/s/${code}${password ? `?pwd=${password}` : ""}` };
}

function shareError(err: unknown): unknown {
  return err instanceof QuarkShareError ? new ShareGoneError(err.message, err.code) : err;
}

class QuarkShare implements ShareProvider {
  constructor(private readonly account: AccountQuark) {}

  parseLink(text: string): ShareRef | null {
    return parseQuarkShareLink(text);
  }

  async open(ref: ShareRef, signal?: AbortSignal): Promise<ShareSession> {
    try {
      const { stoken } = await quarkShareToken(this.account, ref.code, ref.password, signal);
      return { ref, token: stoken };
    } catch (err) {
      throw shareError(err);
    }
  }

  async info(s: ShareSession, signal?: AbortSignal): Promise<ShareInfo> {
    try {
      const { title } = await quarkShareToken(this.account, s.ref.code, s.ref.password, signal);
      const first = await quarkShareList(this.account, s.ref.code, this.stoken(s), "0", 1, signal);
      return { title: title || s.ref.code, fileCount: first.total };
    } catch (err) {
      throw shareError(err);
    }
  }

  private stoken(s: ShareSession): string {
    if (!s.token) throw new PermanentError("夸克分享会话没有 stoken，请先 open");
    return s.token;
  }

  async list(s: ShareSession, dirId: string, cursor?: string, opts?: { signal?: AbortSignal }): Promise<ShareListPage> {
    const page = Math.max(1, Number(cursor ?? 1) || 1);
    let r: { list: QuarkShareFile[]; total: number };
    try {
      r = await quarkShareList(this.account, s.ref.code, this.stoken(s), dirId || "0", page, opts?.signal);
    } catch (err) {
      throw shareError(err);
    }
    const more = r.list.length > 0 && page * QUARK_SHARE_PAGE_SIZE < r.total;
    return { entries: r.list.map(toShareEntry), next: more ? String(page + 1) : undefined, total: r.total };
  }

  resolvePath(s: ShareSession, path: string, signal?: AbortSignal): Promise<ShareEntry | null> {
    return resolveSharePath(this, s, path, signal);
  }

  async receive(s: ShareSession, items: ReceiveItem[], toDirId: string, signal?: AbortSignal): Promise<ReceiveResult> {
    // 转存要每个条目的 share_fid_token；没带的（比如只存了 id 的老数据）按路径重新列一遍分享来补
    const withToken: Array<{ id: string; token: string }> = [];
    const missing = items.filter((i) => !i.token);
    const tokens = new Map<string, string>();
    if (missing.length > 0) {
      for (const e of await listWholeShareDir(this, s, "0", signal)) tokens.set(e.id, e.token ?? "");
    }
    for (const i of items) {
      const token = i.token || tokens.get(i.id);
      if (!token) throw new PermanentError(`夸克转存缺少条目 ${i.id} 的 share_fid_token（它不在分享根目录下，请重新从分享列表里选择）`);
      withToken.push({ id: i.id, token });
    }
    try {
      const { taskId } = await quarkShareSave(this.account, { pwdId: s.ref.code, stoken: this.stoken(s), items: withToken, toPdirFid: toDirId }, signal);
      const done = await quarkWaitTask(this.account, taskId, { signal });
      return { topIds: done.topIds };
    } catch (err) {
      throw shareError(err);
    }
  }
}

/* ------------------------------- 网盘 ------------------------------- */

export class QuarkProvider implements DriveProvider {
  readonly kind = "quark" as const;
  readonly capabilities = { share: true, changes: false };
  readonly rootId = "0";
  readonly share: ShareProvider;

  constructor(readonly account: AccountQuark) {
    this.share = new QuarkShare(account);
  }

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
    if (err instanceof ShareGoneError || err instanceof QuarkShareError) return "gone";
    if (err instanceof QuarkError) {
      if (err.code === 31001 || err.code === 31004 || err.status === 401) return "auth";
      if (err.status === 403 || err.status === 429) return "blocked";
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/require login|st invalid/i.test(msg)) return "auth";
    return null;
  }
}

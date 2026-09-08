/**
 * 115 的 Provider：只是现有 cloud-115/{client,share}.ts 的适配层，那两个文件原样保留。
 * 分享能力已经接上；变更监控（生活事件）在 services/life/sources/cloud115.ts。
 */
import type { Account115 } from "@openstrm/shared";
import { readAppSettings } from "../../../db/repositories/settings.js";
import { isAbortError, PermanentError } from "../../../lib/errors.js";
import {
  Cloud115Error,
  fsDirGetId,
  getDownloadUrlWeb,
  getIdToPath,
  listDirEntries,
  type DriveEntry as RawEntry,
} from "../../cloud-115/client.js";
import {
  getShareData,
  getShareDirList,
  getShareDownloadUrl,
  receiveToMyDrive,
  ShareApiError,
  shareExtractPayload,
  type ShareAttr,
} from "../../cloud-115/share.js";
import { exportDirFiles } from "../../strm/share-strm.js";
import { classifyAccountIssue } from "../../telegram/notify.js";
import {
  ShareGoneError,
  splitPath,
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
} from "../types.js";

const VERIFY_NOTE = "115 的目录信息有几分钟缓存：刚转存进去或刚删掉的文件，几分钟内校验结果可能还是旧的";
const SHARE_HOSTS = /(^|\.)(115\.com|115cdn\.com|anxia\.com)$/i;
const SHARE_PAGE = 1000;

function userAgent(): string | undefined {
  const ua = readAppSettings()["user-agent"];
  return typeof ua === "string" && ua ? ua : undefined;
}

/** files 接口的原始字段：目录只有 cid，文件有 fid（cid 是父目录）、sha 是 sha1、pc 是 pick_code */
function toDriveEntry(raw: RawEntry): DriveEntry {
  const r = raw as RawEntry & { s?: number; pc?: string };
  const isDir = r.fid === undefined || r.fid === null || !r.sha;
  return {
    id: String(isDir ? r.cid : r.fid),
    name: r.n,
    isDir,
    size: r.s != null ? Number(r.s) : undefined,
    hash: r.sha ?? undefined,
    token: r.pc || undefined,
  };
}

function toShareEntry(it: ShareAttr): ShareEntry {
  return { id: String(it.id), name: it.name, isDir: it.is_dir, size: it.size, hash: it.sha1 };
}

/** 分享接口说「不行」：cookie 失效那种是账号问题，其余都是分享没了 */
function shareError(err: unknown): unknown {
  if (err instanceof ShareApiError) {
    if (classifyAccountIssue(err.message)) return err;
    return new ShareGoneError(err.message, err.errno);
  }
  return err;
}

class Cloud115Share implements ShareProvider {
  constructor(private readonly account: Account115) {}

  parseLink(text: string): ShareRef | null {
    const raw = text.trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) {
      let host: string;
      try {
        host = new URL(raw).hostname;
      } catch {
        return null;
      }
      if (!SHARE_HOSTS.test(host)) return null;
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /\.[a-z]{2,}\//i.test(raw)) {
      // 别家的链接：不是 115 的域名就不认
      return null;
    }
    try {
      const { share_code, receive_code } = shareExtractPayload(raw);
      if (!share_code) return null;
      const url = /^https?:\/\//i.test(raw) ? raw : `https://115.com/s/${share_code}${receive_code ? `?password=${receive_code}` : ""}`;
      return { kind: "115", code: share_code, password: receive_code, url };
    } catch {
      return null;
    }
  }

  async open(ref: ShareRef): Promise<ShareSession> {
    return { ref };
  }

  async info(s: ShareSession): Promise<ShareInfo> {
    let data: Record<string, unknown>;
    try {
      data = await getShareData(this.account, s.ref.code, s.ref.password, { userAgent: userAgent() });
    } catch (err) {
      throw shareError(err);
    }
    const info = ((data.shareinfo ?? data.share_info ?? data) as Record<string, unknown>) ?? {};
    const title = String(info.share_title ?? info.share_name ?? info.name ?? info.title ?? s.ref.code).trim();
    const count = Number(info.file_size ?? info.file_count ?? 0) || undefined;
    return { title, fileCount: count };
  }

  async list(s: ShareSession, dirId: string, cursor?: string): Promise<ShareListPage> {
    const offset = Number(cursor ?? 0) || 0;
    let page: { list: ShareAttr[]; count: number };
    try {
      page = await getShareDirList(this.account, s.ref.code, s.ref.password, dirId || "0", {
        limit: SHARE_PAGE,
        offset,
        userAgent: userAgent(),
      });
    } catch (err) {
      throw shareError(err);
    }
    const entries = page.list.map(toShareEntry);
    const end = offset + page.list.length;
    return { entries, next: page.list.length > 0 && end < page.count ? String(end) : undefined, total: page.count };
  }

  private async listAll(s: ShareSession, dirId: string): Promise<ShareEntry[]> {
    const out: ShareEntry[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.list(s, dirId, cursor);
      out.push(...page.entries);
      if (!page.next) return out;
      cursor = page.next;
    }
  }

  async resolvePath(s: ShareSession, path: string): Promise<ShareEntry | null> {
    const segs = splitPath(path);
    if (segs.length === 0) return null;
    let dirId = "0";
    let hit: ShareEntry | null = null;
    for (let i = 0; i < segs.length; i++) {
      const entries = await this.listAll(s, dirId);
      const isLast = i === segs.length - 1;
      hit = entries.find((e) => e.name === segs[i] && (isLast || e.isDir)) ?? null;
      if (!hit) return null;
      dirId = hit.id;
    }
    return hit;
  }

  async receive(s: ShareSession, items: ReceiveItem[], toDirId: string): Promise<ReceiveResult> {
    try {
      await receiveToMyDrive(this.account, s.ref.code, s.ref.password, items.map((i) => i.id), toDirId, { userAgent: userAgent() });
    } catch (err) {
      throw shareError(err);
    }
    return {};
  }

  async downloadUrl(s: ShareSession, fileId: string): Promise<string> {
    try {
      return await getShareDownloadUrl(this.account, s.ref.code, s.ref.password, fileId, { userAgent: userAgent() });
    } catch (err) {
      throw shareError(err);
    }
  }
}

export class Cloud115Provider implements DriveProvider {
  readonly kind = "115" as const;
  readonly capabilities = { share: true, changes: false };
  readonly rootId = "0";
  readonly notes = { verify: VERIFY_NOTE };
  readonly share: ShareProvider;

  constructor(readonly account: Account115) {
    this.share = new Cloud115Share(account);
  }

  private ctx(signal?: AbortSignal) {
    return { accountInfo: this.account, userAgent: userAgent(), signal };
  }

  /** getid 只认目录（不存在回 0）；回 0 时再看父目录里有没有同名文件 */
  async resolvePath(path: string, signal?: AbortSignal): Promise<DriveNode | null> {
    const segs = splitPath(path);
    if (segs.length === 0) return { id: "0", isDir: true };
    const dirId = await this.dirId(segs.join("/"), signal);
    if (dirId) return { id: dirId, isDir: true };
    const parentId = segs.length === 1 ? "0" : await this.dirId(segs.slice(0, -1).join("/"), signal);
    if (!parentId) return null;
    const name = segs[segs.length - 1];
    const hit = (await listDirEntries(parentId, this.ctx(signal))).find((e) => e.n === name);
    if (!hit) return null;
    const entry = toDriveEntry(hit);
    return { id: entry.id, isDir: entry.isDir };
  }

  /** 目录 id；不存在是 null。接口对坏路径可能直接报错，那也是「没有」 */
  private async dirId(path: string, signal?: AbortSignal): Promise<string | null> {
    let res: { id?: number | string } | undefined;
    try {
      res = (await fsDirGetId(path, this.ctx(signal))) as { id?: number | string };
    } catch (err) {
      if (err instanceof Cloud115Error || isAbortError(err)) throw err;
      return null;
    }
    const id = res?.id == null ? "" : String(res.id);
    return id && id !== "0" ? id : null;
  }

  async listDir(id: string, signal?: AbortSignal): Promise<DriveEntry[]> {
    return (await listDirEntries(id || "0", this.ctx(signal))).map(toDriveEntry);
  }

  async listSubtree(path: string, opts?: { id?: string; signal?: AbortSignal }): Promise<string[]> {
    return exportDirFiles({ accountInfo: this.account, dirPath: path, cid: opts?.id });
  }

  async downloadLink(path: string, opts?: { token?: string; signal?: AbortSignal }): Promise<DriveLink> {
    let pickcode: string | number | undefined = opts?.token;
    if (!pickcode) pickcode = await getIdToPath({ path, userAgent: userAgent(), accountInfo: this.account, signal: opts?.signal });
    if (!pickcode) throw new PermanentError(`No pickcode found for file: ${path}`);
    const url = await getDownloadUrlWeb(pickcode, this.ctx(opts?.signal));
    if (!url) throw new PermanentError(`No download url for file: ${path}`);
    return { url };
  }

  classifyError(err: unknown): AccountIssue | null {
    if (err instanceof ShareGoneError) return "gone";
    const msg = err instanceof Error ? err.message : String(err);
    const issue = classifyAccountIssue(msg);
    if (issue === "cookie") return "auth";
    if (issue === "blocked") return "blocked";
    if (err instanceof ShareApiError) return "gone";
    return null;
  }
}

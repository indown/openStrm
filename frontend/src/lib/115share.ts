/**
 * 115 分享链接 API（对应 p115client P115ShareFileSystem）
 * 用于解析分享链接、获取分享目录列表、下载链接、转存到我的网盘
 */
import type { AccountInfo } from "./115";
import { shareSnap, shareDownloadUrl, shareReceive } from "./115";

export type { AccountInfo };

/** 从分享链接解析出 share_code 和 receive_code */
export function shareExtractPayload(link: string): { share_code: string; receive_code: string } {
  const raw = link.trim().replace(/^[/#]+|[/#]+$/g, "");
  if (/^[a-z0-9]+$/i.test(raw)) {
    return { share_code: raw, receive_code: "" };
  }
  // URL 形式：https://115cdn.com/s/swhk9bx3wwq?password=sff1 或 https://115.com/s/xxx?password=yyyy
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const pathSegments = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
      const shareCode = pathSegments[pathSegments.length - 1] ?? "";
      const receiveCode = u.searchParams.get("password") ?? "";
      if (shareCode && /^[a-z0-9]+$/i.test(shareCode)) {
        return { share_code: shareCode, receive_code: String(receiveCode).trim() };
      }
    } catch {
      // fallback to regex
    }
  }
  // 短格式：xxx-yyyy 或 xxx?yyyy
  const m = raw.match(/([a-z0-9]+)(?:[-?]|password=)([a-z0-9]+)?/i);
  if (m) {
    return {
      share_code: m[1],
      receive_code: (m[2] ?? "").trim(),
    };
  }
  // 仅路径：取最后一个路径段为 share_code，query 中 password 为 receive_code
  const pathMatch = raw.match(/.*\/([a-z0-9]+)(?=\?|$)/i);
  if (pathMatch) {
    const shareCode = pathMatch[1];
    const passwordMatch = raw.match(/password=([a-z0-9]+)/i);
    return {
      share_code: shareCode,
      receive_code: passwordMatch ? passwordMatch[1].trim() : "",
    };
  }
  throw new Error("can't extract share_code from " + JSON.stringify(link));
}

/** 分享项属性（目录或文件） */
export interface ShareAttr {
  id: number;
  name: string;
  is_dir: boolean;
  parent_id: number;
  size?: number;
  sha1?: string;
  /** 原始接口字段名可能为 n/fn, fid/cid, fc 等 */
  [k: string]: unknown;
}

function normalizeShareAttr(item: Record<string, unknown>): ShareAttr {
  if ("n" in item && typeof item.n === "string") {
    const isDir = !("fid" in item);
    return {
      id: isDir ? Number(item.cid) : Number(item.fid),
      name: item.n as string,
      is_dir: isDir,
      parent_id: Number(item.pid ?? item.cid ?? 0),
      size: item.s != null ? Number(item.s) : undefined,
      sha1: item.sha1 as string | undefined,
      ...item,
    };
  }
  if ("file_name" in item || "fn" in item) {
    const name = (item.file_name ?? item.fn) as string;
    const isDir = String(item.file_category ?? item.fc ?? "1") === "0";
    const id = Number(item.file_id ?? item.fid);
    const pid = Number(item.parent_id ?? item.pid ?? item.cid ?? 0);
    return {
      id,
      name,
      is_dir: isDir,
      parent_id: pid,
      size: item.file_size != null ? Number(item.file_size) : undefined,
      sha1: item.sha1 as string | undefined,
      ...item,
    };
  }
  return item as ShareAttr;
}

function checkShareResponse<T extends { state?: boolean; errno?: number; error?: string }>(resp: T): T {
  if (resp.state === false || (typeof resp.errno === "number" && resp.errno !== 0)) {
    throw new Error(resp.error || `115 share API error: errno=${resp.errno}`);
  }
  return resp;
}

/** 获取分享首页数据（快照，含 share_info 等） */
export async function getShareData(
  accountInfo: AccountInfo,
  shareCode: string,
  receiveCode = "",
  opts?: { userAgent?: string }
): Promise<Record<string, unknown>> {
  const resp = await shareSnap(
    accountInfo,
    { share_code: shareCode, receive_code: receiveCode, limit: 1 },
    opts
  );
  checkShareResponse(resp as { state?: boolean; errno?: number });
  const data = (resp as { data?: Record<string, unknown> }).data;
  if (!data) throw new Error("share_snap returned no data");
  return data;
}

/** 列分享目录（分页），返回标准化后的列表 */
export async function getShareDirList(
  accountInfo: AccountInfo,
  shareCode: string,
  receiveCode: string,
  cid: string,
  opts?: { limit?: number; offset?: number; userAgent?: string }
): Promise<ShareAttr[]> {
  const limit = opts?.limit ?? 32;
  const offset = opts?.offset ?? 0;
  const resp = await shareSnap(
    accountInfo,
    { share_code: shareCode, receive_code: receiveCode, cid, limit, offset },
    { userAgent: opts?.userAgent }
  );
  checkShareResponse(resp as { state?: boolean; errno?: number });
  const list = (resp as { list?: unknown[]; data?: { list?: unknown[] } }).list
    ?? (resp as { data?: { list?: unknown[] } }).data?.list
    ?? [];
  return list.map((item) => normalizeShareAttr(item as Record<string, unknown>));
}

/** 获取分享内文件/目录的下载链接（仅文件有直链） */
export async function getShareDownloadUrl(
  accountInfo: AccountInfo,
  shareCode: string,
  receiveCode: string,
  fileId: number | string,
  opts?: { userAgent?: string }
): Promise<string> {
  const resp = await shareDownloadUrl(accountInfo, shareCode, receiveCode, fileId, opts);
  checkShareResponse(resp as { state?: boolean; errno?: number });
  const url = (resp as { url?: string }).url ?? (resp as { data?: { url?: string } }).data?.url;
  if (!url) throw new Error("share_download_url returned no url");
  return url;
}

/** 转存分享文件/目录到我的网盘 */
export async function receiveToMyDrive(
  accountInfo: AccountInfo,
  shareCode: string,
  receiveCode: string,
  fileIds: number | string | (number | string)[],
  toPid: string,
  opts?: { userAgent?: string }
): Promise<Record<string, unknown>> {
  const resp = await shareReceive(accountInfo, shareCode, receiveCode, fileIds, toPid, opts);
  checkShareResponse(resp as { state?: boolean; errno?: number });
  return resp as Record<string, unknown>;
}

/**
 * 115 分享文件系统（对应 p115client.fs.P115ShareFileSystem）
 * 通过分享链接操作：获取信息、列目录、取下载链接、转存
 */
export class P115ShareFileSystem {
  constructor(
    public readonly accountInfo: AccountInfo,
    public readonly shareCode: string,
    public readonly receiveCode = ""
  ) {}

  static fromUrl(accountInfo: AccountInfo, url: string): P115ShareFileSystem {
    const { share_code, receive_code } = shareExtractPayload(url);
    return new P115ShareFileSystem(accountInfo, share_code, receive_code);
  }

  /** 分享首页数据（含 share_info、创建时间等） */
  async getShareData(opts?: { userAgent?: string }): Promise<Record<string, unknown>> {
    return getShareData(this.accountInfo, this.shareCode, this.receiveCode, opts);
  }

  /** 列目录，返回标准化条目数组 */
  async iterdir(cid: number, opts?: { limit?: number; offset?: number; userAgent?: string }): Promise<ShareAttr[]> {
    return getShareDirList(this.accountInfo, this.shareCode, this.receiveCode, cid, opts);
  }

  /** 获取下载链接（fileId 为分享内的文件 id） */
  async getUrl(fileId: number | string, opts?: { userAgent?: string }): Promise<string> {
    return getShareDownloadUrl(this.accountInfo, this.shareCode, this.receiveCode, fileId, opts);
  }

  /** 转存到我的网盘 toPid 目录（0 为根目录） */
  async receive(
    fileIds: number | string | (number | string)[],
    toPid = 0,
    opts?: { userAgent?: string }
  ): Promise<Record<string, unknown>> {
    return receiveToMyDrive(this.accountInfo, this.shareCode, this.receiveCode, fileIds, toPid, opts);
  }
}

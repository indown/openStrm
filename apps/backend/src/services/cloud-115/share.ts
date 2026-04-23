/**
 * 115 分享链接 API（对应 p115client P115ShareFileSystem）
 * 用于解析分享链接、获取分享目录列表、下载链接、转存到我的网盘
 */
import type { AccountInfo } from "./client.js";
import { shareSnap, shareDownloadUrl, shareReceive } from "./client.js";

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
  /** 分享内文件/目录 id，可能超出 JS 安全整数，接口为字符串时原样保留 */
  id: number | string;
  name: string;
  is_dir: boolean;
  parent_id: number | string;
  size?: number;
  sha1?: string;
  /** 原始接口字段名可能为 n/fn, fid/cid, fc 等 */
  [k: string]: unknown;
}

/** 将分享接口里的 id 转为 number 或 string，避免大整型被 Number() 截断 */
function normalizeShareId(raw: unknown): number | string {
  if (raw == null) return 0;
  if (typeof raw === "bigint") return raw.toString();
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "" || t === "0") return 0;
    if (!/^-?\d+$/.test(t)) return t;
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : t;
  }
  if (typeof raw === "number") {
    if (Number.isSafeInteger(raw)) return raw;
    return String(raw);
  }
  return String(raw);
}

function normalizeShareAttr(item: Record<string, unknown>): ShareAttr {
  if ("n" in item && typeof item.n === "string") {
    const isDir = !("fid" in item);
    return {
      id: normalizeShareId(isDir ? item.cid : item.fid),
      name: item.n as string,
      is_dir: isDir,
      parent_id: normalizeShareId(item.pid ?? item.cid ?? 0),
      size: item.s != null ? Number(item.s) : undefined,
      sha1: item.sha1 as string | undefined,
      ...item,
    };
  }
  if ("file_name" in item || "fn" in item) {
    const name = (item.file_name ?? item.fn) as string;
    const isDir = String(item.file_category ?? item.fc ?? "1") === "0";
    const id = normalizeShareId(item.file_id ?? item.fid);
    const pid = normalizeShareId(item.parent_id ?? item.pid ?? item.cid ?? 0);
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

/** 列分享目录（分页），返回标准化后的列表及总数 */
export async function getShareDirList(
  accountInfo: AccountInfo,
  shareCode: string,
  receiveCode: string,
  cid: number | string,
  opts?: { limit?: number; offset?: number; userAgent?: string }
): Promise<{ list: ShareAttr[]; count: number }> {
  const limit = opts?.limit ?? 32;
  const offset = opts?.offset ?? 0;
  const resp = await shareSnap(
    accountInfo,
    { share_code: shareCode, receive_code: receiveCode, cid: String(cid), limit, offset },
    { userAgent: opts?.userAgent }
  );
  checkShareResponse(resp as { state?: boolean; errno?: number });
  const raw = resp as { list?: unknown[]; count?: number; data?: { list?: unknown[]; count?: number } };
  const rawList = raw.list ?? raw.data?.list ?? [];
  const rawCount = raw.count ?? raw.data?.count;
  const list = rawList.map((item) => normalizeShareAttr(item as Record<string, unknown>));
  const count = typeof rawCount === "number" ? rawCount : list.length;
  return { list, count };
}

/**
 * 按影库 sharePath 在分享侧逐级列目录，得到用于 receive 的 file_id（无 shareRootCid 时的兜底）。
 */
export async function resolveLibraryEntryShareReceiveIds(
  accountInfo: AccountInfo,
  shareCode: string,
  receiveCode: string,
  sharePath: string,
  rawName: string,
  opts?: { userAgent?: string }
): Promise<Array<number | string>> {
  const trimmed = (sharePath || "").replace(/^\/+/, "");
  const segments = trimmed.split("/").filter(Boolean);
  let cid: number | string = 0;

  const listOne = (parent: number | string) =>
    getShareDirList(accountInfo, shareCode, receiveCode, parent, {
      limit: 1000,
      offset: 0,
      userAgent: opts?.userAgent,
    });

  if (segments.length === 0) {
    const { list } = await listOne(0);
    const hit = list.find((it) => it.is_dir && it.name === rawName);
    if (!hit) {
      throw new Error(`在分享根目录未找到「${rawName}」，请检查提取码或分享是否仍有效`);
    }
    return [hit.id];
  }

  for (const seg of segments) {
    const { list } = await listOne(cid);
    const hit = list.find((it) => it.is_dir && it.name === seg);
    if (!hit) {
      throw new Error(`在分享中未找到路径段「${seg}」`);
    }
    cid = hit.id;
  }
  return [cid];
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
  toPid: number | string,
  opts?: { userAgent?: string }
): Promise<Record<string, unknown>> {
  const resp = await shareReceive(accountInfo, shareCode, receiveCode, fileIds, String(toPid), opts);
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

  /** 列目录，返回标准化条目数组及总数 */
  async iterdir(cid: number | string, opts?: { limit?: number; offset?: number; userAgent?: string }): Promise<{ list: ShareAttr[]; count: number }> {
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

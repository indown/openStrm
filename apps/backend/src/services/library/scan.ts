import type { AccountInfo } from "../cloud-115/client.js";
import { getShareData, getShareDirList, shareExtractPayload } from "../cloud-115/share.js";
import { normalizeTitle } from "../media-title.js";
import { listByShareCode } from "../../db/repositories/media-library.js";

export interface ScanCandidate {
  cid: number | string;
  rawName: string;
  normalizedTitle: string;
  year: string;
  fileCount: number;
  hasChildren: boolean;
  alreadyInLibrary: boolean;
  parentCid: number | string;
  parentName: string;
}

export interface ScanResult {
  shareCode: string;
  receiveCode: string;
  shareUrl: string;
  shareTitle: string;
  totalCount: number;
  candidates: ScanCandidate[];
}

const PAGE_SIZE = 115;

async function listAllDir(
  accountInfo: AccountInfo,
  shareCode: string,
  receiveCode: string,
  cid: number | string,
  userAgent?: string,
) {
  const first = await getShareDirList(accountInfo, shareCode, receiveCode, cid, {
    limit: PAGE_SIZE,
    offset: 0,
    userAgent,
  });
  const all = [...first.list];
  let total = first.count;
  while (all.length < total) {
    const next = await getShareDirList(accountInfo, shareCode, receiveCode, cid, {
      limit: PAGE_SIZE,
      offset: all.length,
      userAgent,
    });
    if (next.list.length === 0) break;
    all.push(...next.list);
    if (typeof next.count === "number") total = next.count;
  }
  return all;
}

async function hasChildDirs(
  accountInfo: AccountInfo,
  shareCode: string,
  receiveCode: string,
  cid: number | string,
  userAgent?: string,
): Promise<boolean> {
  try {
    const { list } = await getShareDirList(accountInfo, shareCode, receiveCode, cid, {
      limit: 32,
      offset: 0,
      userAgent,
    });
    return list.some((x) => x.is_dir);
  } catch {
    return false;
  }
}

export async function scanShare(params: {
  accountInfo: AccountInfo;
  shareUrl: string;
  userAgent?: string;
}): Promise<ScanResult> {
  const { accountInfo, shareUrl, userAgent } = params;
  const { share_code: shareCode, receive_code: receiveCode } = shareExtractPayload(shareUrl);
  if (!shareCode) throw new Error("Cannot parse shareCode from url");

  const dataRaw = await getShareData(accountInfo, shareCode, receiveCode, { userAgent });
  const shareInfo = ((dataRaw as Record<string, unknown>)?.share_info ?? {}) as Record<string, unknown>;
  const shareTitle = String(shareInfo.share_title ?? shareInfo.name ?? "").trim();

  const rootList = await listAllDir(accountInfo, shareCode, receiveCode, 0, userAgent);
  const existing = listByShareCode(shareCode);
  const existingPaths = new Set(existing.map((e) => e.sharePath));

  const dirItems = rootList.filter((item) => item.is_dir);
  const hasChildrenArr = await Promise.all(
    dirItems.map((item) => hasChildDirs(accountInfo, shareCode, receiveCode, item.id, userAgent)),
  );
  const candidates: ScanCandidate[] = dirItems.map((item, idx) => {
    const rawName = item.name ?? "";
    const { title, year } = normalizeTitle(rawName);
    const fileCount =
      typeof item.size === "number" ? item.size : Number((item as Record<string, unknown>).size ?? 0) || 0;
    const sharePath = `/${rawName}`;
    return {
      cid: item.id,
      rawName,
      normalizedTitle: title,
      year,
      fileCount,
      hasChildren: hasChildrenArr[idx],
      alreadyInLibrary: existingPaths.has(sharePath),
      parentCid: 0,
      parentName: shareTitle,
    };
  });

  return {
    shareCode,
    receiveCode,
    shareUrl,
    shareTitle,
    totalCount: rootList.length,
    candidates,
  };
}

export async function expandCandidate(params: {
  accountInfo: AccountInfo;
  shareCode: string;
  receiveCode: string;
  parentCid: number | string;
  parentName: string;
  parentPath: string;
  userAgent?: string;
}): Promise<ScanCandidate[]> {
  const { accountInfo, shareCode, receiveCode, parentCid, parentName, parentPath, userAgent } = params;

  const list = await listAllDir(accountInfo, shareCode, receiveCode, parentCid, userAgent);
  const existing = listByShareCode(shareCode);
  const existingPaths = new Set(existing.map((e) => e.sharePath));

  const dirItems = list.filter((item) => item.is_dir);
  const hasChildrenArr = await Promise.all(
    dirItems.map((item) => hasChildDirs(accountInfo, shareCode, receiveCode, item.id, userAgent)),
  );
  return dirItems.map((item, idx) => {
    const rawName = item.name ?? "";
    const { title, year } = normalizeTitle(rawName);
    const fileCount =
      typeof item.size === "number" ? item.size : Number((item as Record<string, unknown>).size ?? 0) || 0;
    const sharePath = `${parentPath}/${rawName}`;
    return {
      cid: item.id,
      rawName,
      normalizedTitle: title,
      year,
      fileCount,
      hasChildren: hasChildrenArr[idx],
      alreadyInLibrary: existingPaths.has(sharePath),
      parentCid,
      parentName,
    };
  });
}

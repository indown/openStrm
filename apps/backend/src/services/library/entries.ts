/**
 * 收藏夹条目的改和删：界面的 PUT / DELETE、清失效、换链接都走这里，路由只做校验和 404。
 *
 *   - 删条目要连带停抄；这个分享没有别的条目在用了就不再巡检。
 *   - 改提取码是分享的事：同一个分享收的几处一起改（链接里的也换），改完查一次，没抄完的重新抄。
 *   - 换链接先确认新分享打得开；内容和原来差很多时 409 要人确认；换成整个新分享，索引清空重抄，标签备注保留。
 */
import type { LibraryShareHealth, MediaLibraryEntry } from "@openstrm/shared";
import { getById, listByShareCode, remove, update } from "../../db/repositories/media-library.js";
import { listExpiredCodes } from "../../db/repositories/library-shares.js";
import { childrenOf, deleteAll } from "../../db/repositories/library-nodes.js";
import { deleteUnits } from "../../db/repositories/library-units.js";
import { HttpError } from "../../lib/http-error.js";
import { driveErrorToHttp } from "../drive/errors.js";
import { matchShareLink, parseShareText } from "../drive/registry.js";
import { listWholeShareDir } from "../drive/share-walk.js";
import { sanitizeTags } from "./add.js";
import { checkShare, trackShare, untrackShareIfUnused } from "./health.js";
import { enqueueIndex, isWholeShare, stopIndexing } from "./indexer.js";

export interface EntryPatch {
  title?: string;
  coverUrl?: string;
  notes?: string;
  tags?: unknown[];
  receiveCode?: string;
}

/** 链接里的提取码换成新的：原链接用哪个参数名（password / pwd）就换哪个，没有就按网盘加 */
function withPassword(url: string, kind: string, password: string): string {
  try {
    const u = new URL(url);
    const key = u.searchParams.has("pwd") ? "pwd" : u.searchParams.has("password") ? "password" : kind === "quark" ? "pwd" : "password";
    if (password) u.searchParams.set(key, password);
    else u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 改标题 / 封面 / 备注 / 标签。给了提取码且和原来不一样：同一个分享收的几处一起改，改完查一次分享，
 * 打得开就把没抄完的重新排上，结果里带这次查到的 health。条目不存在回 null
 */
export async function updateEntry(id: string, patch: EntryPatch): Promise<(MediaLibraryEntry & { health?: LibraryShareHealth }) | null> {
  const current = getById(id);
  if (!current) return null;

  const updates: Partial<MediaLibraryEntry> = {};
  if (patch.title !== undefined) updates.title = patch.title.trim();
  if (patch.coverUrl !== undefined) updates.coverUrl = patch.coverUrl.trim();
  if (patch.notes !== undefined) updates.notes = patch.notes;
  if (patch.tags !== undefined) updates.tags = sanitizeTags(patch.tags);
  const merged = update(id, updates);
  if (!merged) return null;

  const receiveCode = patch.receiveCode?.trim();
  if (receiveCode === undefined || receiveCode === current.receiveCode) return merged;
  const kind = parseShareText(current.shareUrl)?.kind ?? "115";
  for (const s of listByShareCode(current.shareCode)) update(s.id, { receiveCode, shareUrl: withPassword(s.shareUrl, kind, receiveCode) });
  const health = await checkShare(current.shareCode);
  if (health.status !== "expired" && health.status !== "locked") {
    for (const s of listByShareCode(current.shareCode)) if (s.indexStatus !== "done") enqueueIndex(s.id);
  }
  return { ...getById(id)!, health };
}

/** 删条目：停抄、删记录；这个分享没有别的条目在用了就不再巡检。条目不存在回 false */
export function removeEntry(id: string): boolean {
  const entry = getById(id);
  if (!entry) return false;
  stopIndexing(id);
  remove(id);
  untrackShareIfUnused(entry.shareCode);
  return true;
}

/** 清理全部已失效的分享：只删收藏夹里的记录和索引，网盘和 strm 都不动 */
export function removeExpiredEntries(): { shares: number; sources: number } {
  const codes = listExpiredCodes();
  let sources = 0;
  for (const code of codes) {
    for (const s of listByShareCode(code)) {
      stopIndexing(s.id);
      remove(s.id);
      sources++;
    }
    untrackShareIfUnused(code);
  }
  return { shares: codes.length, sources };
}

/**
 * 换链接：上传者重发了新链接。先确认新链接打得开；和原来的内容差很多（根下的名字对上的不到三成）时 409 要确认。
 * 换成整个新分享，索引清空重抄，标签备注保留。条目不存在回 null
 */
export async function relinkEntry(id: string, opts: { shareUrl: string; confirm?: boolean }): Promise<MediaLibraryEntry | null> {
  const current = getById(id);
  if (!current) return null;
  const match = matchShareLink(opts.shareUrl);
  if (!match) {
    const ref = parseShareText(opts.shareUrl);
    throw new HttpError(400, ref ? "没有能打开这个分享的账号：先到「账户」页加一个" : "认不出这个分享链接");
  }
  const share = match.provider.share!;
  let title: string;
  let names: string[];
  try {
    const session = await share.open(match.ref);
    title = (await share.info(session)).title.trim();
    names = (await listWholeShareDir(share, session, "0")).map((e) => e.name);
  } catch (err) {
    throw driveErrorToHttp(err, "新链接打不开");
  }
  if (!opts.confirm) {
    const oldRoot = isWholeShare(current) ? "0" : current.shareRootCid;
    const oldNames = new Set(childrenOf(id, oldRoot).map((n) => n.name));
    if (oldNames.size > 0 && names.length > 0) {
      const overlap = names.filter((n) => oldNames.has(n)).length / Math.min(oldNames.size, names.length);
      if (overlap < 0.3) {
        throw new HttpError(409, `新链接「${title || match.ref.code}」里的内容和原来的对不上几条，确定要换吗？`, { code: "RELINK_MISMATCH", newTitle: title, overlap: Math.round(overlap * 100) });
      }
    }
  }
  stopIndexing(id);
  const oldCode = current.shareCode;
  update(id, {
    shareUrl: match.ref.url,
    shareCode: match.ref.code,
    receiveCode: match.ref.password,
    sharePath: "",
    shareRootCid: "",
    shareTitle: title,
    rawName: title || current.rawName,
  });
  trackShare(match.ref.code, match.ref.kind);
  if (oldCode !== match.ref.code) untrackShareIfUnused(oldCode);
  // 旧分享的索引作废：新旧分享的节点 id 不相干，先清干净再抄
  deleteAll(id);
  // 作品单元跟着换：新分享抄完再切
  deleteUnits(id);
  enqueueIndex(id);
  return getById(id);
}

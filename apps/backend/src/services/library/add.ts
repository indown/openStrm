/**
 * 把分享收进收藏夹：整个分享，或者其中一个目录（分享详情里进到那一层点「收藏」）。
 * 收藏夹页的 POST /api/library 和智能体的 library_add 共用这一份。
 *
 * 同一个分享的来源不重叠：已经收了它的上级（或整包）就不再收（409）；收了它下面的子目录，新的这条把它们吸收掉。
 */
import { randomUUID } from "node:crypto";
import type { MediaLibraryEntry } from "@openstrm/shared";
import { getShare } from "../../db/repositories/library-shares.js";
import { freshIndexFields, insert, listByShareCode, listWithHealth, remove, setIndexState } from "../../db/repositories/media-library.js";
import { HttpError } from "../../lib/http-error.js";
import { matchShareLink, parseShareText } from "../drive/registry.js";
import { normalizeTitle } from "../media-title.js";
import { trackShare } from "./health.js";
import { SHARE_EXPIRED_ERROR, SHARE_LOCKED_ERROR, enqueueIndex, isWholeShare, stopIndexing } from "./indexer.js";
import { libraryNameOf, withSuffix } from "./name.js";

export function randomId(): string {
  return randomUUID();
}

export function sanitizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 115 cid 可能超过 JS 安全整数，统一以字符串存储 */
export function shareRootCidForDb(cid: unknown): string {
  if (typeof cid === "string") return cid.trim();
  if (typeof cid === "number" && Number.isFinite(cid)) return String(cid);
  return "";
}

/** 分享内路径统一成不带首尾斜杠的样子再比 */
const normPath = (p: string) => p.replace(/^\/+|\/+$/g, "");
const isUnder = (child: string, parent: string) => parent === "" || child === parent || child.startsWith(`${parent}/`);

/** 同一个分享的这一层（`""` 是整包）已经被哪条收着：它自己、它的上级或者整包 */
export const coveringOf = (siblings: MediaLibraryEntry[], path: string) =>
  siblings.find((s) => isUnder(path, normPath(s.sharePath)) && (isWholeShare(s) || normPath(s.sharePath) !== ""));

/** 分享码现在记的死活（刚登记、还没查过是 unknown） */
const checkedHealth = (shareCode: string) => getShare(shareCode)?.status ?? "unknown";

export interface AddToLibraryInput {
  /** 分享链接；和转存框一样，整段「链接：… 提取码：…」也认 */
  shareUrl: string;
  title?: string;
  coverUrl?: string;
  tags?: unknown;
  notes?: string;
  /** 只收其中一个目录：目录 id、目录名、在分享里的路径 */
  cid?: string | number;
  rawName?: string;
  sharePath?: string;
}

export interface AddToLibraryResult {
  mode: "single" | "subdir";
  entry: MediaLibraryEntry;
  /** 被这一条吸收掉的子目录个数 */
  absorbed?: number;
}

/**
 * 收一条。链接认不出 400；已经收着 409（extra.data 是收着它的那条）。
 * 打不开也照样收：先登记分享码再去问网盘，旁听者当场记下死活，已经失效 / 提取码不对的直接标停、不去排队抄
 */
export async function addToLibrary(input: AddToLibraryInput): Promise<AddToLibraryResult> {
  // 存认出来的链接（提取码拼在里面），不存那一整段：收藏夹页、转存到任务都要按链接认网盘
  const ref = parseShareText(input.shareUrl);
  if (!ref) throw new HttpError(400, "Invalid share url");
  const shareUrl = ref.url;
  const shareCode = ref.code;
  const receiveCode = ref.password;

  const bodyTitle = (input.title ?? "").trim();
  const bodyCoverUrl = (input.coverUrl ?? "").trim();
  const bodyTags = sanitizeTags(input.tags);
  const bodyNotes = input.notes ?? "";
  const cidStr = shareRootCidForDb(input.cid);
  const bodyRawName = (input.rawName ?? "").trim();
  const subdir = Boolean(cidStr && cidStr !== "0" && bodyRawName);
  const now = Math.floor(Date.now() / 1000);

  const bodyPath = subdir ? (input.sharePath ?? "").split("/").map((s) => s.trim()).filter(Boolean).join("/") || bodyRawName : "";
  const sharePath = subdir ? `/${bodyPath}` : "";
  const siblings = listByShareCode(shareCode);
  const covering = coveringOf(siblings, bodyPath);
  if (covering) {
    const message = isWholeShare(covering)
      ? `已经在收藏夹里了：整个分享「${covering.shareTitle || covering.title || shareCode}」都收着`
      : normPath(covering.sharePath) === bodyPath
        ? subdir
          ? "该子目录已在收藏夹里"
          : "该分享已在收藏夹里"
        : `已经在收藏夹里了：它的上级目录「${covering.rawName || covering.title}」收着`;
    throw new HttpError(409, message, { data: covering });
  }
  const absorbed = siblings.filter((s) => !isWholeShare(s) && isUnder(normPath(s.sharePath), bodyPath));

  trackShare(shareCode, ref.kind);
  const match = matchShareLink(shareUrl);
  let shareTitle = "";
  if (match) {
    try {
      const session = await match.provider.share!.open(match.ref);
      shareTitle = (await match.provider.share!.info(session)).title.trim();
    } catch {
      // 打不开也照样收：旁听者记了死活，抄目录那边按它处理
    }
  }

  let entry: MediaLibraryEntry;
  if (subdir) {
    // 目录叫 `Season 2` 这种的，标题和年份从上一级的作品目录来（见 services/library/name.ts）
    const naming = libraryNameOf({ rawName: bodyRawName, title: "", sharePath });
    const { title: normTitle, year: normYear } = normalizeTitle(naming.query);
    entry = {
      id: randomId(),
      shareUrl,
      shareCode,
      receiveCode,
      sharePath,
      shareRootCid: cidStr,
      rawName: bodyRawName,
      title: bodyTitle || withSuffix(normTitle, naming.suffix) || bodyRawName,
      fileCount: 0,
      coverUrl: bodyCoverUrl,
      tags: bodyTags,
      notes: bodyNotes,
      mediaType: "unknown",
      tmdbId: null,
      year: normYear || "",
      overview: "",
      // 海报等抄完再定：看起来是一部作品才刮（见 indexer.ts 的 maybeScrape）
      scrapeStatus: "done",
      createdAt: now,
      updatedAt: now,
      shareTitle,
      ...freshIndexFields(),
    };
  } else {
    // 标题：给了就用给的，没给用分享自己的标题（打不开就先空着，抄目录时再补）
    const title = bodyTitle || shareTitle;
    entry = {
      id: randomId(),
      shareUrl,
      shareCode,
      receiveCode,
      sharePath: "",
      shareRootCid: "",
      rawName: title,
      title,
      fileCount: 0,
      coverUrl: bodyCoverUrl,
      tags: bodyTags,
      notes: bodyNotes,
      mediaType: "unknown",
      tmdbId: null,
      year: "",
      overview: "",
      scrapeStatus: "done",
      createdAt: now,
      updatedAt: now,
      shareTitle,
      ...freshIndexFields(),
    };
  }
  // 被吸收的子目录：标签、备注并过来
  for (const a of absorbed) {
    for (const t of a.tags) if (!entry.tags.includes(t)) entry.tags.push(t);
    if (a.notes.trim() && !entry.notes.includes(a.notes.trim())) entry.notes = entry.notes ? `${entry.notes}\n${a.notes.trim()}` : a.notes.trim();
  }
  insert(entry);
  for (const a of absorbed) {
    stopIndexing(a.id);
    remove(a.id);
  }
  // 刚才一查就是失效 / 提取码不对：直接标停，不去排队
  const health = checkedHealth(shareCode);
  if (health === "expired" || health === "locked") {
    setIndexState(entry.id, { indexStatus: "failed", indexError: health === "expired" ? SHARE_EXPIRED_ERROR : SHARE_LOCKED_ERROR });
  } else enqueueIndex(entry.id);
  const saved = listWithHealth().find((e) => e.id === entry.id) ?? entry;
  return { mode: subdir ? "subdir" : "single", entry: saved, ...(absorbed.length ? { absorbed: absorbed.length } : {}) };
}

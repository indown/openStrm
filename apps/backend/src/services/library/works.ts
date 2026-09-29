/**
 * 影库的「作品」视图：同一个 tmdbId 的单元合成一张卡（几个版本 / 几季），没认出的单元自己一张。
 * 已失效分享里的单元不进海报墙（转存不了），作品弹框的版本列表里照样列出来、标上。
 */
import type {
  LibraryConfidence,
  LibrarySeriesGroup,
  LibraryUnit,
  LibraryWork,
  LibraryWorkDetail,
  LibraryWorksResult,
  LibraryWorksSort,
  LibraryWorksView,
} from "@openstrm/shared";
import { getNode } from "../../db/repositories/library-nodes.js";
import { getShare } from "../../db/repositories/library-shares.js";
import * as units from "../../db/repositories/library-units.js";
import { getById, healthOf } from "../../db/repositories/media-library.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { parseShareRef } from "../drive/registry.js";
import { normalizeTitle } from "../organize/parse-name.js";
import { titleTags } from "../pansou/tags.js";
import { ownedOfUnit, ownedOfWork, type LocalOwned } from "./owned.js";
import { crumbsForNode } from "./search.js";

const CONF: LibraryConfidence[] = ["none", "low", "medium", "high"];

function groupToWork(g: units.WorkGroup): LibraryWork {
  return {
    key: `${g.mediaType}:${g.tmdbId}`,
    tmdbId: g.tmdbId,
    mediaType: g.mediaType,
    title: g.title,
    year: g.year,
    posterUrl: g.posterUrl,
    confidence: CONF[g.conf] ?? "none",
    versions: g.versions,
    shares: g.shares,
    videoCount: g.videoCount,
    size: g.size,
    seasons: g.seasons,
    addedAt: g.addedAt,
  };
}

function unitToWork(u: units.UnitRow): LibraryWork {
  return {
    key: `unit:${u.sourceId}:${u.unitKey}`,
    tmdbId: null,
    mediaType: null,
    title: u.parsedTitle || u.rawName,
    year: u.parsedYear,
    posterUrl: "",
    confidence: "none",
    versions: 1,
    shares: 1,
    videoCount: u.videoCount,
    size: u.size,
    seasons: u.seasons,
    addedAt: u.createdAt,
  };
}

const byTitle = (a: LibraryWork, b: LibraryWork) => a.title.localeCompare(b.title, "zh-CN", { numeric: true });

export interface WorksQuery {
  view: LibraryWorksView;
  sort: LibraryWorksSort;
  offset: number;
  limit: number;
  /** 名字里有（正式名、原名、英文名；没认出的看目录名），大小写、标点、全角半角不计较 */
  keyword?: string;
  /** `2024` 或者 `2020-2024` */
  year?: string;
}

/** `2024` / `2020-2024` / `2024-2020`：认不出返回 null（不筛） */
export function yearRange(text: string | undefined): [number, number] | null {
  const m = /^\s*(\d{4})\s*(?:[-~–至到]\s*(\d{4}))?\s*$/.exec(text ?? "");
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return a <= b ? [a, b] : [b, a];
}

/**
 * 海报墙：一次全聚合（收藏夹里的作品也就几千部），在内存里筛、排、切页。
 * owned：已经有了的作品键（ownedWorkKeys），给了就在每部上标 owned
 */
export function listWorks(q: WorksQuery, owned?: Set<string>): LibraryWorksResult {
  const groups = units.workGroups();
  const identified = groups.map(groupToWork);
  const unidentified = units.unidentifiedUnits().map(unitToWork);
  if (owned) for (const w of [...identified, ...unidentified]) if (owned.has(w.key)) w.owned = true;
  const status = units.unitStatusCounts();
  const counts = {
    all: identified.length,
    movie: identified.filter((w) => w.mediaType === "movie").length,
    tv: identified.filter((w) => w.mediaType === "tv").length,
    low: identified.filter((w) => w.confidence === "low").length,
    none: unidentified.length,
    pending: status.pending,
  };
  let list: LibraryWork[];
  switch (q.view) {
    case "movie":
      list = identified.filter((w) => w.mediaType === "movie");
      break;
    case "tv":
      list = identified.filter((w) => w.mediaType === "tv");
      break;
    case "low":
      list = identified.filter((w) => w.confidence === "low");
      break;
    case "none":
      list = unidentified;
      break;
    default:
      list = identified;
  }
  const kw = normalizeTitle(q.keyword ?? "");
  if (kw) {
    const names = new Map(groups.map((g) => [`${g.mediaType}:${g.tmdbId}`, [g.title, g.originalTitle, g.enTitle]]));
    list = list.filter((w) => (names.get(w.key) ?? [w.title]).some((n) => normalizeTitle(n).includes(kw)));
  }
  const years = yearRange(q.year);
  if (years) list = list.filter((w) => Number(w.year) >= years[0] && Number(w.year) <= years[1]);
  if (q.sort === "title") list.sort(byTitle);
  else if (q.sort === "year") list.sort((a, b) => (b.year || "0").localeCompare(a.year || "0") || byTitle(a, b));
  else list.sort((a, b) => b.addedAt - a.addedAt || byTitle(a, b));
  return {
    works: list.slice(q.offset, q.offset + q.limit),
    total: list.length,
    counts,
    tmdbConfigured: !!readAppSettings().tmdb?.apiKey?.trim(),
  };
}

/** 一个单元连同它在哪个分享、分享死活、打开 / 转存要的东西 */
export function unitView(u: units.UnitRow): LibraryUnit | null {
  const source = getById(u.sourceId);
  if (!source) return null;
  const node = getNode(u.sourceId, u.nodeId);
  const kind = parseShareRef(source.shareUrl)?.kind;
  const nameTags = titleTags(u.rawName);
  const item = (n: NonNullable<typeof node>) => ({ id: n.nodeId, name: n.name, isDir: n.isDir, parentId: n.parentId || "0", ...(n.token ? { token: n.token } : {}) });
  const saveItems = u.ownsDir
    ? node
      ? [item(node)]
      : []
    : u.fileIds.map((id) => getNode(u.sourceId, id)).filter((n): n is NonNullable<typeof node> => n !== null).map(item);
  return {
    sourceId: u.sourceId,
    unitKey: u.unitKey,
    nodeId: u.nodeId,
    parentId: node?.parentId ?? "",
    path: u.path,
    crumbs: crumbsForNode(u.sourceId, u.nodeId),
    rawName: u.rawName,
    ownsDir: u.ownsDir,
    fileIds: u.fileIds,
    saveItems,
    parsedTitle: u.parsedTitle,
    parsedYear: u.parsedYear,
    kindHint: u.kindHint,
    seasons: u.seasons,
    videoCount: u.videoCount,
    size: u.size,
    sampleFile: u.sampleFile,
    // 季另外列（seasons）：样例文件名里的「第 1 季」只是其中一季，别当成整个单元的
    tags: (nameTags.length > 0 || !u.sampleFile ? nameTags : titleTags(u.sampleFile)).filter((t) => !/^第 .+ 季$/.test(t)),
    status: u.status,
    work:
      u.tmdbId != null && u.mediaType && (u.status === "done" || u.status === "manual")
        ? {
            tmdbId: u.tmdbId,
            mediaType: u.mediaType,
            title: u.title,
            year: u.year,
            posterUrl: u.posterUrl,
            confidence: u.status === "manual" ? "high" : u.confidence,
            originalTitle: u.originalTitle,
            enTitle: u.enTitle,
            reason: u.status === "manual" ? "手动指定" : u.reason,
          }
        : null,
    candidates: u.candidates,
    shareKind: kind === "quark" ? "quark" : "115",
    shareCode: source.shareCode,
    shareUrl: source.shareUrl,
    shareTitle: source.shareTitle || source.title,
    ...(node?.token ? { token: node.token } : {}),
    health: healthOf(getShare(source.shareCode)),
    identifiedAt: u.identifiedAt,
    error: u.error,
  };
}

/** 单元转存的东西放在分享里哪个目录下：有自己目录的是上一级，散放的文件就是它自己 */
const folderOf = (u: LibraryUnit) => (u.ownsDir ? u.crumbs.slice(0, -1) : u.crumbs).at(-1)?.name || u.shareTitle;

/**
 * 一部剧的几季一季一个目录、分开放在同一个目录下（「纸牌屋 全6季」里一季一个目录，各是一个单元）：能一起转存的那几组。
 * 按目录分组（同一个分享里常有两套：旧版本、洗版各 6 季）；每个都要认得出是第几季、季不能重叠（重叠的是同一季的不同版本，
 * 挑一个存就行）；转存的条目不能重名（115 会把它们平铺进同一个目录）；分享失效的不算
 */
export function seriesGroupsOf(mediaType: "movie" | "tv" | null, list: LibraryUnit[]): LibrarySeriesGroup[] {
  if (mediaType !== "tv") return [];
  const byFolder = new Map<string, LibraryUnit[]>();
  for (const u of list) {
    if (u.health.status === "expired" || u.saveItems.length === 0) continue;
    const key = JSON.stringify([u.sourceId, u.saveItems[0].parentId]);
    byFolder.set(key, [...(byFolder.get(key) ?? []), u]);
  }
  const out: LibrarySeriesGroup[] = [];
  for (const group of byFolder.values()) {
    if (group.length < 2 || group.some((u) => u.seasons.length === 0)) continue;
    const seasons = group.flatMap((u) => u.seasons);
    const names = group.flatMap((u) => u.saveItems.map((i) => i.name));
    if (new Set(seasons).size !== seasons.length || new Set(names).size !== names.length) continue;
    const sorted = [...group].sort((a, b) => a.seasons[0] - b.seasons[0]);
    out.push({ folder: folderOf(sorted[0]), seasons: [...seasons].sort((a, b) => a - b), units: sorted.map((u) => `${u.sourceId}:${u.unitKey}`) });
  }
  return out;
}

/**
 * 作品弹框：`movie:123` / `tv:456` 是这部作品的所有单元；`unit:<来源>:<单元键>` 是那一个没认出的。
 * local：本地已有的作品索引（localOwned），没算好时给 null，owned 就只有从收藏夹存过的
 */
export function workDetail(key: string, local: LocalOwned | null = null): LibraryWorkDetail | null {
  const m = /^(movie|tv):(\d+)$/.exec(key);
  if (m) {
    const list = units.unitsOfWork(m[1] as "movie" | "tv", Number(m[2]));
    if (list.length === 0) return null;
    const views = list.map(unitView).filter((v): v is LibraryUnit => v !== null);
    const best = [...list].sort((a, b) => rankOf(b) - rankOf(a))[0];
    const work: LibraryWork = {
      key,
      tmdbId: Number(m[2]),
      mediaType: m[1] as "movie" | "tv",
      title: best.title,
      year: best.year,
      posterUrl: best.posterUrl,
      confidence: CONF[rankOf(best)] ?? "none",
      versions: list.length,
      shares: new Set(list.map((u) => u.sourceId)).size,
      videoCount: list.reduce((s, u) => s + u.videoCount, 0),
      size: Math.max(...list.map((u) => u.size)),
      seasons: [...new Set(list.flatMap((u) => u.seasons))].sort((a, b) => a - b),
      addedAt: Math.max(...list.map((u) => u.createdAt)),
    };
    const owned = ownedOfWork(work.mediaType!, work.tmdbId!, local);
    if (owned.length) work.owned = true;
    return { work, units: views, owned, seriesGroups: seriesGroupsOf(work.mediaType, views) };
  }
  const u = /^unit:([^:]+):(.+)$/.exec(key);
  if (!u) return null;
  const row = units.getUnit(u[1], u[2]);
  if (!row) return null;
  const view = unitView(row);
  if (!view) return null;
  const owned = ownedOfUnit(row);
  return { work: { ...unitToWork(row), ...(owned.length ? { owned: true } : {}) }, units: [view], owned, seriesGroups: [] };
}

function rankOf(u: units.UnitRow): number {
  if (u.status === "manual") return 3;
  return CONF.indexOf(u.confidence);
}

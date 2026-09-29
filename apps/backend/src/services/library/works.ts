/**
 * 影库的「作品」视图：同一个 tmdbId 的单元合成一张卡（几个版本 / 几季），没认出的单元自己一张。
 * 已失效分享里的单元不进海报墙（转存不了），作品弹框的版本列表里照样列出来、标上。
 */
import type { LibraryConfidence, LibraryUnit, LibraryWork, LibraryWorkDetail, LibraryWorksResult, LibraryWorksSort, LibraryWorksView } from "@openstrm/shared";
import { getNode } from "../../db/repositories/library-nodes.js";
import { getShare } from "../../db/repositories/library-shares.js";
import * as units from "../../db/repositories/library-units.js";
import { getById, healthOf } from "../../db/repositories/media-library.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { parseShareRef } from "../drive/registry.js";
import { titleTags } from "../pansou/tags.js";
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
}

/** 海报墙：一次全聚合（影库里的作品也就几千部），在内存里筛、排、切页 */
export function listWorks(q: WorksQuery): LibraryWorksResult {
  const identified = units.workGroups().map(groupToWork);
  const unidentified = units.unidentifiedUnits().map(unitToWork);
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

/** 作品弹框：`movie:123` / `tv:456` 是这部作品的所有单元；`unit:<来源>:<单元键>` 是那一个没认出的 */
export function workDetail(key: string): LibraryWorkDetail | null {
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
    return { work, units: views };
  }
  const u = /^unit:([^:]+):(.+)$/.exec(key);
  if (!u) return null;
  const row = units.getUnit(u[1], u[2]);
  if (!row) return null;
  const view = unitView(row);
  return view ? { work: unitToWork(row), units: [view] } : null;
}

function rankOf(u: units.UnitRow): number {
  if (u.status === "manual") return 3;
  return CONF.indexOf(u.confidence);
}

/**
 * 影库搜索：在抄来的目录树里按名字找目录。
 *
 *   - 候选：每个词都在目录的 search_text 里（路径各段 + 自己的名字 + 直接文件名，见 search-text.ts）；
 *     年份例外：还有别的词时，年份对上了加分、对不上照样给（目录名、剧集文件名里常常不写年份）
 *   - 排序：名字里就有全部词 > 靠文件名命中（「Forrest Gump」在文件名里）> 只靠上级目录的名字命中；
 *     名字等于 / 开头于 > 包含；年份对上的加分；直接放着视频的目录加分；浅的优先
 *   - 收拢：同一来源里祖先目录自己命中了，命中的子孙收进它（「神探夏洛克」下四个季目录不各占一条）；
 *     整个分享的根是虚拟的（名字就是分享标题），里面那层同名目录也命中时让目录顶上：它能直接转存
 *   - 每条带上够判断对不对的东西：子树视频数、视频样例、没有直接视频的给下一层目录名（季目录）
 *   - 失效分享里的单独数，要明细才给：不和有效的混在一起
 */
import type { LibraryCrumb, LibraryHit, LibraryHitFile, LibrarySearchResult, LibraryWorkRef } from "@openstrm/shared";
import { filesOfDirs, getNode, searchCandidates, subdirsOfDirs, type NodeRow, type SearchRow } from "../../db/repositories/library-nodes.js";
import { unitsAtNodes, unitsUnder, type UnitRow } from "../../db/repositories/library-units.js";
import { countIndexing, healthOf } from "../../db/repositories/media-library.js";
import { parseShareRef } from "../drive/registry.js";
import { titleTags } from "../pansou/tags.js";
import { filePartOf, isVideoName, normalizeForSearch, queryTerms } from "./search-text.js";

/** 一次最多拿多少候选去排序：够收拢一个大分类（「电影」这种词会命中一千多个目录） */
const CANDIDATE_LIMIT = 5000;
const FILES_PER_HIT = 3;

type Matched = LibraryHit["matched"];

interface Ranked {
  row: SearchRow;
  score: number;
  matched: Matched;
  childHits: number;
}

/** 年份（归一化以后的词）：还有别的词时只加分，不是必须 */
const YEAR_TERM = /^(?:19|20)\d{2}$/;
const YEAR_BONUS = 15;

function splitTerms(terms: string[]): { required: string[]; years: string[] } {
  const years = terms.filter((t) => YEAR_TERM.test(t));
  // 只有年份（「2046」「1917」本身就是片名）：照常都要有
  if (years.length === 0 || years.length === terms.length) return { required: terms, years: [] };
  return { required: terms.filter((t) => !YEAR_TERM.test(t)), years };
}

function rank(row: SearchRow, terms: string[], years: string[]): Ranked {
  const name = normalizeForSearch(row.name);
  // 认出来的正式名 / 原名 / 别名（作品单元的根目录才有）：和目录名一样算「名字命中」
  const aka = row.aka ? row.aka.split("|") : [];
  const inName = (t: string) => name.includes(t) || aka.some((a) => a.includes(t));
  const files = filePartOf(row.searchText);
  let matched: Matched;
  let score: number;
  if (terms.every(inName)) {
    matched = "name";
    const exact = terms.length === 1 && (name === terms[0] || aka.includes(terms[0]));
    const starts = name.startsWith(terms[0]) || aka.some((a) => a.startsWith(terms[0]));
    score = exact ? 100 : starts ? 85 : 70;
  } else if (terms.every((t) => inName(t) || files.includes(t))) {
    matched = "files";
    score = 50;
  } else {
    matched = "path";
    score = 10;
  }
  if (years.length > 0 && years.every((y) => row.searchText.includes(y))) score += YEAR_BONUS;
  if (row.videoCount > 0) score += 8;
  score -= Math.min(row.depth, 10) * 0.5;
  return { row, score, matched, childHits: 0 };
}

/**
 * 整个分享的根（节点 "0"）是虚拟的，名字就是分享标题；多数分享里只有一层同名目录。两个都命中时去掉根，
 * 让那个目录顶上（下面的命中收进它）：它能直接转存、路径也对，根只能打开了再挑
 */
function dropWrapperRoots(ranked: Ranked[]): Ranked[] {
  const tops = new Set<string>();
  for (const r of ranked) if (r.row.depth === 1 && r.matched !== "path") tops.add(`${r.row.sourceId}\t${normalizeForSearch(r.row.name)}`);
  if (tops.size === 0) return ranked;
  return ranked.filter((r) => !(r.row.depth === 0 && r.row.nodeId === "0" && tops.has(`${r.row.sourceId}\t${normalizeForSearch(r.row.name)}`)));
}

/** 祖先自己命中了（不是只靠路径）的，收进祖先 */
function collapse(ranked: Ranked[]): Ranked[] {
  const bySource = new Map<string, Map<string, Ranked>>();
  for (const r of ranked) {
    if (r.matched === "path") continue;
    let m = bySource.get(r.row.sourceId);
    if (!m) bySource.set(r.row.sourceId, (m = new Map()));
    m.set(r.row.path, r);
  }
  const kept: Ranked[] = [];
  for (const r of ranked) {
    const own = bySource.get(r.row.sourceId);
    let owner: Ranked | undefined;
    if (own) {
      const segs = r.row.path.split("/");
      for (let i = 1; i < segs.length; i++) {
        const hit = own.get(segs.slice(0, i).join("/"));
        if (hit && hit !== r) {
          owner = hit;
          break;
        }
      }
      // 整个分享的来源，根的 path 是空串
      if (!owner && r.row.depth > 0) {
        const root = own.get("");
        if (root && root !== r) owner = root;
      }
    }
    if (owner) owner.childHits++;
    else kept.push(r);
  }
  return kept;
}

const NOISE_WORD = /原盘|remux|蓝光|bluray|web|4k|2160|1080|720|杜比|视界|hdr|sdr|字幕|中字|双语|双音|国英|国粤|音轨|国配|豆瓣|评分|奥斯卡|高码|精修|特效|diy|单集|^共|全\d+季|^\d+(\.\d+)?g(b)?$|奈飞|迪士尼|系列|[二三四五六七八九十\d]部$/i;
/** 季、集标记：片名到这为止 */
const EPISODE_MARK = /^(?:s\d{1,2}(?:e\d{1,3})?|ep?\d{1,3}|season|第[\d一二三四五六七八九十百零]+[季集期])$/i;
const YEAR_TOKEN = /^(?:19|20)\d{2}$/;
const HAN = /\p{Script=Han}/u;

/** 按词挑片名：到第一个像发布信息、年份、季集的词为止（「|」是括号留下的界线） */
function pickTitle(text: string): string {
  const kept: string[] = [];
  let leadingYear = "";
  for (const t of text.split(/\s+/).filter(Boolean)) {
    const year = YEAR_TOKEN.test(t);
    if (t === "|" || year || EPISODE_MARK.test(t) || NOISE_WORD.test(t)) {
      if (kept.length) break;
      if (year) leadingYear ||= t;
      continue;
    }
    kept.push(t);
    // 中文名最多三段（后面多是演员、卖点），英文按词算、留到六个
    if (kept.length >= (kept.some((k) => HAN.test(k)) ? 3 : 6)) break;
  }
  // 「2046 (2004)」：片名本身像年份
  return kept.length ? kept.join(" ") : leadingYear;
}

/**
 * 从目录名提片名当找替代的关键词。
 *   - 点、下划线当空格（「Silo.S01.2160p」），数字中间的点不拆（「豆瓣8.8」「26.38GB」）；书名号里的就是片名
 *   - 【完结】[4K]{tmdb-1} 这种标签整个去掉，圆括号（年份、外文名）当片名的结尾；这样拿不出来再退一步只把括号当空格
 *   - 年份不带：和 pansou/normalize.ts 的 keywordFromName 同一个口径，塞进关键词只会让网上搜得更少；影库搜索里年份本来也只加分
 * 粗糙但够用（搜索框里还能改）；第二阶段换成整理那套去噪
 */
export function keywordOf(name: string): string {
  const spaced = name.replace(/[《》「」]/g, " ").replace(/(?<!\d)\.|\.(?!\d)|_/g, " ");
  return (
    pickTitle(spaced.replace(/【[^】]*】|\[[^\]]*\]|\{[^}]*\}/g, " ").replace(/[(（][^)）]*[)）]/g, " | ")) ||
    pickTitle(spaced.replace(/[【】[\]{}()（）]/g, " "))
  );
}

/** 一个节点的面包屑（作品弹框里的版本打开分享详情用） */
export function crumbsForNode(sourceId: string, nodeId: string): LibraryCrumb[] {
  const row = getNode(sourceId, nodeId);
  return row ? crumbsOf(row, new Map()) : [];
}

function crumbsOf(row: NodeRow, cache: Map<string, NodeRow | null>): LibraryCrumb[] {
  const get = (id: string): NodeRow | null => {
    const key = `${row.sourceId}\t${id}`;
    if (!cache.has(key)) cache.set(key, getNode(row.sourceId, id));
    return cache.get(key) ?? null;
  };
  const chain: NodeRow[] = [row];
  let cur: NodeRow | null = row;
  while (cur && cur.depth > 0) {
    cur = cur.parentId ? get(cur.parentId) : null;
    if (cur) chain.unshift(cur);
  }
  const root = chain[0];
  if (root.depth !== 0) {
    // 链断了（半路缺节点）：退回按路径，只有最后一段有 id
    const segs = row.path.split("/").filter(Boolean);
    return segs.map((name, i) => ({ id: i === segs.length - 1 ? row.nodeId : "", name }));
  }
  const crumbs: LibraryCrumb[] = [];
  if (root.nodeId !== "0") {
    // 子目录来源：来源根以上的几级只知道名字
    const segs = root.path.split("/").filter(Boolean);
    for (const s of segs.slice(0, -1)) crumbs.push({ id: "", name: s });
    crumbs.push({ id: root.nodeId, name: root.name });
  }
  for (const n of chain.slice(1)) crumbs.push({ id: n.nodeId, name: n.name });
  return crumbs;
}

const SUBDIRS_PER_HIT = 3;

const keyOf = (sourceId: string, nodeId: string) => `${sourceId}\t${nodeId}`;

function groupByParent(rows: NodeRow[], into: Map<string, NodeRow[]>): void {
  for (const r of rows) {
    const key = keyOf(r.sourceId, r.parentId);
    const list = into.get(key) ?? [];
    list.push(r);
    into.set(key, list);
  }
}

const byName = (a: NodeRow, b: NodeRow) => a.name.localeCompare(b.name, "zh-CN", { numeric: true });

function toHits(ranked: Ranked[]): LibraryHit[] {
  // 目录下的文件、子目录按来源一批取
  const filesByDir = new Map<string, NodeRow[]>();
  const subdirsByDir = new Map<string, NodeRow[]>();
  const sampleFilesByDir = new Map<string, NodeRow[]>();
  const bySource = new Map<string, string[]>();
  for (const r of ranked) {
    const list = bySource.get(r.row.sourceId) ?? [];
    list.push(r.row.nodeId);
    bySource.set(r.row.sourceId, list);
  }
  for (const [sourceId, ids] of bySource) {
    groupByParent(filesOfDirs(sourceId, ids), filesByDir);
    // 没有直接视频的（剧目录、分类目录）：看下一层目录，从第一个有视频的里挑样例
    const bare = ids.filter((id) => !(filesByDir.get(keyOf(sourceId, id)) ?? []).some((f) => isVideoName(f.name)));
    groupByParent(subdirsOfDirs(sourceId, bare), subdirsByDir);
    const sampleDirs: string[] = [];
    for (const id of bare) {
      const first = (subdirsByDir.get(keyOf(sourceId, id)) ?? []).sort(byName).find((d) => d.videoCount > 0);
      if (first) sampleDirs.push(first.nodeId);
    }
    groupByParent(filesOfDirs(sourceId, sampleDirs), sampleFilesByDir);
  }
  const cache = new Map<string, NodeRow | null>();
  return ranked.map((r) => {
    const row = r.row;
    const key = keyOf(row.sourceId, row.nodeId);
    const direct = (filesByDir.get(key) ?? []).filter((f) => isVideoName(f.name));
    const subdirs = direct.length ? [] : (subdirsByDir.get(key) ?? []);
    let files: LibraryHitFile[];
    if (direct.length) {
      // 几个视频的（电影 + 花絮、几个版本）按大小，正片在前；一集一集的按名字，别出来 EP01、EP02、EP06
      files = direct
        .sort(direct.length > FILES_PER_HIT ? byName : (a, b) => (b.size ?? 0) - (a.size ?? 0))
        .slice(0, FILES_PER_HIT)
        .map((f) => ({ name: f.name, size: f.size }));
    } else {
      const sampleDir = subdirs.find((d) => d.videoCount > 0);
      files = (sampleDir ? (sampleFilesByDir.get(keyOf(row.sourceId, sampleDir.nodeId)) ?? []) : [])
        .filter((f) => isVideoName(f.name))
        .sort(byName)
        .slice(0, FILES_PER_HIT)
        .map((f) => ({ name: f.name, size: f.size }));
    }
    // 标签：自己名字里的；没有就取下一层目录名（「末日地堡 S01 2023 4K高码率…」）的，再没有取视频文件名的
    let tags = titleTags(row.name);
    if (tags.length === 0 && subdirs.length) tags = [...new Set(subdirs.slice(0, SUBDIRS_PER_HIT).flatMap((d) => titleTags(d.name)))];
    if (tags.length === 0 && files.length) tags = titleTags(files[0].name);
    const kind = parseShareRef(row.shareUrl)?.kind;
    return {
      sourceId: row.sourceId,
      nodeId: row.nodeId,
      parentId: row.parentId,
      name: row.name,
      path: row.path,
      crumbs: crumbsOf(row, cache),
      shareKind: kind === "quark" ? "quark" : "115",
      shareCode: row.shareCode,
      shareUrl: row.shareUrl,
      shareTitle: row.shareTitle || row.sourceTitle,
      ...(row.token ? { token: row.token } : {}),
      size: row.size,
      videoCount: Math.max(row.videoTotal, row.videoCount),
      files,
      subdirs: subdirs.slice(0, SUBDIRS_PER_HIT).map((d) => d.name),
      subdirCount: subdirs.length,
      tags,
      matched: r.matched,
      childHits: r.childHits,
      keyword: keywordOf(row.name),
      health: healthOf({ status: row.shareStatus ?? "unknown", reason: row.shareReason ?? "", checkedAt: row.checkedAt, expiredAt: row.expiredAt }),
      indexedAt: row.indexedAt,
    };
  });
}

/** 认出来的单元 → 结果上挂的作品 */
export function workRefOf(u: UnitRow): LibraryWorkRef | undefined {
  if (u.tmdbId == null || !u.mediaType || (u.status !== "done" && u.status !== "manual")) return undefined;
  return { tmdbId: u.tmdbId, mediaType: u.mediaType, title: u.title, year: u.year, posterUrl: u.posterUrl, confidence: u.status === "manual" ? "high" : u.confidence };
}

/**
 * 结果挂上作品：命中的目录自己是作品单元的根，或者在某个单元里面（季目录在剧目录里）——从它往上找最近的一个。
 * 一个目录上挂着几个按标题拆出来的单元（分类目录里散放的几部）说不清是哪部，不挂。
 * 往上没有单元的（剧目录里一季一个单元、剧目录自己不是）：里面的单元全都认成了同一部才挂；分类目录、合集里是好几部，不挂
 */
function attachWorks(hits: LibraryHit[]): void {
  const bySource = new Map<string, LibraryHit[]>();
  for (const h of hits) {
    const list = bySource.get(h.sourceId) ?? [];
    list.push(h);
    bySource.set(h.sourceId, list);
  }
  for (const [sourceId, list] of bySource) {
    const ids = new Set<string>(["0"]);
    for (const h of list) {
      ids.add(h.nodeId);
      for (const c of h.crumbs) if (c.id) ids.add(c.id);
    }
    const byNode = new Map<string, UnitRow[]>();
    for (const u of unitsAtNodes(sourceId, [...ids])) {
      if (u.status === "ignored") continue;
      const arr = byNode.get(u.nodeId) ?? [];
      arr.push(u);
      byNode.set(u.nodeId, arr);
    }
    for (const h of list) {
      const chain = [h.nodeId, ...h.crumbs.map((c) => c.id).filter(Boolean).reverse(), "0"];
      const at = chain.map((id) => byNode.get(id)).find((units) => units !== undefined);
      if (at) {
        const ref = at.length === 1 ? workRefOf(at[0]) : undefined;
        if (ref) h.work = ref;
        continue;
      }
      if (!h.path) continue;
      const refs = unitsUnder(sourceId, h.path)
        .filter((u) => u.status !== "ignored")
        .map(workRefOf);
      const first = refs[0];
      if (first && refs.every((r) => r && r.mediaType === first.mediaType && r.tmdbId === first.tmdbId)) h.work = first;
    }
  }
}

export interface LibrarySearchOptions {
  q: string;
  limit?: number;
  offset?: number;
  /** 要不要失效分享里的明细（默认只给个数） */
  includeExpired?: boolean;
  /** 只在这个来源里搜 */
  sourceId?: string;
}

export function searchLibrary(opts: LibrarySearchOptions): LibrarySearchResult {
  const terms = queryTerms(opts.q);
  const indexing = countIndexing();
  if (terms.length === 0) return { hits: [], total: 0, expired: 0, indexing };
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const offset = Math.max(0, opts.offset ?? 0);
  const { required, years } = splitTerms(terms);
  const ranked = collapse(dropWrapperRoots(searchCandidates(required, CANDIDATE_LIMIT, opts.sourceId).map((row) => rank(row, required, years))));
  ranked.sort((a, b) => b.score - a.score || a.row.path.localeCompare(b.row.path));
  const expired = ranked.filter((r) => r.row.shareStatus === "expired");
  const alive = ranked.filter((r) => r.row.shareStatus !== "expired");
  const hits = toHits(alive.slice(offset, offset + limit));
  const expiredHits = opts.includeExpired ? toHits(expired.slice(0, limit)) : undefined;
  attachWorks(expiredHits ? [...hits, ...expiredHits] : hits);
  return {
    hits,
    total: alive.length,
    expired: expired.length,
    ...(expiredHits ? { expiredHits } : {}),
    indexing,
  };
}

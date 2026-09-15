/**
 * 本地 nfo 里能当作品证据的 tmdbid。按层级读 XML，只看根元素直属的子元素：
 *   - 演员 / 导演 / 合集块里的 <tmdbid> 是别人的，不算；
 *   - tvshow / movie：uniqueid type="tmdb"，没有再看 <tmdbid>；标题取 title + originaltitle；
 *   - episodedetails：只认 <tmdbid>（有的刮削器在这写剧的 id），uniqueid 是这一集自己的 id，不认；标题取 showtitle（title 是集名）；
 *   - season 和其它根：没有作品 id。发布组自带的纯文本说明没有根元素，什么都不给。
 * nfo 多半是上传者的刮削器写的，不一定对：识别时拿 TMDB 详情和 nfo 自己写的标题核对（identify.ts）。
 */
import path from "node:path";
import { readTextCapped } from "../../lib/fs.js";
import type { KnownId } from "./identify.js";
import type { Unit } from "./units.js";

export interface NfoFacts {
  /** 根元素名，小写：tvshow / movie / episodedetails / season … */
  root: string;
  /** 作品（剧 / 电影）的 tmdbid */
  tmdbId?: number;
  /** nfo 自己写的作品标题，拿来核对 id */
  titles: string[];
}

interface Child {
  name: string;
  attrs: string;
  text: string;
}

const RE_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/gi;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** 读 nfo 的根元素和它直属的子元素（更深的块整个跳过）；不是 XML 返回 null */
export function readNfoFacts(xml: string): NfoFacts | null {
  let root = "";
  let depth = 0;
  let open: Child | null = null;
  const children: Child[] = [];
  let last = 0;
  for (const m of xml.matchAll(RE_TOKEN)) {
    const at = m.index ?? 0;
    // 直属子元素里的文字（更深一层的元素里的不算）
    if (open && depth === 2) open.text += xml.slice(last, at);
    last = at + m[0].length;
    if (m[1] !== undefined) {
      if (open && depth === 2) open.text += m[1];
      continue;
    }
    const name = m[3];
    if (!name) continue; // 注释 / 声明 / DOCTYPE
    if (m[2] === "/") {
      if (depth === 2 && open) {
        children.push(open);
        open = null;
      }
      depth = Math.max(0, depth - 1);
      if (depth === 0 && root) break;
      continue;
    }
    const selfClosing = m[5] === "/";
    if (depth === 0) {
      root = name.toLowerCase();
      if (selfClosing) break;
      depth = 1;
    } else if (depth === 1) {
      if (selfClosing) children.push({ name, attrs: m[4], text: "" });
      else {
        open = { name, attrs: m[4], text: "" };
        depth = 2;
      }
    } else if (!selfClosing) depth++;
  }
  if (!root) return null;
  const texts = (tag: string) =>
    children
      .filter((c) => c.name.toLowerCase() === tag)
      .map((c) => decode(c.text).trim())
      .filter(Boolean);
  const idOf = (s: string) => (/^\d+$/.test(s) && Number(s) > 0 ? Number(s) : undefined);
  const tmdbTag = texts("tmdbid").map(idOf).find((n) => n !== undefined);
  const unique = children
    .filter((c) => c.name.toLowerCase() === "uniqueid" && /\btype\s*=\s*["']tmdb["']/i.test(c.attrs))
    .map((c) => idOf(decode(c.text).trim()))
    .find((n) => n !== undefined);
  if (root === "tvshow" || root === "movie") return { root, tmdbId: unique ?? tmdbTag, titles: [...texts("title"), ...texts("originaltitle")] };
  if (root === "episodedetails") return { root, tmdbId: tmdbTag, titles: texts("showtitle") };
  return { root, titles: [] };
}

const RE_WORK_NFO = /^(?:tvshow|movie)\.nfo$/i;
const RE_SEASON_NFO = /^season\.nfo$/i;
/** 一个单元最多读几个 nfo：够找到 tvshow.nfo / 电影 nfo，又不会把几十集的分集 nfo 全读一遍 */
const MAX_NFO_READS = 5;

/**
 * 单元里本地有的 nfo 给出的作品 tmdbid（随片下载到本地的才读得到；网盘上的不读）。
 * tvshow.nfo / movie.nfo 在前，其余按目录深浅；花絮目录里的和 season.nfo 不读
 */
export async function nfoEvidence(saveDir: string | null, unit: Unit): Promise<KnownId | null> {
  if (!saveDir) return null;
  const depthOf = (p: string) => p.split("/").length;
  const nfos = unit.files
    .filter((f) => f.kind === "nfo" && !f.inExtrasDir && !RE_SEASON_NFO.test(f.name))
    .sort((a, b) => Number(!RE_WORK_NFO.test(a.name)) - Number(!RE_WORK_NFO.test(b.name)) || depthOf(a.path) - depthOf(b.path) || a.path.localeCompare(b.path));
  for (const f of nfos.slice(0, MAX_NFO_READS)) {
    const text = await readTextCapped(path.join(saveDir, ...f.path.split("/")), 256 * 1024).catch(() => null);
    const facts = text ? readNfoFacts(text) : null;
    if (!facts?.tmdbId) continue;
    return {
      tmdbId: facts.tmdbId,
      mediaType: facts.root === "movie" ? "movie" : "tv",
      source: `本地 ${f.name} 里的 tmdbid`,
      titles: facts.titles,
      // 分集 nfo 里的 <tmdbid> 不一定是剧的：没写剧名就拿单元的标题核对
      strict: facts.root === "episodedetails",
    };
  }
  return null;
}

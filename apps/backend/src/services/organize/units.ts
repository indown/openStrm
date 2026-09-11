/**
 * 把范围里的文件分成「作品单元」：一部电影 / 一部剧（含所有季）是一个单元。纯函数。
 *
 *   - 直接含视频文件的目录是候选；目录名是 Season 1 / S01 / 第一季 / Specials 时单元根是上一级；
 *     花絮目录（extras / featurettes / 花絮）里的文件归上一级，标 inExtrasDir。
 *   - 一个候选目录里的视频解析出多个不同标题（电影堆、散集堆）就按标题 + 年份拆成多个单元。
 *   - 单元级标题以目录名为准（目录名通常是干净的「剧名 + 年份」），目录名解析不出标题再用文件名里最常见的。
 *   - 识别词先套在每个名字上；直指 tmdbid 的规则命中就带在单元上。
 */
import type { OrganizeFileKind } from "@openstrm/shared";
import { isExtrasDirName, parseMediaName, seasonDirNumber, type ParsedName } from "./parse-name.js";
import { applyRules, type DirectSpec, type ParsedRule } from "./rules.js";

/** 范围里的一项，路径相对任务 originPath，不带前导 / */
export interface ScopeEntry {
  path: string;
  isDir: boolean;
  id?: string;
  size?: number;
}

export interface UnitFile {
  path: string;
  name: string;
  stem: string;
  /** 小写、带点 */
  ext: string;
  kind: OrganizeFileKind;
  parsed: ParsedName;
  id?: string;
  size?: number;
  /** 所在季目录的季号（Season 02 → 2，Specials → 0）；不在季目录里就没有 */
  seasonFromDir?: number;
  inExtrasDir: boolean;
  /** 识别词直指 */
  direct?: DirectSpec;
}

export interface Unit {
  key: string;
  /** 单元根目录，相对任务 originPath；"" 是任务根 */
  rootPath: string;
  rawName: string;
  parsed: ParsedName;
  kindHint: "movie" | "tv" | "unknown";
  files: UnitFile[];
  direct?: DirectSpec;
  notes: string[];
}

export interface BuildUnitsOptions {
  /** 范围目录，相对任务 originPath；"" 是任务根 */
  scopePath: string;
  /** 范围目录的名字（任务根就是 originPath 的最后一段） */
  scopeName: string;
  videoExts: Set<string>;
  rules: ParsedRule[];
  libraryType?: "movie" | "tv" | "mixed";
}

export const SUBTITLE_EXTS = new Set([".srt", ".ass", ".ssa", ".sub", ".vtt", ".sup", ".idx"]);
export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tbn", ".gif"]);
export const AUDIO_EXTS = new Set([".mp3", ".flac", ".ogg", ".m4a", ".wav", ".opus", ".wma", ".aac", ".ape", ".dsf"]);

const extOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
};
const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export function fileKindOf(name: string, videoExts: Set<string>): OrganizeFileKind {
  const ext = extOf(name);
  if (!ext) return "other";
  if (SUBTITLE_EXTS.has(ext)) return "subtitle";
  if (ext === ".nfo") return "nfo";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "other";
  if (videoExts.has(ext)) return "video";
  return "other";
}

/** 名字先过识别词再解析 */
function parseWithRules(name: string, rules: ParsedRule[], subtitle = false): { parsed: ParsedName; direct?: DirectSpec } {
  const r = applyRules(name, rules);
  const parsed = parseMediaName(r.name, { subtitle });
  return { parsed, direct: r.direct };
}

/** 从文件所在目录往上找单元根：季目录 / 花絮目录归上一级 */
function unitRootFor(dir: string, scopePath: string): { root: string; seasonFromDir?: number; inExtrasDir: boolean } {
  let cur = dir;
  let seasonFromDir: number | undefined;
  let inExtrasDir = false;
  for (let hops = 0; hops < 3 && cur !== scopePath && cur.length >= scopePath.length; hops++) {
    const name = baseOf(cur);
    if (isExtrasDirName(name)) {
      inExtrasDir = true;
      cur = dirOf(cur);
      continue;
    }
    const season = seasonDirNumber(name);
    if (season !== null) {
      seasonFromDir ??= season;
      cur = dirOf(cur);
      continue;
    }
    break;
  }
  // 往上不能越出范围目录
  if (cur.length < scopePath.length) cur = scopePath;
  return { root: cur, seasonFromDir, inExtrasDir };
}

function titleKey(p: ParsedName): string {
  return `${p.title.toLowerCase()}|${p.year ?? ""}`;
}

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  let best: T | undefined;
  let bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

const hasEpisodeMarker = (p: ParsedName): boolean =>
  p.episode !== undefined || p.absolute !== undefined || p.season !== undefined || !!p.isSpecial || !!p.date;

type RootedFile = { file: UnitFile; root: string };

export function buildUnits(entries: ScopeEntry[], opts: BuildUnitsOptions): Unit[] {
  const scopePath = opts.scopePath.replace(/^\/+|\/+$/g, "");
  const rooted: RootedFile[] = [];
  for (const e of entries) {
    if (e.isDir) continue;
    const name = baseOf(e.path);
    const ext = extOf(name);
    if (ext === ".part" || ext === ".tmp" || ext === ".aria2" || name.startsWith(".")) continue;
    const kind = fileKindOf(name, opts.videoExts);
    const stem = ext ? name.slice(0, -ext.length) : name;
    const { parsed, direct } = parseWithRules(stem, opts.rules, kind === "subtitle");
    if (parsed.isSample) continue;
    const { root, seasonFromDir, inExtrasDir } = unitRootFor(dirOf(e.path), scopePath);
    rooted.push({ root, file: { path: e.path, name, stem, ext, kind, parsed, id: e.id, size: e.size, seasonFromDir, inExtrasDir, direct } });
  }

  // 按候选根分组
  const byRoot = new Map<string, UnitFile[]>();
  for (const { root, file } of rooted) {
    const list = byRoot.get(root) ?? [];
    list.push(file);
    byRoot.set(root, list);
  }

  const units: Unit[] = [];
  for (const [root, list] of byRoot) {
    const videos = list.filter((f) => f.kind === "video" && !f.inExtrasDir && !f.parsed.isExtra);
    if (videos.length === 0) continue; // 只有字幕 / 图片的目录不成单元
    const rootName = root ? baseOf(root) : opts.scopeName;
    const rootParsed = parseWithRules(rootName, opts.rules);
    const dirTitleOk = rootParsed.parsed.title.length > 0 && !/^(19|20)\d{2}$/.test(rootParsed.parsed.title);

    // 目录里视频的标题分布：目录名能当标题、且文件标题一致（或文件根本没标题）→ 一个单元；否则按文件标题拆
    const keys = videos.map((v) => titleKey(v.parsed));
    const distinct = new Set(keys.filter((k) => !k.startsWith("|")));
    const common = mostCommon(keys.filter((k) => !k.startsWith("|")));
    const commonShare = common ? keys.filter((k) => k === common).length / videos.length : 0;
    const anyMarker = videos.some((v) => hasEpisodeMarker(v.parsed) || v.seasonFromDir !== undefined);
    const single = dirTitleOk ? distinct.size <= 1 || commonShare >= 0.6 || anyMarker : distinct.size <= 1;

    if (single) {
      const fileParsed = videos.find((v) => titleKey(v.parsed) === common)?.parsed ?? videos[0].parsed;
      // 范围目录本身（用户选的那一层 / 任务根）名字不可靠：文件有一致的标题就用文件的；里面的目录名优先
      const atScopeRoot = root === scopePath;
      const useFiles = !dirTitleOk || (atScopeRoot && !!common && commonShare >= 0.6);
      const parsed: ParsedName = useFiles ? { ...fileParsed } : { ...rootParsed.parsed };
      // 另一边的标题也留作搜索候选（目录叫「怒呛人生」、文件叫 BEEF，两个都该试）
      const extra = (useFiles ? (dirTitleOk ? rootParsed.parsed.titles : []) : fileParsed.titles).filter((t) => t && !parsed.titles.includes(t));
      parsed.titles = [...parsed.titles, ...extra];
      units.push(makeUnit(root, rootName, parsed, list, rootParsed.direct, opts));
      continue;
    }
    // 拆：每个标题一个单元；非视频文件按同名前缀跟着视频走，跟不上的不进任何单元（原地不动）
    const groups = new Map<string, UnitFile[]>();
    for (const v of videos) {
      const k = titleKey(v.parsed);
      const g = groups.get(k) ?? [];
      g.push(v);
      groups.set(k, g);
    }
    const others = list.filter((f) => !videos.includes(f));
    for (const [k, vids] of groups) {
      const mine = others.filter((o) => vids.some((v) => o.stem.startsWith(v.stem) || titleKey(o.parsed) === k));
      const sample = vids[0];
      units.push(makeUnit(root, sample.parsed.title || rootName, sample.parsed, [...vids, ...mine], sample.direct, opts, `${root}|${k}`));
    }
  }

  units.sort((a, b) => a.rootPath.localeCompare(b.rootPath) || a.key.localeCompare(b.key));
  return units;
}

function makeUnit(
  root: string,
  rawName: string,
  parsed: ParsedName,
  files: UnitFile[],
  direct: DirectSpec | undefined,
  opts: BuildUnitsOptions,
  key = root || "(root)",
): Unit {
  const videos = files.filter((f) => f.kind === "video" && !f.inExtrasDir && !f.parsed.isExtra);
  const notes: string[] = [];
  const fileDirect = files.map((f) => f.direct).find(Boolean);
  const anyMarker = videos.some((v) => hasEpisodeMarker(v.parsed) || v.seasonFromDir !== undefined) || parsed.season !== undefined;
  let kindHint: Unit["kindHint"] = "unknown";
  const libDirect = direct?.mediaType ?? fileDirect?.mediaType;
  if (libDirect) kindHint = libDirect;
  else if (anyMarker) kindHint = "tv";
  else if (videos.length === 1) kindHint = "movie";
  else if (videos.length > 1) {
    // 多个视频、都没有集标记：同名不同画质是多版本电影；名字各不相同又拆不开就说不清
    const stems = new Set(videos.map((v) => titleKey(v.parsed)));
    kindHint = stems.size === 1 ? "movie" : "unknown";
    if (stems.size === 1) notes.push(`${videos.length} 个视频没有集数标记，按同一部电影的多个版本处理`);
  }
  if (kindHint === "unknown" && opts.libraryType && opts.libraryType !== "mixed") kindHint = opts.libraryType;
  // 年份：目录名没有就用文件里最常见的
  const year = parsed.year ?? mostCommon(videos.map((v) => v.parsed.year).filter((y): y is string => !!y));
  const unitParsed: ParsedName = { ...parsed, year };
  if (!unitParsed.title) {
    const t = mostCommon(videos.map((v) => v.parsed.title).filter(Boolean));
    if (t) {
      const sample = videos.find((v) => v.parsed.title === t)!;
      unitParsed.title = t;
      unitParsed.titles = sample.parsed.titles;
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { key, rootPath: root, rawName, parsed: unitParsed, kindHint, files, direct: direct ?? fileDirect, notes };
}

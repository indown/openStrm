/**
 * 规划：单元 + 识别结果 + 模板 → 每个文件的目标路径和动作。纯函数，不碰网盘。
 *
 *   keep      源 == 目标，不动
 *   rename    同一父目录只改名
 *   move      跨目录（可能同时改名）
 *   mkdir     目标目录不存在
 *   rmdir     执行后腾空的源目录（可关）
 *   conflict  目标已存在且不是同一节点 / 两个源指向同一目标 / 目标落进别的任务
 *   skip      没识别、没集数、找不到对应视频的字幕、不认识的文件
 *
 * 路径：输入输出都是相对任务 originPath 的路径；run.ts 落库时再拼成网盘绝对路径。
 */
import type { OrganizeAction, OrganizeFileKind, OrganizeMatch } from "@openstrm/shared";
import type { ResolvedOrganizeSettings } from "./settings.js";
import { pickCategory } from "./settings.js";
import { episodeToken, idTagFor, pad2, pad3, renderTemplate, type TemplateVars } from "./template.js";
import type { Unit, UnitFile } from "./units.js";

export interface PlannedItem {
  unitKey: string;
  kind: OrganizeFileKind;
  action: OrganizeAction;
  /** 相对任务 originPath */
  srcPath: string;
  dstPath: string;
  nodeId: string;
  reason: string;
}

export interface UnitPlan {
  unitKey: string;
  /** 整理后的作品根目录（相对任务 originPath）；没匹配上为空 */
  dstRoot: string;
  items: PlannedItem[];
  notes: string[];
}

export interface UnitPlanInput {
  unit: Unit;
  match: OrganizeMatch | null;
  seasonOverride: number | null;
  episodeOffset: number;
  /** `season:episode` → 集标题（开了集标题才有） */
  episodeTitles?: Map<string, string>;
  selected: boolean;
}

export interface PlanContext {
  settings: ResolvedOrganizeSettings;
  libraryType?: "movie" | "tv" | "mixed";
}

const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** poster / fanart 这些作品级的图片和 nfo：跟着作品目录走、名字不动 */
const ROOT_LEVEL_NAMES = /^(poster|fanart|banner|logo|clearart|clearlogo|thumb|landscape|backdrop|folder|disc|cover|tvshow|movie|season\d*(-poster|-banner|-landscape)?|season-specials(-poster)?)\d*\.[a-z0-9]+$/i;

function actionFor(src: string, dst: string): OrganizeAction {
  if (src === dst) return "keep";
  return dirOf(src) === dirOf(dst) ? "rename" : "move";
}

interface SeasonEpisode {
  season: number;
  episode: number;
  episodeEnd?: number;
  note?: string;
}

/**
 * 一集在哪一季第几集：文件自己的 S01E01 最可信；只有绝对集数时结合季目录 / TMDB 每季集数折算。
 * 用户给的季覆盖和集偏移最后套上。
 */
export function resolveEpisode(file: UnitFile, unit: Unit, match: OrganizeMatch, seasonOverride: number | null, episodeOffset: number): SeasonEpisode | null {
  const p = file.parsed;
  let season: number | undefined = p.season ?? file.seasonFromDir ?? unit.parsed.season;
  let episode: number | undefined = p.episode;
  let episodeEnd: number | undefined = p.episodeEnd;
  let note: string | undefined;
  if (p.isSpecial && p.season === undefined) season = 0;
  if (episode === undefined && p.absolute !== undefined) {
    episode = p.absolute;
    episodeEnd = p.absoluteEnd;
    const seasons = (match.seasons ?? []).filter((s) => s.season > 0).sort((a, b) => a.season - b.season);
    const inSeason = seasons.find((s) => s.season === (season ?? 1));
    // 绝对集数超过了这一季的集数：按前几季累加折算（只在没有明确季目录、或季目录里的号码明显超出时）
    if (inSeason && episode > inSeason.episodeCount && seasons.length > 1) {
      let remain = episode;
      let hit: { season: number; ep: number } | null = null;
      for (const s of seasons) {
        if (remain <= s.episodeCount) {
          hit = { season: s.season, ep: remain };
          break;
        }
        remain -= s.episodeCount;
      }
      if (hit && (season === undefined || file.seasonFromDir === undefined || hit.season === season)) {
        note = `第 ${episode} 集超过 S${pad2(season ?? 1)} 的 ${inSeason.episodeCount} 集，按绝对集数折算成 S${pad2(hit.season)}E${pad2(hit.ep)}`;
        season = hit.season;
        episode = hit.ep;
        if (episodeEnd !== undefined) episodeEnd = hit.ep + (p.absoluteEnd! - p.absolute!);
      }
    }
  }
  if (episode === undefined) return null;
  if (seasonOverride !== null) season = seasonOverride;
  if (season === undefined) season = p.isSpecial ? 0 : 1;
  episode += episodeOffset;
  if (episodeEnd !== undefined) episodeEnd += episodeOffset;
  if (episode < 0) return null;
  return { season, episode, episodeEnd, note };
}

function fileVars(file: UnitFile): TemplateVars {
  const t = file.parsed.tags;
  return {
    edition: file.parsed.edition,
    resolution: t.resolution,
    source: t.source,
    videoCodec: t.videoCodec,
    audio: t.audio,
    hdr: t.hdr,
    group: t.group,
    part: file.parsed.part !== undefined ? `part${file.parsed.part}` : "",
    ext: file.ext.replace(/^\./, ""),
    originalName: file.stem,
  };
}

/** 字幕的目标：视频主名 + 语言 + 标记 + 扩展名 */
function subtitleName(videoDst: string, sub: UnitFile): string {
  const stem = videoDst.replace(/\.[^./]+$/, "");
  const parts = [stem];
  if (sub.parsed.subtitleLang) parts.push(sub.parsed.subtitleLang);
  if (sub.parsed.forced) parts.push("forced");
  if (sub.parsed.sdh) parts.push("sdh");
  return `${parts.join(".")}${sub.ext}`;
}

export function planUnit(input: UnitPlanInput, ctx: PlanContext): UnitPlan {
  const { unit, match } = input;
  const notes: string[] = [...unit.notes];
  const items: PlannedItem[] = [];
  const push = (file: UnitFile, dst: string | null, reason = "", forced?: OrganizeAction) => {
    const action = forced ?? (dst === null ? "skip" : actionFor(file.path, dst));
    items.push({ unitKey: unit.key, kind: file.kind, action, srcPath: file.path, dstPath: dst ?? file.path, nodeId: file.id ?? "", reason });
  };

  if (!match) {
    for (const f of unit.files) push(f, null, "没有识别出作品");
    return { unitKey: unit.key, dstRoot: "", items, notes };
  }
  if (!input.selected) {
    for (const f of unit.files) push(f, null, "未勾选");
    return { unitKey: unit.key, dstRoot: "", items, notes };
  }

  const s = ctx.settings;
  const category = s.categories.enabled
    ? pickCategory(match.mediaType === "movie" ? s.categories.movie : s.categories.tv, {
        genreIds: match.genreIds,
        countries: match.countries,
        originalLanguage: match.originalLanguage,
      })
    : "";
  const common: TemplateVars = {
    category,
    title: match.title,
    originalTitle: match.originalTitle,
    enTitle: match.enTitle,
    year: match.year,
    tmdbId: match.tmdbId,
    imdbId: match.imdbId,
    idTag: idTagFor(s.idTag, match.tmdbId),
  };
  const template = match.mediaType === "movie" ? s.templates.movie : s.templates.tv;

  // 先规划视频：每个视频的目标路径；作品根目录 = 模板里含 {title} / {idTag} 的那一层及其之上的层
  const videoDst = new Map<UnitFile, string>();
  const videoKey = new Map<UnitFile, string>();
  const rootTemplate = (() => {
    const segs = template.split("/");
    const idx = segs.findIndex((seg) => /\{(title|originalTitle|enTitle|idTag|tmdbId)\}/.test(seg));
    return idx === -1 ? "" : segs.slice(0, idx + 1).join("/");
  })();
  const dstRoot = rootTemplate ? renderTemplate(rootTemplate, common, { colon: s.colon }).path : "";

  for (const f of unit.files) {
    if (f.kind !== "video" || f.inExtrasDir || f.parsed.isExtra) continue;
    let vars: TemplateVars = { ...common, ...fileVars(f) };
    if (match.mediaType === "tv") {
      const se = resolveEpisode(f, unit, match, input.seasonOverride, input.episodeOffset);
      if (!se) {
        push(f, null, "看不出是第几集");
        continue;
      }
      if (se.note) notes.push(`${f.name}：${se.note}`);
      const key = `${se.season}:${se.episode}`;
      vars = {
        ...vars,
        season: se.season,
        season00: pad2(se.season),
        episode: episodeToken(se.episode, se.episodeEnd, 0),
        episode00: episodeToken(se.episode, se.episodeEnd, 2),
        absolute: f.parsed.absolute,
        absolute000: f.parsed.absolute !== undefined ? pad3(f.parsed.absolute) : "",
        episodeTitle: input.episodeTitles?.get(key) ?? "",
      };
      videoKey.set(f, key);
    }
    const r = renderTemplate(template, vars, { colon: s.colon });
    if (r.errors.length > 0 || !r.path) {
      push(f, null, `模板有问题：${r.errors.join("；") || "空路径"}`);
      continue;
    }
    videoDst.set(f, r.path);
    push(f, r.path);
  }

  // 同一单元里两个视频算出同一个目标（画质标签一样的多版本）：后面的标冲突
  const seen = new Map<string, UnitFile>();
  for (const [f, dst] of videoDst) {
    const first = seen.get(dst);
    if (first) {
      const it = items.find((i) => i.srcPath === f.path)!;
      it.action = "conflict";
      it.reason = `和 ${first.name} 算出同一个目标名，请改模板加上 {source} / {group} 之类的区分`;
      videoDst.delete(f);
    } else seen.set(dst, f);
  }

  const videos = [...videoDst.keys()];
  const singleVideo = videos.length === 1 ? videos[0] : null;

  for (const f of unit.files) {
    if (f.kind === "video" && videoDst.has(f)) continue;
    if (f.kind === "video" && items.some((i) => i.srcPath === f.path)) continue; // 已经 skip / conflict 了

    // 花絮：按设置挪进 extras/ 或不动
    if (f.inExtrasDir || f.parsed.isExtra) {
      if (s.extras === "move" && dstRoot) push(f, join(join(dstRoot, "extras"), f.name));
      else push(f, f.path, "花絮不动", "keep");
      continue;
    }
    if (f.kind === "subtitle") {
      let video: UnitFile | undefined;
      if (match.mediaType === "tv") {
        const se = resolveEpisode(f, unit, match, input.seasonOverride, input.episodeOffset);
        if (se) video = videos.find((v) => videoKey.get(v) === `${se.season}:${se.episode}`);
      }
      if (!video) video = videos.find((v) => f.stem.startsWith(v.stem)) ?? singleVideo ?? undefined;
      if (!video) {
        push(f, null, "找不到对应的视频");
        continue;
      }
      push(f, subtitleName(videoDst.get(video)!, f));
      continue;
    }
    if (f.kind === "nfo" || f.kind === "image") {
      if (ROOT_LEVEL_NAMES.test(f.name)) {
        if (dstRoot) push(f, join(dstRoot, f.name));
        else push(f, null, "作品目录还没定");
        continue;
      }
      const video = videos.find((v) => f.stem === v.stem || f.stem.startsWith(`${v.stem}-`) || f.stem.startsWith(`${v.stem}.`)) ?? singleVideo;
      if (!video) {
        push(f, null, "找不到对应的视频");
        continue;
      }
      const vdst = videoDst.get(video)!;
      const suffix = f.stem.slice(video.stem.length);
      push(f, `${vdst.replace(/\.[^./]+$/, "")}${suffix}${f.ext}`);
      continue;
    }
    push(f, f.path, "不认识的文件类型，不动", "keep");
  }

  return { unitKey: unit.key, dstRoot, items, notes };
}

export interface DirOpsInput {
  /** 范围里所有条目（相对任务 originPath）：文件和目录 */
  entries: Array<{ path: string; isDir: boolean; id?: string }>;
  /** 范围目录本身：默认不删（`inbox` 这种收件箱），scopeRemovable 时（范围就是某个发布目录）腾空了也删 */
  scopePath: string;
  scopeRemovable?: boolean;
  items: PlannedItem[];
  cleanupEmptyDirs: boolean;
}

/**
 * 跨单元冲突检测 + 目录操作。返回完整的项列表（mkdir 在前、文件项在中、rmdir 在后）。
 *   - 两个源指向同一目标：后者冲突
 *   - 目标已存在且不是正被挪走的源：冲突
 *   - 目标目录缺失：mkdir（按深度）
 *   - 源目录腾空：rmdir（按深度倒序）
 */
export function finalizeItems(plans: UnitPlan[], input: DirOpsInput): PlannedItem[] {
  const items = plans.flatMap((p) => p.items);
  const existing = new Set(input.entries.map((e) => e.path));
  const existingDirs = new Set<string>();
  const dirIds = new Map<string, string>();
  for (const e of input.entries) {
    if (e.isDir) {
      existingDirs.add(e.path);
      if (e.id) dirIds.set(e.path, e.id);
    }
    let d = dirOf(e.path);
    while (d) {
      existingDirs.add(d);
      d = dirOf(d);
    }
  }
  const moving = items.filter((i) => i.action === "rename" || i.action === "move");
  const movingSrc = new Set(moving.map((i) => i.srcPath));
  const claimed = new Map<string, PlannedItem>();
  for (const it of moving) {
    const other = claimed.get(it.dstPath);
    if (other) {
      it.action = "conflict";
      it.reason = `目标和 ${baseOf(other.srcPath)} 重复`;
      continue;
    }
    if ((existing.has(it.dstPath) && !movingSrc.has(it.dstPath)) || existingDirs.has(it.dstPath)) {
      it.action = "conflict";
      it.reason = "目标已存在";
      continue;
    }
    // 跨目录且改名的项先在源目录里原地改名再挪：中间名字不能撞上源目录里不动的文件，也不能两个项撞同一个
    if (it.action === "move" && baseOf(it.srcPath) !== baseOf(it.dstPath)) {
      const intermediate = join(dirOf(it.srcPath), baseOf(it.dstPath));
      if ((existing.has(intermediate) && !movingSrc.has(intermediate)) || existingDirs.has(intermediate) || claimed.has(intermediate)) {
        it.action = "conflict";
        it.reason = `源目录里已有 ${baseOf(it.dstPath)}，改名会撞上`;
        continue;
      }
      claimed.set(intermediate, it);
    }
    claimed.set(it.dstPath, it);
  }

  // mkdir：目标的每一层祖先，不存在且没建过的
  const needDirs = new Set<string>();
  for (const it of items) {
    if (it.action !== "rename" && it.action !== "move") continue;
    let d = dirOf(it.dstPath);
    const chain: string[] = [];
    while (d && !existingDirs.has(d)) {
      chain.unshift(d);
      d = dirOf(d);
    }
    for (const c of chain) needDirs.add(c);
  }
  const mkdirs: PlannedItem[] = [...needDirs]
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .map((d) => ({ unitKey: "", kind: "dir", action: "mkdir", srcPath: d, dstPath: d, nodeId: "", reason: "" }));

  // rmdir：源目录里没剩东西的（按范围里的清单算）
  const rmdirs: PlannedItem[] = [];
  if (input.cleanupEmptyDirs) {
    const remaining = new Set<string>();
    for (const p of existing) if (!movingSrc.has(p)) remaining.add(p);
    for (const it of moving) if (it.action === "rename" || it.action === "move") remaining.add(it.dstPath);
    for (const d of needDirs) remaining.add(`${d}/`);
    const candidates = new Set<string>();
    for (const it of moving) {
      if (it.action !== "move") continue;
      let d = dirOf(it.srcPath);
      while (d && d !== input.scopePath && d.length > input.scopePath.length) {
        candidates.add(d);
        d = dirOf(d);
      }
      if (input.scopeRemovable && input.scopePath && d === input.scopePath) candidates.add(d);
    }
    const empty = (dir: string): boolean => {
      const prefix = `${dir}/`;
      for (const p of remaining) if (p.startsWith(prefix)) return false;
      return true;
    };
    for (const d of [...candidates].sort((a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a))) {
      if (!empty(d)) continue;
      rmdirs.push({ unitKey: "", kind: "dir", action: "rmdir", srcPath: d, dstPath: d, nodeId: dirIds.get(d) ?? "", reason: "" });
      // 目录自己也是一条条目（walkSubtree 会带目录项）：删掉它上级才算空，从深到浅正好逐层清
      remaining.delete(d);
    }
  }
  return [...mkdirs, ...items, ...rmdirs];
}

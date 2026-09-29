/**
 * 影库的作品单元：来源抄完后，拿索引里的文件跑整理的 buildUnits（不请求网盘）——季目录、花絮归上一级，
 * 合集里一部一个单元，散在分类目录里的文件按标题拆。识别词和整理共用；视频扩展名和影库数视频一个口径。
 *
 * 认出来的名字写到单元根节点的 aka 上给搜索用：只写「这部作品自己的目录」，或者整个来源只有这一部时写来源根
 * （分类目录里散放的几部片不写，免得搜片名搜到整个分类）。
 */
import { readKv, writeKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";
import * as nodes from "../../db/repositories/library-nodes.js";
import * as sources from "../../db/repositories/media-library.js";
import * as units from "../../db/repositories/library-units.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { moduleLogger } from "../../lib/logger.js";
import { parseRules } from "../organize/rules.js";
import { resolveOrganizeSettings } from "../organize/settings.js";
import { buildUnits, type ScopeEntry } from "../organize/units.js";
import { parseCjkNumber, parseMediaName } from "../organize/parse-name.js";
import { VIDEO_EXTS_DOTTED } from "./search-text.js";

const log = moduleLogger("library-units");

/** 切单元的规则版本：规则改了加一，启动时把抄完的来源重切一遍（按单元键保留识别结果；候选变了的重认）。2 = 补中文候选；3 = 品牌前缀、合集上一级、第一部的 1；4 = 电影合集里的「第 N 部」不当季 */
export const UNITS_VERSION = 4;

const HAN = /\p{Script=Han}/u;
/** 大包里常加在片名前面的系列 / 厂牌词：单拿出来去搜只会搜到不相干的纪录片 */
const BRAND = /^(?:漫威|迪士尼|皮克斯|梦工厂|吉卜力|宫崎骏|华纳|环球|DC)$/i;

/** 名字就是「第 1 部」「Part 2」「03」这种：片名在上一级（合集目录）上 */
const RE_PART_DIR = /^(?:第\s*[\d一二三四五六七八九十]+\s*[部集]|part\s*\d+|\d{1,2})(?:\s|$)/i;

/**
 * 影库补的搜索候选（整理只给目录名 / 文件名各一组；识别时按顺序搜前 5 个，搜到标题一样的就停，多给的只在前面搜不到时才花请求）：
 *   - 候选里一个中文的都没有（目录名开头是「007-17」被当成集数范围、或者就叫「第1部」，只剩文件名里的英文——还常被上传者故意
 *     拼错：GoIdenEye、Ait-Men）：年份后面的中文片名（「007-17 (1995) 黄金眼」→ 黄金眼）、上一级合集的片名（「漫威 蚁人 全3部」→
 *     漫威 蚁人、蚁人），排最前面
 *   - 几个词的中文标题：第一个词和最后一个词（「僵尸世界大战 布拉德皮特」后面是演员，「李小龙 猛龙过江」前面是演员），紧跟在它后面
 *   - 第一部带着「1」的（「侏罗纪公园1」「惊天营救1」）：去掉「1」（TMDB 上第一部不带数字）
 */
export function libraryTitleCandidates(rawName: string, titles: string[], parentName = ""): string[] {
  const out = [...titles];
  if (!out.some((t) => HAN.test(t))) {
    const lead: string[] = [];
    const m = /(?:^|[\s(（[【])(?:19|20)\d{2}[)）\]】]?\s+(.+)$/.exec(rawName);
    const after = m ? parseMediaName(m[1]).title : "";
    if (after && HAN.test(after)) lead.push(after);
    if (parentName && RE_PART_DIR.test(rawName.trim())) {
      const parent = parseMediaName(parentName).title;
      if (parent && HAN.test(parent)) {
        const words = parent.split(/\s+/);
        lead.push(BRAND.test(words[0]) && words.length >= 2 ? words.slice(1).join(" ") : parent);
        if (words.length >= 2) lead.push(words[words.length - 1]);
      }
    }
    out.unshift(...lead);
  }
  const firstHan = out.findIndex((t) => HAN.test(t));
  if (firstHan >= 0) {
    const words = out[firstHan].split(/\s+/);
    const extra: string[] = [];
    if (words.length >= 2 && words.every((w) => HAN.test(w))) {
      // 「漫威 黑豹1」：品牌前缀不是片名，拿掉它剩下的才是
      if (BRAND.test(words[0])) extra.push(words.slice(1).join(" "));
      else extra.push(words[0]);
      extra.push(words[words.length - 1]);
    }
    out.splice(firstHan + 1, 0, ...extra);
  }
  // 第一部的「1」：「侏罗纪公园1」→ 侏罗纪公园（紧跟在带 1 的后面）
  for (let i = out.length - 1; i >= 0; i--) {
    const stripped = /^(.*\p{Script=Han})[1Ⅰ]$/u.exec(out[i]);
    if (stripped) out.splice(i + 1, 0, stripped[1]);
  }
  return [...new Set(out.map((t) => t.trim()).filter(Boolean))];
}

/** 一个来源重切单元，再同步 aka。返回新增 / 删掉 / 要重认的个数 */
export function rebuildUnits(sourceId: string, now = Math.floor(Date.now() / 1000)): { total: number; added: number; removed: number; reset: number } {
  const tree = nodes.treeOf(sourceId);
  const root = tree.find((n) => n.depth === 0);
  if (!root) {
    const r = units.replaceUnits(sourceId, [], now);
    nodes.clearAka(sourceId);
    return { total: 0, ...r };
  }
  const settings = readAppSettings();
  const entries: ScopeEntry[] = tree.filter((n) => !n.isDir).map((n) => ({ path: n.path, isDir: false, id: n.nodeId, size: n.size ?? undefined }));
  const built = buildUnits(entries, {
    scopePath: root.path,
    taskRootName: root.name,
    videoExts: VIDEO_EXTS_DOTTED as Set<string>,
    rules: parseRules(resolveOrganizeSettings(settings).rules).rules,
    libraryType: "mixed",
  });
  const dirByPath = new Map(tree.filter((n) => n.isDir).map((n) => [n.path, n]));
  const rows: units.BuiltUnit[] = built.map((u) => {
    const dir = dirByPath.get(u.rootPath) ?? root;
    // buildUnits 的键：一个目录一部是根路径（根是 "(root)"），按标题拆开的是「根路径|标题|年份」
    const single = u.key === (u.rootPath || "(root)");
    const unitKey = single ? dir.nodeId : `${dir.nodeId}|${u.key.slice(u.rootPath.length + 1)}`;
    const parentPath = u.rootPath.includes("/") ? u.rootPath.slice(0, u.rootPath.lastIndexOf("/")) : "";
    let titles = libraryTitleCandidates(u.rawName, u.parsed.titles, u.rootPath ? (dirByPath.get(parentPath)?.name ?? "") : "");
    const videos = u.files.filter((f) => f.kind === "video" && !f.inExtrasDir && !f.parsed.isExtra);
    // 「碟中谍 第2部」：电影合集里的「第 N 部」是第 N 部电影，不是第 N 季（剧里的「第二部」视频都带集数，走不到这里）
    let kindHint = u.kindHint;
    const part = /第\s*([\d一二两三四五六七八九十]+)\s*部/.exec(u.rawName);
    const episodic = videos.some((v) => v.parsed.episode !== undefined || v.parsed.absolute !== undefined || v.parsed.date !== undefined);
    if (part && kindHint === "tv" && !episodic) {
      kindHint = "movie";
      const n = parseCjkNumber(part[1]);
      const base = titles.find((t) => HAN.test(t));
      if (n !== null && n >= 2 && base) titles = [...new Set([`${base}${n}`, ...titles])];
    }
    const others = u.files.filter((f) => !videos.includes(f));
    const biggest = [...videos].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
    const seasons = new Set<number>();
    if (kindHint === "tv") {
      for (const v of videos) {
        const n = v.parsed.season ?? v.seasonFromDir;
        if (n !== undefined) seasons.add(n);
      }
    }
    return {
      unitKey,
      nodeId: dir.nodeId,
      path: u.rootPath,
      rawName: u.rawName,
      ownsDir: u.ownsDir,
      fileIds: [...videos, ...others].map((f) => f.id).filter((id): id is string => !!id),
      // 主标题跟着候选的第一个走（换匹配弹框拿它当默认搜索词）
      parsedTitle: titles[0] ?? u.parsed.title,
      parsedTitles: titles,
      parsedYear: u.parsed.year ?? "",
      kindHint,
      seasons: [...seasons].sort((a, b) => a - b),
      videoCount: videos.length,
      size: videos.reduce((sum, f) => sum + (f.size ?? 0), 0),
      sampleFile: biggest?.name ?? "",
    };
  });
  const r = units.replaceUnits(sourceId, rows, now);
  syncAka(sourceId);
  return { total: rows.length, ...r };
}

/** aka 按单元重写一遍：只写自己的目录；整个来源就一部时写来源根 */
export function syncAka(sourceId: string): void {
  const list = units.unitsOfSource(sourceId).filter((u) => u.status !== "ignored");
  nodes.clearAka(sourceId);
  const byNode = new Map<string, number>();
  for (const u of list) byNode.set(u.nodeId, (byNode.get(u.nodeId) ?? 0) + 1);
  for (const u of list) {
    if (!u.aka) continue;
    // 同 identify.ts 的 applyAka：自己的目录，或者整个来源就这一部
    if (u.ownsDir || (list.length === 1 && byNode.get(u.nodeId) === 1)) nodes.setAka(sourceId, u.nodeId, u.aka);
  }
}

/**
 * 启动时：切单元的规则版本变了（或者从没切过：rc.1 升上来已经抄完的来源），把抄完的来源都重切一遍。
 * 只动本地库，不请求网盘；识别结果按单元键保留
 */
export function rebuildUnitsIfStale(): number {
  if (readKv<number>(KEY.libraryUnitsVersion) === UNITS_VERSION) return 0;
  let n = 0;
  for (const s of sources.getAll()) {
    if (s.indexStatus !== "done") continue;
    rebuildUnits(s.id);
    n++;
  }
  writeKv(KEY.libraryUnitsVersion, UNITS_VERSION);
  if (n > 0) log.info({ sources: n, version: UNITS_VERSION }, "影库按新规则重切了作品单元");
  return n;
}

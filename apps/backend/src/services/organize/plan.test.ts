/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/plan.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrganizeMatch } from "@openstrm/shared";
import { EXCLUDED_REASON, finalizeItems, planUnit, resolveEpisode, type ScopeRoot } from "./plan.js";
import { resolveOrganizeSettings } from "./settings.js";
import { buildUnits, type ScopeEntry } from "./units.js";

const settings = resolveOrganizeSettings({});
const videoExts = new Set([".mkv", ".mp4"]);
const entries = (paths: string[]): ScopeEntry[] => paths.map((p, i) => ({ path: p, isDir: false, id: `n${i}` }));

const beef: OrganizeMatch = {
  mediaType: "tv", tmdbId: 153312, title: "怒呛人生", originalTitle: "BEEF", enTitle: "BEEF", year: "2023", posterUrl: "",
  confidence: "high", reason: "test", seasons: [{ season: 1, episodeCount: 10 }, { season: 2, episodeCount: 8 }],
};
const dune: OrganizeMatch = {
  mediaType: "movie", tmdbId: 693134, title: "沙丘：第二部", originalTitle: "Dune: Part Two", year: "2024", posterUrl: "", confidence: "high", reason: "test",
};

function plan(paths: string[], match: OrganizeMatch, extra: Partial<Parameters<typeof planUnit>[0]> = {}, ctxSettings = settings) {
  const es = entries(paths);
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match, seasonOverride: null, episodeOffset: 0, selected: true, ...extra }, { settings: ctxSettings });
  return { unit, plan: p, items: finalizeItems([p], { entries: es, scopePath: "", items: p.items, cleanupEmptyDirs: true }) };
}

test("剧集：季目录 + 改名 + 字幕跟随 + 作品级 nfo/图片 + mkdir/rmdir", () => {
  const { plan: p, items } = plan(
    [
      "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv",
      "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt",
      "inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv",
      "inbox/BEEF.S01.1080p/tvshow.nfo",
      "inbox/BEEF.S01.1080p/poster.jpg",
    ],
    beef,
  );
  assert.equal(p.dstRoot, "怒呛人生 (2023) [tmdbid=153312]");
  const byName = (n: string) => items.find((i) => i.srcPath.endsWith(n))!;
  assert.equal(byName("S01E01.1080p.WEB-DL.mkv").dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.equal(byName("S01E01.1080p.WEB-DL.mkv").action, "move");
  assert.equal(byName("chs.srt").dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.zh-CN.srt");
  assert.equal(byName("tvshow.nfo").dstPath, "怒呛人生 (2023) [tmdbid=153312]/tvshow.nfo");
  assert.equal(byName("poster.jpg").dstPath, "怒呛人生 (2023) [tmdbid=153312]/poster.jpg");
  const mkdirs = items.filter((i) => i.action === "mkdir").map((i) => i.dstPath);
  assert.deepEqual(mkdirs, ["怒呛人生 (2023) [tmdbid=153312]", "怒呛人生 (2023) [tmdbid=153312]/Season 01"]);
  const rmdirs = items.filter((i) => i.action === "rmdir").map((i) => i.srcPath);
  assert.deepEqual(rmdirs, ["inbox/BEEF.S01.1080p", "inbox"], "腾空的源目录从深到浅");
});

test("清单里带目录项（夸克 / OpenList 的 walkSubtree）：子目录腾空删掉后上级也算空", () => {
  const es: ScopeEntry[] = [
    { path: "inbox", isDir: true, id: "d0" },
    { path: "inbox/BEEF.S01.1080p", isDir: true, id: "d1" },
    { path: "inbox/BEEF.S01.1080p/S01", isDir: true, id: "d2" },
    { path: "inbox/BEEF.S01.1080p/S01/BEEF.S01E01.1080p.WEB-DL.mkv", isDir: false, id: "n1" },
    { path: "inbox/BEEF.S01.1080p/S01/BEEF.S01E02.1080p.WEB-DL.mkv", isDir: false, id: "n2" },
  ];
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: p.items, cleanupEmptyDirs: true });
  const rmdirs = items.filter((i) => i.action === "rmdir");
  assert.deepEqual(rmdirs.map((i) => i.srcPath), ["inbox/BEEF.S01.1080p/S01", "inbox/BEEF.S01.1080p", "inbox"], "从深到浅逐层清");
  assert.deepEqual(rmdirs.map((i) => i.nodeId), ["d2", "d1", "d0"], "目录项自带的 id 跟着走");
});

test("范围目录本身：默认不删；范围就是发布目录（scopeRemovable）时腾空了也删", () => {
  const paths = ["inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv", "inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"];
  const es = entries(paths);
  const [unit] = buildUnits(es, { scopePath: "inbox/BEEF.S01.1080p", taskRootName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true }, { settings });
  const keep = finalizeItems([p], { entries: es, scopePath: "inbox/BEEF.S01.1080p", items: p.items, cleanupEmptyDirs: true });
  assert.deepEqual(keep.filter((i) => i.action === "rmdir").map((i) => i.srcPath), [], "没说可删就留着范围目录");
  const drop = finalizeItems([p], { entries: es, scopePath: "inbox/BEEF.S01.1080p", scopeRemovable: true, items: p.items, cleanupEmptyDirs: true });
  assert.deepEqual(drop.filter((i) => i.action === "rmdir").map((i) => i.srcPath), ["inbox/BEEF.S01.1080p"], "范围目录腾空了就删，但不碰上级 inbox");
  const still = finalizeItems([p], { entries: [...es, { path: "inbox/BEEF.S01.1080p/readme.txt", isDir: false, id: "x" }], scopePath: "inbox/BEEF.S01.1080p", scopeRemovable: true, items: p.items, cleanupEmptyDirs: true });
  assert.deepEqual(still.filter((i) => i.action === "rmdir"), [], "还剩东西就不删");
});

test("电影：多版本靠画质区分；已经规范的文件是 keep", () => {
  const { items } = plan(["m/Dune.Part.Two.2024.2160p.WEB-DL.mkv", "m/Dune.Part.Two.2024.1080p.WEB-DL.mkv"], dune);
  const dsts = items.filter((i) => i.kind === "video").map((i) => i.dstPath).sort();
  assert.deepEqual(dsts, [
    "沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 1080p.mkv",
    "沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv",
  ]);
  const done = plan(["沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv"], dune);
  assert.equal(done.items.filter((i) => i.kind === "video")[0].action, "keep");
  assert.equal(done.items.filter((i) => i.action === "mkdir").length, 0);
});

test("同一单元两个视频算出同一个目标名：后者冲突", () => {
  const { items } = plan(["m/Dune.Part.Two.2024.1080p.WEB-DL.x264.mkv", "m/Dune.Part.Two.2024.1080p.WEB-DL.x265.mkv"], dune);
  const actions = items.filter((i) => i.kind === "video").map((i) => i.action).sort();
  assert.deepEqual(actions, ["conflict", "move"]);
});

test("绝对集数按每季集数折算；季覆盖和集偏移", () => {
  const es = entries(["Show/[Sub] BEEF - 13 [1080p].mkv"]);
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const f = unit.files[0];
  assert.deepEqual(resolveEpisode(f, unit, beef, null, 0), { season: 2, episode: 3, episodeEnd: undefined, absolute: 13, note: "第 13 集超过 S01 的 10 集，按绝对集数折算成 S02E03" });
  assert.deepEqual(resolveEpisode(f, unit, beef, 3, 0), { season: 3, episode: 3, episodeEnd: undefined, absolute: 13, note: "第 13 集超过 S01 的 10 集，按绝对集数折算成 S02E03" });
  const es2 = entries(["Show/BEEF - 13 [1080p].mkv"]);
  const [u2] = buildUnits(es2, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  assert.deepEqual(resolveEpisode(u2.files[0], u2, { ...beef, seasons: undefined }, 1, -12), { season: 1, episode: 1, episodeEnd: undefined, absolute: 13, note: undefined });
});

test("没识别 / 没勾选：全部 skip；花絮按设置挪进 extras", () => {
  const none = plan(["x/a.mkv"], dune, { match: null });
  assert.ok(none.items.every((i) => i.action === "skip"));
  const unselected = plan(["x/a.mkv"], dune, { selected: false });
  assert.equal(unselected.items[0].reason, "未勾选");
  const keep = plan(["x/Dune.2024.mkv", "x/Featurettes/making.mkv"], dune);
  assert.equal(keep.items.find((i) => i.srcPath.endsWith("making.mkv"))!.action, "keep");
  const moved = plan(["x/Dune.2024.mkv", "x/Featurettes/making.mkv"], dune, {}, { ...settings, extras: "move" });
  assert.equal(moved.items.find((i) => i.srcPath.endsWith("making.mkv"))!.dstPath, "沙丘：第二部 (2024) [tmdbid=693134]/extras/making.mkv");
});

test("跨单元冲突：目标已存在（且不是正在挪走的源）", () => {
  const es = [...entries(["inbox/Dune.2024.1080p.mkv"]), { path: "沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 1080p.mkv", isDir: false }];
  const units = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const inbox = units.find((u) => u.rootPath === "inbox")!;
  const p = planUnit({ unit: inbox, match: dune, seasonOverride: null, episodeOffset: 0, selected: true }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: p.items, cleanupEmptyDirs: true });
  const v = items.find((i) => i.srcPath === "inbox/Dune.2024.1080p.mkv")!;
  assert.equal(v.action, "conflict");
  assert.equal(v.reason, "目标已存在");
});

test("二级分类开着时多一层目录，且作品根随之变化", () => {
  const cat = resolveOrganizeSettings({ organize: { categories: { enabled: true } } });
  const { plan: p } = plan(["m/Dune.Part.Two.2024.2160p.mkv"], { ...dune, genreIds: [878], originalLanguage: "en" }, {}, cat);
  assert.equal(p.dstRoot, "外语电影/沙丘：第二部 (2024) [tmdbid=693134]");
  const { plan: p2 } = plan(["m/Dune.Part.Two.2024.2160p.mkv"], { ...dune, genreIds: [16], originalLanguage: "ja" }, {}, cat);
  assert.equal(p2.dstRoot, "动画电影/沙丘：第二部 (2024) [tmdbid=693134]");
});

test("认成剧集、文件名只有标题末尾的数字：去掉数字正好是剧名的当集数，对不上的照旧跳过", () => {
  const show: OrganizeMatch = { ...beef, tmdbId: 84656, title: "回家的诱惑", originalTitle: "回家的诱惑", enTitle: "", year: "2011", seasons: [{ season: 1, episodeCount: 80 }] };
  const v = plan(["回家的诱惑/回家的诱惑69.mp4"], show).items.find((i) => i.kind === "video")!;
  assert.equal(v.dstPath, "回家的诱惑 (2011) [tmdbid=84656]/Season 01/回家的诱惑 - S01E69.mp4");
  const other = plan(["回家的诱惑/流浪地球2.mp4"], show).items.find((i) => i.kind === "video")!;
  assert.equal(other.action, "skip");
  assert.equal(other.reason, "看不出是第几集");
});

test("「同一部电影的多个版本」只在没认成剧集时提示", () => {
  const paths = ["m/Dune.Part.Two.2024.2160p.WEB-DL.mkv", "m/Dune.Part.Two.2024.1080p.WEB-DL.mkv"];
  const note = "2 个视频没有集数标记，按同一部电影的多个版本处理";
  assert.deepEqual(plan(paths, dune).plan.notes, [note]);
  assert.deepEqual(plan(paths, dune, { match: null }).plan.notes, [note]);
  assert.deepEqual(plan(paths, beef).plan.notes, [], "TMDB 认成剧集：这句话不对，不说");
});

const blackMirror: OrganizeMatch = {
  mediaType: "tv", tmdbId: 42009, title: "黑镜", originalTitle: "Black Mirror", year: "2011", posterUrl: "", confidence: "high", reason: "test", seasons: [{ season: 7, episodeCount: 6 }],
};

test("剧目录的整套刮削文件（本机 黑镜 (2011) 的文件名）：作品级进作品根、季目录里的 season.nfo 进新季目录、分集 nfo / thumb 跟着视频，一个不落、旧目录删掉", () => {
  const names = [
    "backdrop.jpg", "background.jpg", "banner.jpg", "characterart.png", "clearart.png", "clearlogo.png", "logo.png", "poster.jpg",
    "season02-banner.jpg", "season02-poster.jpg", "season02-thumb.jpg", "season07-poster.jpg", "thumb.jpg", "tvshow.nfo", "Season 7/season.nfo",
    ...[1, 2, 3].flatMap((n) => [`Season 7/黑镜 - S07E0${n} - 第 ${n} 集.mkv`, `Season 7/黑镜 - S07E0${n} - 第 ${n} 集.nfo`, `Season 7/黑镜 - S07E0${n} - 第 ${n} 集-thumb.jpg`]),
  ];
  const { items } = plan(names.map((n) => `黑镜 (2011)/${n}`), blackMirror);
  const root = "黑镜 (2011) [tmdbid=42009]";
  const dst = (n: string) => items.find((i) => i.srcPath === `黑镜 (2011)/${n}`)!.dstPath;
  for (const n of ["background.jpg", "characterart.png", "season02-thumb.jpg", "poster.jpg", "clearlogo.png", "tvshow.nfo", "season07-poster.jpg"]) assert.equal(dst(n), `${root}/${n}`, n);
  assert.equal(dst("Season 7/season.nfo"), `${root}/Season 07/season.nfo`, "季 nfo 进新季目录，不是剧根");
  assert.equal(dst("Season 7/黑镜 - S07E01 - 第 1 集.nfo"), `${root}/Season 07/黑镜 - S07E01.nfo`);
  assert.equal(dst("Season 7/黑镜 - S07E01 - 第 1 集-thumb.jpg"), `${root}/Season 07/黑镜 - S07E01-thumb.jpg`);
  assert.deepEqual(items.filter((i) => i.action === "skip" || i.action === "conflict").map((i) => i.srcPath), [], "一个都不落下");
  assert.deepEqual(items.filter((i) => i.action === "rmdir").map((i) => i.srcPath), ["黑镜 (2011)/Season 7", "黑镜 (2011)"]);
});

test("季目录里的 poster.jpg / season.nfo 进各自的新季目录；extrafanart 整个进作品目录；不再互相撞名", () => {
  const show: OrganizeMatch = { ...beef, tmdbId: 1, title: "某剧", originalTitle: "某剧", enTitle: "", year: "2020", seasons: [{ season: 1, episodeCount: 10 }, { season: 2, episodeCount: 10 }] };
  const { items } = plan(
    ["某剧 (2020)/poster.jpg", "某剧 (2020)/tvshow.nfo", "某剧 (2020)/extrafanart/fanart1.jpg", "某剧 (2020)/Season 1/poster.jpg", "某剧 (2020)/Season 1/season.nfo", "某剧 (2020)/Season 1/某剧.S01E01.mkv", "某剧 (2020)/Season 2/poster.jpg", "某剧 (2020)/Season 2/season.nfo", "某剧 (2020)/Season 2/某剧.S02E01.mkv"],
    show,
  );
  const root = "某剧 (2020) [tmdbid=1]";
  const dst = (p: string) => items.find((i) => i.srcPath === `某剧 (2020)/${p}`)!.dstPath;
  assert.equal(dst("poster.jpg"), `${root}/poster.jpg`);
  assert.equal(dst("Season 1/poster.jpg"), `${root}/Season 01/poster.jpg`);
  assert.equal(dst("Season 2/poster.jpg"), `${root}/Season 02/poster.jpg`);
  assert.equal(dst("Season 2/season.nfo"), `${root}/Season 02/season.nfo`);
  assert.equal(dst("extrafanart/fanart1.jpg"), `${root}/extrafanart/fanart1.jpg`);
  assert.deepEqual(items.filter((i) => i.action === "conflict" || i.action === "skip"), []);
});

test("并进已有作品目录：作品级图片 / nfo 撞名留在原处、不算冲突，源目录也不当成腾空", () => {
  const es: ScopeEntry[] = [
    ...entries(["Black.Mirror.S07.2160p/Black.Mirror.S07E01.2160p.mkv", "Black.Mirror.S07.2160p/poster.jpg", "Black.Mirror.S07.2160p/tvshow.nfo"]),
    { path: "黑镜 (2011) [tmdbid=42009]/poster.jpg", isDir: false },
    { path: "黑镜 (2011) [tmdbid=42009]/tvshow.nfo", isDir: false },
  ];
  const [unit] = buildUnits(es.slice(0, 3), { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match: blackMirror, seasonOverride: null, episodeOffset: 0, selected: true }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: [], cleanupEmptyDirs: true });
  const poster = items.find((i) => i.srcPath === "Black.Mirror.S07.2160p/poster.jpg")!;
  assert.deepEqual([poster.action, poster.reason], ["skip", "目标位置已经有同名的，留在原处"]);
  assert.equal(items.find((i) => i.srcPath === "Black.Mirror.S07.2160p/tvshow.nfo")!.action, "skip");
  assert.equal(items.filter((i) => i.action === "conflict").length, 0, "不卡自动整理");
  assert.equal(items.find((i) => i.srcPath.endsWith("S07E01.2160p.mkv"))!.action, "move");
  assert.deepEqual(items.filter((i) => i.action === "rmdir"), [], "源目录里还剩这两个，不删");
});

test("视频撞名留在原处：它的字幕 / nfo / thumb 跟着留下；源目录不当成腾空", () => {
  const es: ScopeEntry[] = [
    ...entries(["new/BEEF.S01E01.1080p.mkv", "new/BEEF.S01E01.1080p.chs.srt", "new/BEEF.S01E01.1080p.nfo", "new/BEEF.S01E01.1080p-thumb.jpg"]),
    { path: "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv", isDir: false },
  ];
  const [unit] = buildUnits(es.slice(0, 4), { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: [], cleanupEmptyDirs: true });
  const by = (suffix: string) => items.find((i) => i.srcPath.endsWith(suffix))!;
  assert.deepEqual([by("1080p.mkv").action, by("1080p.mkv").reason], ["conflict", "目标已存在"]);
  for (const s of ["chs.srt", "1080p.nfo", "thumb.jpg"]) assert.deepEqual([by(s).action, by(s).reason], ["skip", "对应的视频没挪，跟着留在原处"], s);
  assert.deepEqual(items.filter((i) => i.action === "rmdir"), [], "原来会把 new 当成腾空");
});

test("冲突留在原处的文件占着的名字，不再当成会腾出来：连环改名里前一环卡住，后一环也不挪进它的名字", () => {
  const dir = "怒呛人生 (2023) [tmdbid=153312]/Season 01";
  const es = entries([`${dir}/怒呛人生 - S01E00.mkv`, `${dir}/怒呛人生 - S01E01.mkv`, `${dir}/怒呛人生 - S01E02.mkv`]);
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  // 集偏移 -1：E02 → E01 的名字、E01 → E00 的名字；E00 自己算出来是第 -1 集，留在原处
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: -1, selected: true }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: [], cleanupEmptyDirs: true });
  const e = (n: string) => items.find((i) => i.srcPath.endsWith(`S01E${n}.mkv`))!.action;
  assert.deepEqual([e("00"), e("01"), e("02")], ["skip", "conflict", "conflict"], "E01 被 E00 挡住留下，E02 就不能改成 E01 的名字");
});

test("跟某个视频同名的 nfo：那个视频没排上（和别的版本撞了同一个目标）就跟着留下，不当成认不出的文件挪走", () => {
  const { items } = plan(
    ["m/Dune.Part.Two.2024.1080p.WEB-DL.x264.mkv", "m/Dune.Part.Two.2024.1080p.WEB-DL.x264.nfo", "m/Dune.Part.Two.2024.1080p.WEB-DL.x265.mkv", "m/Dune.Part.Two.2024.1080p.WEB-DL.x265.nfo"],
    dune,
  );
  const by = (n: string) => items.find((i) => i.srcPath === `m/Dune.Part.Two.2024.1080p.WEB-DL.${n}`)!;
  assert.equal(by("x265.mkv").action, "conflict");
  assert.deepEqual([by("x265.nfo").action, by("x265.nfo").reason], ["skip", "对应的视频没挪，跟着留在原处"]);
  assert.equal(by("x264.nfo").dstPath, "沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 1080p.nfo");
});

test("名字认不出的图片 / nfo：作品自己的目录里原名跟进作品目录，不硬配给视频、不截名", () => {
  const { items } = plan(["某片/某片.mkv", "某片/390561_front.jpg", "某片/RARBG.nfo"], dune);
  const dst = (n: string) => items.find((i) => i.srcPath === `某片/${n}`)!.dstPath;
  assert.equal(dst("390561_front.jpg"), "沙丘：第二部 (2024) [tmdbid=693134]/390561_front.jpg", "原来是「沙丘：第二部 (2024)0561_front.jpg」");
  assert.equal(dst("RARBG.nfo"), "沙丘：第二部 (2024) [tmdbid=693134]/RARBG.nfo");
  assert.deepEqual(items.filter((i) => i.action === "rmdir").map((i) => i.srcPath), ["某片"]);
});

test("删空目录不越过范围的根：根里面的腾空了删，根本身只在 removable 时删；没有根就一个都不删", () => {
  const es = entries(["inbox/BEEF.S01.1080p/S01/BEEF.S01E01.1080p.WEB-DL.mkv", "inbox/BEEF.S01.1080p/S01/BEEF.S01E02.1080p.WEB-DL.mkv"]);
  const [unit] = buildUnits(es, { scopePath: "inbox/BEEF.S01.1080p", taskRootName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true }, { settings });
  const rmdirs = (roots: ScopeRoot[]) => finalizeItems([p], { entries: es, scopeRoots: roots, items: [], cleanupEmptyDirs: true }).filter((i) => i.action === "rmdir").map((i) => i.srcPath);
  assert.deepEqual(rmdirs([{ path: "inbox/BEEF.S01.1080p", removable: false }]), ["inbox/BEEF.S01.1080p/S01"], "根不 removable：只删里面的");
  assert.deepEqual(rmdirs([{ path: "inbox/BEEF.S01.1080p", removable: true }]), ["inbox/BEEF.S01.1080p/S01", "inbox/BEEF.S01.1080p"], "根 removable：连根一起删，上级 inbox 不碰");
  assert.deepEqual(rmdirs([]), [], "没有根（新增路径是文件）：一个目录都不删");
});

test("字幕找主人：主人没排上（看不出集数）就跟着留下，不配给单元里唯一排上的那个视频；单元本来就一个视频时照旧跟它", () => {
  const { items } = plan(["怒呛人生/BEEF.S01E01.mkv", "怒呛人生/BEEF.Pilot.Unaired.mkv", "怒呛人生/BEEF.Pilot.Unaired.chs.srt"], beef);
  const sub = items.find((i) => i.srcPath.endsWith(".chs.srt"))!;
  assert.deepEqual([sub.action, sub.reason], ["skip", "对应的视频没挪，跟着留在原处"]);
  assert.equal(items.find((i) => i.srcPath.endsWith("S01E01.mkv"))!.action, "move");
  const single = plan(["某片/Dune.Part.Two.2024.2160p.mkv", "某片/chs.srt"], dune).items;
  assert.equal(single.find((i) => i.srcPath.endsWith("chs.srt"))!.action, "move", "名字对不上，但单元只有这一个视频");
});

test("单独取消勾选的文件：跳过，跟着它的字幕留下；同一集两个版本撞名时勾掉先排上的那份，另一份就能走", () => {
  const es = entries(["inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv", "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt", "inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"]);
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true, excluded: new Set(["inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"]) }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: [], cleanupEmptyDirs: true });
  const by = (n: string) => items.find((i) => i.srcPath.endsWith(n))!;
  assert.deepEqual([by("S01E01.1080p.WEB-DL.mkv").action, by("S01E01.1080p.WEB-DL.mkv").reason], ["skip", EXCLUDED_REASON]);
  assert.equal(by("chs.srt").action, "skip", "字幕跟着它的视频留下");
  assert.equal(by("S01E02.1080p.WEB-DL.mkv").action, "move");
  assert.ok(!items.some((i) => i.action === "rmdir" && i.srcPath === "inbox/BEEF.S01.1080p"), "源目录还有东西，不删");

  const two = entries(["x/BEEF.S01E01.1080p.WEB-DL.mkv", "x/BEEF.S01E01.720p.HDTV.mkv"]);
  const [u2] = buildUnits(two, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const clash = planUnit({ unit: u2, match: beef, seasonOverride: null, episodeOffset: 0, selected: true }, { settings }).items;
  assert.deepEqual(clash.map((i) => [i.srcPath, i.action]), [["x/BEEF.S01E01.1080p.WEB-DL.mkv", "move"], ["x/BEEF.S01E01.720p.HDTV.mkv", "conflict"]]);
  const resolved = planUnit({ unit: u2, match: beef, seasonOverride: null, episodeOffset: 0, selected: true, excluded: new Set(["x/BEEF.S01E01.1080p.WEB-DL.mkv"]) }, { settings }).items;
  assert.equal(resolved.find((i) => i.srcPath.endsWith("720p.HDTV.mkv"))!.action, "move");
});

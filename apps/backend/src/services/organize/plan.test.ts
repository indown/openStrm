/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/plan.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrganizeMatch } from "@openstrm/shared";
import { finalizeItems, planUnit, resolveEpisode } from "./plan.js";
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
  const [unit] = buildUnits(es, { scopePath: "", scopeName: "root", videoExts, rules: [] });
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
  const [unit] = buildUnits(es, { scopePath: "", scopeName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: p.items, cleanupEmptyDirs: true });
  const rmdirs = items.filter((i) => i.action === "rmdir");
  assert.deepEqual(rmdirs.map((i) => i.srcPath), ["inbox/BEEF.S01.1080p/S01", "inbox/BEEF.S01.1080p", "inbox"], "从深到浅逐层清");
  assert.deepEqual(rmdirs.map((i) => i.nodeId), ["d2", "d1", "d0"], "目录项自带的 id 跟着走");
});

test("范围目录本身：默认不删；范围就是发布目录（scopeRemovable）时腾空了也删", () => {
  const paths = ["inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv", "inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"];
  const es = entries(paths);
  const [unit] = buildUnits(es, { scopePath: "inbox/BEEF.S01.1080p", scopeName: "BEEF.S01.1080p", videoExts, rules: [] });
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
  const [unit] = buildUnits(es, { scopePath: "", scopeName: "root", videoExts, rules: [] });
  const f = unit.files[0];
  assert.deepEqual(resolveEpisode(f, unit, beef, null, 0), { season: 2, episode: 3, episodeEnd: undefined, note: "第 13 集超过 S01 的 10 集，按绝对集数折算成 S02E03" });
  assert.deepEqual(resolveEpisode(f, unit, beef, 3, 0), { season: 3, episode: 3, episodeEnd: undefined, note: "第 13 集超过 S01 的 10 集，按绝对集数折算成 S02E03" });
  const es2 = entries(["Show/BEEF - 13 [1080p].mkv"]);
  const [u2] = buildUnits(es2, { scopePath: "", scopeName: "root", videoExts, rules: [] });
  assert.deepEqual(resolveEpisode(u2.files[0], u2, { ...beef, seasons: undefined }, 1, -12), { season: 1, episode: 1, episodeEnd: undefined, note: undefined });
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
  const units = buildUnits(es, { scopePath: "", scopeName: "root", videoExts, rules: [] });
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

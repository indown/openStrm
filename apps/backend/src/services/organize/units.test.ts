/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/units.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRules } from "./rules.js";
import { buildUnits, type ScopeEntry } from "./units.js";

const videoExts = new Set([".mkv", ".mp4"]);
const files = (paths: string[]): ScopeEntry[] => paths.map((p, i) => ({ path: p, isDir: false, id: `n${i}` }));
const opts = { scopePath: "", scopeName: "tv", videoExts, rules: [] as ReturnType<typeof parseRules>["rules"] };

test("一部剧一个目录：季目录归上一级，字幕 / nfo 跟着走", () => {
  const units = buildUnits(
    files([
      "怒呛人生/Season 1/BEEF.S01E01.1080p.WEB-DL.mkv",
      "怒呛人生/Season 1/BEEF.S01E01.1080p.WEB-DL.chs.srt",
      "怒呛人生/Season 1/BEEF.S01E02.1080p.WEB-DL.mkv",
      "怒呛人生/tvshow.nfo",
      "怒呛人生/poster.jpg",
    ]),
    opts,
  );
  assert.equal(units.length, 1);
  const u = units[0];
  assert.equal(u.rootPath, "怒呛人生");
  assert.equal(u.parsed.title, "怒呛人生");
  assert.equal(u.kindHint, "tv");
  assert.equal(u.files.length, 5);
  const ep1 = u.files.find((f) => f.name === "BEEF.S01E01.1080p.WEB-DL.mkv")!;
  assert.equal(ep1.seasonFromDir, 1);
  assert.equal(ep1.parsed.episode, 1);
  const sub = u.files.find((f) => f.kind === "subtitle")!;
  assert.equal(sub.parsed.subtitleLang, "zh-CN");
});

test("电影目录：一个视频没有集标记就是电影；同名多版本也是电影", () => {
  const units = buildUnits(
    files([
      "Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX/Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv",
      "Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX/Dune.Part.Two.2024.1080p.WEB-DL.mkv",
      "Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX/sample.mkv",
    ]),
    { ...opts, scopeName: "movie" },
  );
  assert.equal(units.length, 1);
  assert.equal(units[0].kindHint, "movie");
  assert.equal(units[0].parsed.title, "Dune Part Two");
  assert.equal(units[0].parsed.year, "2024");
  assert.equal(units[0].files.length, 2, "sample 不进单元");
});

test("扁平的电影堆：按标题拆成多个单元；字幕按同名前缀跟着视频", () => {
  const units = buildUnits(
    files([
      "dump/Avatar.2009.1080p.BluRay.mkv",
      "dump/Avatar.2009.1080p.BluRay.chs.srt",
      "dump/Inception.2010.1080p.BluRay.mkv",
      "dump/readme.txt",
    ]),
    opts,
  );
  assert.equal(units.length, 2);
  const avatar = units.find((u) => u.parsed.title === "Avatar")!;
  assert.equal(avatar.rootPath, "dump");
  assert.equal(avatar.files.length, 2);
  assert.equal(avatar.kindHint, "movie");
  assert.ok(units.every((u) => !u.files.some((f) => f.name === "readme.txt")), "跟不上视频的杂项不进单元");
});

test("任务根直接放集（字幕组风格）：范围名当标题，绝对集数", () => {
  const units = buildUnits(
    files(["[Nekomoe kissaten][Sousou no Frieren][01][1080p][JPSC].mp4", "[Nekomoe kissaten][Sousou no Frieren][02][1080p][JPSC].mp4"]),
    { ...opts, scopeName: "inbox" },
  );
  assert.equal(units.length, 1);
  assert.equal(units[0].rootPath, "");
  assert.equal(units[0].parsed.title, "Sousou no Frieren", "范围名 inbox 解析不出作品，退回文件标题");
  assert.equal(units[0].kindHint, "tv");
  assert.equal(units[0].files[0].parsed.absolute, 1);
});

test("花絮目录里的文件归上一级并标记；库类型先验给没有标记的单元定类型", () => {
  const units = buildUnits(files(["Show (2020)/Featurettes/making.mkv", "Show (2020)/S01E01.mkv"]), opts);
  assert.equal(units.length, 1);
  const extra = units[0].files.find((f) => f.name === "making.mkv")!;
  assert.equal(extra.inExtrasDir, true);
  const movies = buildUnits(files(["Some Title/Some.Title.mkv", "Some Title/Some.Title.CD2.mkv"]), { ...opts, libraryType: "movie" });
  assert.equal(movies[0].kindHint, "movie");
});

test("识别词：直指 tmdbid 挂在单元上，屏蔽词先于解析", () => {
  const { rules } = parseRules(["某某剧 第二部 => {[tmdbid=95396;type=tv;s=2]}", "高清剧集"]);
  const units = buildUnits(files(["【高清剧集】某某剧 第二部/01.mkv", "【高清剧集】某某剧 第二部/02.mkv"]), { ...opts, rules });
  assert.equal(units.length, 1);
  assert.deepEqual(units[0].direct, { tmdbId: 95396, mediaType: "tv", season: 2 });
  assert.equal(units[0].kindHint, "tv");
});

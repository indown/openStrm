/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/template.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanValue, episodeToken, idTagFor, renderTemplate, validateTemplate } from "./template.js";
import { DEFAULT_TEMPLATES } from "./settings.js";

const movie = { title: "沙丘：第二部", year: "2024", idTag: "[tmdbid=693134]", resolution: "2160p", ext: "mkv" };

test("默认电影模板：可选段和空分类段", () => {
  const r = renderTemplate(DEFAULT_TEMPLATES.movie, movie);
  assert.deepEqual(r.errors, []);
  assert.equal(r.path, "沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv");
  const withCat = renderTemplate(DEFAULT_TEMPLATES.movie, { ...movie, category: "电影", edition: "导演剪辑版" });
  assert.equal(withCat.path, "电影/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 导演剪辑版 - 2160p.mkv");
  const noRes = renderTemplate(DEFAULT_TEMPLATES.movie, { ...movie, resolution: "" });
  assert.equal(noRes.path, "沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024).mkv");
});

test("默认剧集模板：季集补零、多集范围、集标题可选", () => {
  const r = renderTemplate(DEFAULT_TEMPLATES.tv, { title: "怒呛人生", year: "2023", idTag: "[tmdbid=153312]", season00: "01", episode00: episodeToken(1, undefined, 2), ext: "mkv" });
  assert.equal(r.path, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  const multi = renderTemplate(DEFAULT_TEMPLATES.tv, { title: "怒呛人生", year: "2023", idTag: "[tmdbid=153312]", season00: "01", episode00: episodeToken(1, 2, 2), episodeTitle: "飞鸟不鸣", ext: "mkv" });
  assert.equal(multi.path, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01-E02 - 飞鸟不鸣.mkv");
});

test("变量清洗：冒号策略、非法字符、斜杠", () => {
  assert.equal(cleanValue("Mission: Impossible", "smart"), "Mission - Impossible");
  assert.equal(cleanValue("Mission:Impossible", "smart"), "Mission-Impossible");
  assert.equal(cleanValue("Mission: Impossible", "delete"), "Mission Impossible");
  assert.equal(cleanValue("Mission: Impossible", "dash"), "Mission- Impossible");
  assert.equal(cleanValue("Mission: Impossible", "spaceDash"), "Mission - Impossible");
  assert.equal(cleanValue('What? <Why> "Who" | 1/2'), "What Why Who  1-2".replace(/\s{2,}/g, " "));
  assert.equal(cleanValue("  Trailing. "), "Trailing");
  assert.equal(cleanValue("沙丘：第二部"), "沙丘：第二部", "全角冒号原样保留");
});

test("超长段：截标题不截扩展名", () => {
  const long = "很长".repeat(120);
  const r = renderTemplate("{title}.{ext}", { title: long, ext: "mkv" }, { maxSegmentBytes: 60 });
  assert.ok(r.path.endsWith(".mkv"));
  assert.ok(Buffer.byteLength(r.path, "utf8") <= 60);
});

test("模板校验：未知变量、括号不配对、缺 ext", () => {
  assert.deepEqual(validateTemplate(DEFAULT_TEMPLATES.tv), []);
  assert.match(validateTemplate("{titel}.{ext}")[0], /titel/);
  assert.match(validateTemplate("{title}[ - {year}.{ext}").join("\n"), /\[/);
  assert.match(validateTemplate("{title}").join("\n"), /ext/);
});

test("转义和 id 标签风格", () => {
  assert.equal(renderTemplate("\\[{title}\\].{ext}", { title: "A", ext: "mkv" }).path, "[A].mkv");
  assert.equal(idTagFor("emby", 1), "[tmdbid=1]");
  assert.equal(idTagFor("jellyfin", 1), "[tmdbid-1]");
  assert.equal(idTagFor("plex", 1), "{tmdb-1}");
  assert.equal(idTagFor("none", 1), "");
  assert.equal(idTagFor("emby", undefined), "");
});

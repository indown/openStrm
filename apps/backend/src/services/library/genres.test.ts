/**
 * 收藏夹按类型、国家 / 地区筛：口头叫法换成 TMDB 的类型编号、地区代码；编号 / 代码换回中文名。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/library/genres.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { countryCodesOf, countryNames, genreIdsOf, genreNames } from "./genres.js";
import { splitTitleYear } from "./works.js";

test("类型：中文、英文、带「片」、TMDB 编号都认；科幻连科幻奇幻、战争连战争政治一起算；口头叫法（动漫、综艺）；认不出给空", () => {
  assert.deepEqual(genreIdsOf("科幻片"), [878, 10765]);
  assert.deepEqual(genreIdsOf("Sci-Fi"), [878, 10765]);
  assert.deepEqual(genreIdsOf("动作"), [28, 10759]);
  assert.deepEqual(genreIdsOf("喜剧"), [35]);
  assert.deepEqual(genreIdsOf("纪录片"), [99]);
  assert.deepEqual(genreIdsOf("878"), [878]);
  assert.deepEqual(genreIdsOf("动漫"), [16]);
  assert.deepEqual(genreIdsOf("综艺"), [10764, 10767]);
  assert.deepEqual(genreIdsOf("不存在"), []);
  assert.deepEqual(genreIdsOf("  "), []);
  assert.deepEqual(genreNames([878, 18, 99999]), ["科幻", "剧情"]);
});

test("国家 / 地区：中文名、「韩剧」「港剧」「国产」这种叫法、两位代码；「中国」「华语」是两岸三地；「印度」不连印度尼西亚；认不出给空", () => {
  assert.deepEqual(countryCodesOf("韩国"), ["KR"]);
  assert.deepEqual(countryCodesOf("韩剧"), ["KR"]);
  assert.deepEqual(countryCodesOf("美剧"), ["US"]);
  assert.deepEqual(countryCodesOf("港剧"), ["HK"]);
  assert.deepEqual(countryCodesOf("国产剧"), ["CN"]);
  assert.deepEqual(countryCodesOf("中国"), ["CN", "HK", "TW"]);
  assert.deepEqual(countryCodesOf("日本"), ["JP"]);
  assert.deepEqual(countryCodesOf("印度"), ["IN"]);
  assert.deepEqual(countryCodesOf("kr"), ["KR"]);
  assert.deepEqual(countryCodesOf("火星"), []);
  assert.deepEqual(countryNames(["KR", "HK", "XX"]), ["韩国", "中国香港", "XX"]);
});

test("片单里的「片名 年份」：年份在最后、隔着空格或括号、不晚于明后年才拆", () => {
  assert.deepEqual(splitTitleYear("阿甘正传 1994"), { name: "阿甘正传", year: "1994" });
  assert.deepEqual(splitTitleYear("阿甘正传（1994）"), { name: "阿甘正传", year: "1994" });
  assert.deepEqual(splitTitleYear("2012 2009"), { name: "2012", year: "2009" });
  assert.deepEqual(splitTitleYear("2012"), { name: "2012" });
  assert.deepEqual(splitTitleYear("银翼杀手2049"), { name: "银翼杀手2049" });
  assert.deepEqual(splitTitleYear("Blade Runner 2049"), { name: "Blade Runner 2049" });
});

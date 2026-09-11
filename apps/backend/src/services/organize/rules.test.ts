/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/rules.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRules, evalOffsetExpr, parseRuleLine, parseRules } from "./rules.js";

test("屏蔽词：从名字里删掉，大小写不敏感", () => {
  const { rules } = parseRules(["高清剧集", "# 注释", ""]);
  assert.equal(rules.length, 1);
  const r = applyRules("【高清剧集】漫长的季节.2023", rules);
  assert.equal(r.name, "【 】漫长的季节.2023");
  assert.deepEqual(r.hits, ["高清剧集"]);
});

test("替换：字面量和正则", () => {
  const { rules, errors } = parseRules(["Frieren => 葬送的芙莉莲", "/S(\\d+)E(\\d+)/i => S0$1E$2"]);
  assert.deepEqual(errors, []);
  assert.equal(applyRules("Frieren S1E01", rules).name, "葬送的芙莉莲 S01E01");
});

test("集数偏移：定位词之间的数字按表达式换算，宽度保留", () => {
  const { rules } = parseRules(["葬送的芙莉莲 - <> [ >> EP-12"]);
  assert.equal(applyRules("葬送的芙莉莲 - 13 [1080p]", rules).name, "葬送的芙莉莲 - 01 [1080p]");
  const { rules: r2 } = parseRules(["第 <> 话 >> 2*EP-1"]);
  assert.equal(applyRules("Show 第03话", r2).name, "Show 第05话");
  const { rules: r3 } = parseRules(["E <> . >> EP+100"]);
  assert.equal(applyRules("Show.E05.1080p", r3).name, "Show.E105.1080p");
});

test("替换 && 偏移 一起", () => {
  const { rules, errors } = parseRules(["Kimetsu no Yaiba Yuukaku-hen => 鬼灭之刃 && - <> [ >> EP+26"]);
  assert.deepEqual(errors, []);
  assert.equal(applyRules("[Sub] Kimetsu no Yaiba Yuukaku-hen - 01 [1080p]", rules).name, "[Sub] 鬼灭之刃 - 27 [1080p]");
});

test("直指 tmdbid：命中后从名字里去掉并带出 tmdb 信息", () => {
  const { rules } = parseRules(["某某剧 第二部 => {[tmdbid=95396;type=tv;s=2]}"]);
  const r = applyRules("某某剧 第二部 01", rules);
  assert.equal(r.name, "01");
  assert.deepEqual(r.direct, { tmdbId: 95396, mediaType: "tv", season: 2 });
});

test("表达式求值不用 eval，只认四则和括号", () => {
  assert.equal(evalOffsetExpr("EP+1", 5), 6);
  assert.equal(evalOffsetExpr("2*EP-1", 5), 9);
  assert.equal(evalOffsetExpr("(EP+1)/2", 5), 3);
  assert.throws(() => parseRuleLine("a <> b >> process.exit()"));
  assert.throws(() => parseRuleLine("a <> b >> 1"), /EP/);
});

test("语法错误按行报出来，不影响其它行", () => {
  const { rules, errors } = parseRules(["ok => fine", " => empty", "/[/ => bad"]);
  assert.equal(rules.length, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /第 2 行/);
  assert.match(errors[1], /第 3 行/);
});

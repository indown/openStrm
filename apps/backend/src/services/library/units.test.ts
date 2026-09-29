import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrganizeMatch } from "@openstrm/shared";
import { adjustConfidence } from "./identify.js";
import { libraryTitleCandidates, unobfuscate } from "./units.js";

test("影库补的候选：没中文时年份后面的中文片名 / 上一级合集的片名打头；多词中文补首尾词；第一部去掉 1", () => {
  // 「007-17」被当成集数范围，只剩文件名里拼错的英文
  assert.deepEqual(libraryTitleCandidates("007-17 (1995) 黄金眼 蓝光原盘REMUX 内封字幕", ["GoIdenEye"]), ["黄金眼", "GoIdenEye", "GoldenEye"]);
  // 合集里的「第2部」：上一级的片名和它的最后一个词
  // 上一级的品牌前缀「漫威」拿掉
  assert.deepEqual(libraryTitleCandidates("第2部 4K原盘REMUX 国英双音 内封字幕", ["Ait-Men And The Wesp"], "漫威 蚁人 全3部 4K原盘REMUX 国英双音 特效字幕"), ["蚁人", "Ait-Men And The Wesp"]);
  assert.deepEqual(libraryTitleCandidates("漫威 黑豹1 4K原盘REMUX", ["漫威 黑豹1"]), ["漫威 黑豹1", "漫威 黑豹", "黑豹1", "黑豹"]);
  // 后面是演员 / 前面是演员：首尾两个词都给
  assert.deepEqual(libraryTitleCandidates("僵尸世界大战 布拉德皮特 4K原盘REMUX", ["僵尸世界大战 布拉德皮特", "World War Z"]), ["僵尸世界大战 布拉德皮特", "僵尸世界大战", "布拉德皮特", "World War Z"]);
  assert.deepEqual(libraryTitleCandidates("李小龙  猛龙过江 1972 4K原盘REMUX", ["李小龙 猛龙过江"]), ["李小龙 猛龙过江", "李小龙", "猛龙过江"]);
  // 第一部的 1
  assert.deepEqual(libraryTitleCandidates("侏罗纪公园1 4K原盘REMUX", ["侏罗纪公园1", "Jurassic Park"]), ["侏罗纪公园1", "侏罗纪公园", "Jurassic Park"]);
  assert.deepEqual(libraryTitleCandidates("怒火攻心Ⅰ 4K原盘REMUX", ["怒火攻心Ⅰ", "怒火攻心1"]), ["怒火攻心Ⅰ", "怒火攻心", "怒火攻心1"]);
  // 拆出来的中文名带罗马数字：阿拉伯数字的紧跟在后面（TMDB 上叫「惊奇队长2」）
  assert.deepEqual(libraryTitleCandidates("漫威 惊奇队长Ⅱ 4K原盘REMUX", ["漫威 惊奇队长Ⅱ", "漫威 惊奇队长2", "The Mervals"]), ["漫威 惊奇队长Ⅱ", "惊奇队长Ⅱ", "惊奇队长2", "漫威 惊奇队长2", "The Mervals"]);
  // 已经有中文：不去年份后面找（「七宗罪 1995 布拉德皮特」后面是演员）；不是「第N部」的不看上一级
  assert.deepEqual(libraryTitleCandidates("七宗罪 1995 布拉德皮特 豆瓣8.8", ["七宗罪", "Se7en"]), ["七宗罪", "Se7en"]);
  assert.deepEqual(libraryTitleCandidates("Forrest.Gump.1994.2160p", ["Forrest Gump"], "1. 电影"), ["Forrest Gump"]);
  assert.deepEqual(libraryTitleCandidates("x", []), []);
});

const match = (over: Partial<OrganizeMatch>): OrganizeMatch => ({
  mediaType: "movie",
  tmdbId: 1,
  title: "侏罗纪公园",
  originalTitle: "Jurassic Park",
  year: "1993",
  posterUrl: "",
  confidence: "low",
  reason: "搜索结果里明显领先",
  candidates: [],
  ...over,
});

test("影库的把握：标题互相包含、年份对上的从「低」提到「中」；年份对不上、标题不沾边的不动", () => {
  assert.equal(adjustConfidence(match({}), ["侏罗纪公园1"], "1993").confidence, "medium");
  assert.equal(adjustConfidence(match({ title: "九龙城寨之围城", year: "2024" }), ["九龙城寨"], "2024").reason, "标题相近、年份对上");
  assert.equal(adjustConfidence(match({}), ["侏罗纪公园1"], "1997").confidence, "low", "年份对不上");
  assert.equal(adjustConfidence(match({}), ["侏罗纪公园1"], "").confidence, "low", "没有年份");
  assert.equal(adjustConfidence(match({ title: "TWICE 日本出道五周年纪念作品" }), ["T C I T W"], "1993").confidence, "low", "标题不沾边");
  assert.equal(adjustConfidence(match({ confidence: "high" }), ["x"], "1993").confidence, "high", "本来就高的不动");
  assert.equal(adjustConfidence(match({ title: "漫威崛起：秘密勇士", year: "2018" }), ["漫威"], "2018").confidence, "low", "两个字的包含不算");
});

test("故意写错的英文名还原：混进去的希腊 / 西里尔字母、夹在小写中间的大写 I", () => {
  assert.equal(unobfuscate("The αccouηtαηt 2"), "The accountant 2");
  assert.equal(unobfuscate("WorId Wαr Z"), "World War Z");
  assert.equal(unobfuscate("Extrαction"), "Extraction");
  assert.equal(unobfuscate("GoIdenEye"), "GoldenEye");
  assert.equal(unobfuscate("SiIenced"), "Silenced");
  assert.equal(unobfuscate("ShopIifters"), "Shoplifters");
  // 纯希腊文、正常的英文不动
  assert.equal(unobfuscate("Ο Θίασος"), "Ο Θίασος");
  assert.equal(unobfuscate("It Follows"), "It Follows");
  assert.equal(unobfuscate("Inception"), "Inception");
  // 进候选：还原的紧跟在原名后面
  assert.deepEqual(libraryTitleCandidates("溶炉 2011 韩国", ["溶炉", "SiIenced"]), ["溶炉", "SiIenced", "Silenced"]);
});


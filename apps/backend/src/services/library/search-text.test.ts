import assert from "node:assert/strict";
import { test } from "node:test";
import { dirSearchText, filePartOf, isVideoName, normalizeForSearch, queryTerms } from "./search-text.js";
import { keywordOf } from "./search.js";

test("归一化：大小写、全角、罗马数字、空白标点都不计较", () => {
  assert.equal(normalizeForSearch("Forrest.Gump.1994.2160p"), "forrestgump19942160p");
  assert.equal(normalizeForSearch("Forrest Gump"), "forrestgump");
  assert.equal(normalizeForSearch("ＦＯＲＲＥＳＴ　Ｇｕｍｐ"), "forrestgump");
  assert.equal(normalizeForSearch("冰雪奇缘Ⅱ"), "冰雪奇缘2");
  assert.equal(normalizeForSearch("三个火枪手：达达尼昂"), "3个火枪手达达尼昂", "汉字数字也转（查询同样转，照样对得上）");
  assert.equal(normalizeForSearch("【4K】沙丘 (2024)"), "4k沙丘2024");
  // LIKE 的通配符和段分隔符都去掉了，词里不会有
  assert.equal(normalizeForSearch("100%_纯|度#"), "100纯度");
});

test("汉字数字转阿拉伯数字：带十百千的按数值读，不带的逐位读；只有百、千的不动", () => {
  assert.equal(normalizeForSearch("三十五岁在东京"), "35岁在东京");
  assert.equal(normalizeForSearch("35岁在东京"), "35岁在东京");
  assert.equal(normalizeForSearch("一九四二"), "1942");
  assert.equal(normalizeForSearch("二〇二三"), "2023");
  assert.equal(normalizeForSearch("神探夏洛克 第二季"), "神探夏洛克第2季");
  assert.equal(normalizeForSearch("十月围城"), "10月围城");
  assert.equal(normalizeForSearch("一百零八"), "108");
  assert.equal(normalizeForSearch("一百一十"), "110");
  assert.equal(normalizeForSearch("两千"), "2000");
  assert.equal(normalizeForSearch("二十二"), "22");
  assert.equal(normalizeForSearch("千与千寻"), "千与千寻");
  assert.equal(normalizeForSearch("百鸟朝凤"), "百鸟朝凤");
  // 查询和目录同一个规则：写法不同也对得上
  assert.deepEqual(queryTerms("35岁"), ["35岁"]);
  assert.ok(dirSearchText(["【日剧】三十五岁在东京（2026）"]).includes(queryTerms("35岁")[0]));
  assert.ok(dirSearchText(["一代宗师"]).includes(queryTerms("一代宗师")[0]));
});

test("目录的 search_text：路径各段 | 连着，直接文件名在 # 后面", () => {
  const t = dirSearchText(["老K", "1. 电影", "阿甘正传 4K原盘REMUX"], ["Forrest.Gump.1994.mkv", "阿甘正传.jpg"]);
  assert.equal(t, "老k|1电影|阿甘正传4k原盘remux#forrestgump1994mkv|阿甘正传jpg");
  assert.equal(filePartOf(t), "forrestgump1994mkv|阿甘正传jpg");
  assert.equal(dirSearchText(["老K"]), "老k");
  assert.equal(filePartOf("老k"), "");
});

test("查询拆词：空白和括号分开、逐个归一化、去重，最多 8 个", () => {
  assert.deepEqual(queryTerms("  阿甘正传   1994 "), ["阿甘正传", "1994"]);
  assert.deepEqual(queryTerms("Forrest.Gump"), ["forrestgump"]);
  assert.deepEqual(queryTerms("末日地堡(2023)"), ["末日地堡", "2023"]);
  assert.deepEqual(queryTerms("【完结】繁花《2023》"), ["完结", "繁花", "2023"]);
  assert.deepEqual(queryTerms("a A a"), ["a"]);
  assert.deepEqual(queryTerms("... ，，"), []);
  assert.equal(queryTerms("1 2 3 4 5 6 7 8 9 10").length, 8);
});

test("视频文件按扩展名认", () => {
  assert.ok(isVideoName("Forrest.Gump.1994.2160p.mkv"));
  assert.ok(isVideoName("a.ISO"));
  assert.ok(!isVideoName("poster.jpg"));
  assert.ok(!isVideoName("mkv"));
});

test("找替代的关键词：到第一个发布信息 / 年份 / 季集为止，年份不带（同 keywordFromName）", () => {
  assert.equal(keywordOf("阿甘正传 4K原盘REMUX 杜比视界 国英双音 内封字幕"), "阿甘正传");
  assert.equal(keywordOf("七宗罪 1995 布拉德皮特 豆瓣8.8 4K原盘REMUX"), "七宗罪");
  assert.equal(keywordOf("比得兔2 逃跑计划 4K原盘REMUX 国英双音"), "比得兔2 逃跑计划");
  assert.equal(keywordOf("一次别离 奥斯卡提名 豆瓣8.8 蓝光原盘REMUX 26.38GB"), "一次别离");
  assert.equal(keywordOf("越狱"), "越狱");
  assert.equal(keywordOf("4K原盘REMUX"), "");
  // 年份粘在片名上、括号标签、书名号
  assert.equal(keywordOf("末日地堡(2023)"), "末日地堡");
  assert.equal(keywordOf("沙丘2（2024）{tmdb-693134}"), "沙丘2");
  assert.equal(keywordOf("【完结】繁花 (2023) [4K]"), "繁花");
  assert.equal(keywordOf("《末日地堡》第一季"), "末日地堡");
  assert.equal(keywordOf("阿凡达 (Avatar) 2009"), "阿凡达");
  assert.equal(keywordOf("【末日地堡】"), "末日地堡", "标签去完是空的，退一步只去括号");
  assert.equal(keywordOf("2046 (2004)"), "2046", "片名本身像年份");
  // 季集、点分隔的英文名
  assert.equal(keywordOf("神探夏洛克 第1季 4K原盘REMUX"), "神探夏洛克");
  assert.equal(keywordOf("越狱 全5季 760G"), "越狱");
  assert.equal(keywordOf("大白鲨 4部 4K原盘REMUX"), "大白鲨");
  assert.equal(keywordOf("Silo.S01.2160p.ATVP.WEB-DL"), "Silo");
  assert.equal(keywordOf("Prison.Break.S01.1080p"), "Prison Break");
  assert.equal(keywordOf("Forrest.Gump.1994.2160p.BluRay.REMUX"), "Forrest Gump");
  assert.equal(keywordOf("Three.Billboards.Outside.Ebbing.Missouri.2017.1080p"), "Three Billboards Outside Ebbing Missouri");
});

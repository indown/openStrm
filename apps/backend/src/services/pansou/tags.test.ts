/**
 * 资源标题 → 标签。样本是对 PanSou 实际搜「沙丘2」「繁花」拿到的标题（资源发布者写的宣传语，写法五花八门）。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/pansou/tags.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchKey, matchTextOf, titleTags } from "./tags.js";

const cases: Array<[string, string[]]> = [
  // 电影
  ["沙丘2（2024）4K原盘 全景声+次世代国语 Atmos.7.1+DTS-HDMA 7.1 简繁+双语特效字幕 全花絮中字 BDJ菜单修改 Dolby Vision HDR10 Atmos 7.1", ["4K", "HDR", "杜比视界", "原盘", "全景声", "国语", "中字"]],
  ["沙丘2部合集 含剧集 (2024) 4K [科幻/剧情] 丹尼斯·维伦纽瓦 附电子书", ["4K", "合集"]],
  ["沙丘2 (2024) 4K HDR & Dv 中英外挂字幕", ["4K", "HDR", "杜比视界", "中字"]],
  ["[沙丘2][2024][4K 内封字幕][29.8G]", ["4K", "中字", "30G"]],
  ["🎬 《沙丘2(2024)4KHDR&Dv》", ["4K", "HDR", "杜比视界"]],
  ["🎬 《沙丘2（2024）4K HDR 杜比视界 国英音轨 正式版 内封特效双语字幕》", ["4K", "HDR", "杜比视界", "国语", "中字"]],
  ["沙丘2 2024 4K原盘REMUX 杜比视界 内封字幕 老K", ["4K", "杜比视界", "原盘", "REMUX", "中字"]],
  ["《沙丘2-1080英语中英字幕2024》", ["1080p", "中字"]],
  ["《沙丘2》(2024)[4K][杜比视界版本][国英多音轨][动作/科幻][提莫西·查拉梅/丽贝卡·弗格森/赞达亚]", ["4K", "杜比视界", "国语"]],
  ["沙丘2-Dune.Part.Two.2024.1080p.WEBRip.1600MB.DD5.1.x264-GalaxyRG[TGx][1.6G]", ["1080p", "WEB", "1.6G"]],
  ["沙丘2-Dune Part Two (2024) [1080p] [WEBRip] [x265] [10bit] [YTS.MX][2.48G]", ["1080p", "WEB", "2.5G"]],
  ["2024年美国8.3分科幻动作片《沙丘2》BD国英双语中英双字", ["蓝光", "国语", "中字"]],
  ["沙丘2 Dune: Part Two (2024)", []],
  // 剧集、综艺、短剧
  ["繁花(2023)【30集全】【4K.高码率】【杜比视界】【国沪双语】【胡歌/马伊琍】", ["4K", "杜比视界", "国语", "全 30 集", "完结"]],
  ["📺 电视剧｜繁花 (2023) 2023.2160p.WEB-DL.H265.10bit.DV.DDP5.1.2Audio-OurTV - 119g包含S00，S01", ["4K", "杜比视界", "WEB", "第 1 季", "119G"]],
  ["🎤 综艺｜一路繁花 (2025) 第2季 更新至4集 4K【3.77GB】神秘G", ["4K", "第 2 季", "更新至 4 集", "3.8G"]],
  ["繁花 (2023) 4K 纯净版 普通话+沪语双杜比音轨   胡歌 / 马伊琍 / 唐嫣  【30集完结】", ["4K", "国语", "全 30 集", "完结"]],
  ["繁花 2023✨4K 纯净版✚杜比视界 DDP【臻彩视听 162G】沪/普配音", ["4K", "杜比视界", "国语", "162G"]],
  ["繁花之大时代 - 2024.S01.1080p", ["1080p", "第 1 季"]],
  ["繁花-繁花[全30集][国语配音+中文字幕].Blossoms.Shanghai.S01.2023.1080p.WEB-DL.H265.AAC-ZeroTV[10.7G]", ["1080p", "WEB", "国语", "中字", "第 1 季", "全 30 集", "完结", "11G"]],
  ["繁花-繁花[全30集][沪语+普通话+中文字幕].Blossoms.Shanghai.S01.2023.2160p.WEB-DL.H265.DDP2.0.2Audio-SeeWEB[45.6G]", ["4K", "WEB", "国语", "中字", "第 1 季", "全 30 集", "完结", "46G"]],
  ["繁花-Blossoms.2023.EP01-30.HD1080P.X264.AAC.Mandarin.CHS.BDYS[17.6G]", ["1080p", "国语", "中字", "1-30 集", "18G"]],
  ["2019年国产剧情片《那树繁花》HD国语中字", ["国语", "中字"]],
  ["卸下枷锁见繁花 (30集) | 短剧", ["30 集"]],
  ["🎬 《海上繁花 全41集（2021）》", ["全 41 集", "完结"]],
  ["综艺：《一路繁花2》 2025 附第一季 1080p 国语中字", ["1080p", "国语", "中字", "第 1 季"]],
  ["一路繁花第二季", ["第 2 季"]],
  ["繁花 （2023）4K  33集全", ["4K", "全 33 集", "完结"]],
  ["繁花 电视剧 OST 电视剧原声带 flac", []],
  ["【夸克网盘】[迅雷云盘]【国剧】《繁花》+番外短片（2023年）剧情 / 爱情 豆瓣8.7", []],
];

test("真实标题：分辨率、HDR / 杜比视界、片源、音轨、字幕、季、集、完结、合集、体积", () => {
  for (const [title, tags] of cases) assert.deepEqual(titleTags(title), tags, title);
});

test("认错的几种：HDRip 不是 HDR，DVD 不是杜比视界，BDYS / BDJ 不是蓝光，SeeWEB 不算 WEB，「中国英雄」不是国语", () => {
  assert.deepEqual(titleTags("Movie.2019.HDRip.XviD"), []);
  assert.deepEqual(titleTags("Movie DVDRip"), []);
  assert.deepEqual(titleTags("Show.BDYS BDJ菜单"), []);
  assert.deepEqual(titleTags("Show-SeeWEB"), []);
  assert.deepEqual(titleTags("中国英雄传"), []);
  assert.deepEqual(titleTags("第2集 预告"), [], "单集不是集数");
  assert.deepEqual(titleTags("Movie 24K纯金"), [], "24K 不是 4K");
});

test("季和集：范围、中文数字、S00 跳过、单集不算；片源里原盘 / REMUX 在就不再标蓝光", () => {
  assert.deepEqual(titleTags("Show S01-S03 合集"), ["第 1-3 季", "合集"]);
  assert.deepEqual(titleTags("第一至三季"), ["第 1-3 季"]);
  assert.deepEqual(titleTags("Show.S02E01-E12"), ["第 2 季", "1-12 集"]);
  assert.deepEqual(titleTags("Show 第1-30集 大结局"), ["1-30 集", "完结"]);
  assert.deepEqual(titleTags("Show 更至12 已完结"), ["更新至 12 集", "完结"]);
  assert.deepEqual(titleTags("蓝光原盘 BluRay"), ["原盘"]);
  assert.deepEqual(titleTags("Movie.1080p.BluRay.x264"), ["1080p", "蓝光"]);
  assert.deepEqual(titleTags("抢先版 HDTS"), ["枪版"]);
  assert.deepEqual(titleTags("哈利波特系列 全8部"), ["合集"]);
});

test("体积：带单位才算，只写 M 的要 ≥100；换算后统一写法", () => {
  assert.deepEqual(titleTags("[800MB]"), ["800M"]);
  assert.deepEqual(titleTags("5M"), []);
  assert.deepEqual(titleTags("1.2TB 合集"), ["合集", "1.2T"]);
  assert.deepEqual(titleTags("DDP5.1 Atmos 7.1"), ["全景声"]);
  assert.deepEqual(titleTags("Movie (2024) 4Ｋ 全角"), ["4K"], "全角字母也认");
});

test("还在更新的剧：先认「更新至」，「全 N 集」「共 N 集」只是总数，不标完结；「全」后面跟着字的不算「N 集全」", () => {
  assert.deepEqual(titleTags("繁花 更新至12集/共30集"), ["更新至 12 集"]);
  assert.deepEqual(titleTags("繁花 (2023) 更新至12集（全30集）4K"), ["4K", "更新至 12 集"]);
  assert.deepEqual(titleTags("某剧 共30集 更新中"), ["30 集"]);
  assert.deepEqual(titleTags("繁花 更新至12集 全景声"), ["全景声", "更新至 12 集"]);
  assert.deepEqual(titleTags("某剧 第12集 全网首发"), []);
  assert.deepEqual(titleTags("每周更新2集"), []);
  assert.deepEqual(titleTags("未完结"), []);
  assert.deepEqual(titleTags("更新至EP12"), ["更新至 12 集"]);
});

test("综艺按日期出的期不是集数；UHD 只在没写别的分辨率时当 4K；「多国语言」不是国语；否定说法不算", () => {
  assert.deepEqual(titleTags("奔跑吧 第8季 更新至20240520期"), ["第 8 季"]);
  assert.deepEqual(titleTags("哈哈哈哈哈 第四季 更新至1231期"), ["第 4 季"]);
  assert.deepEqual(titleTags("Oppenheimer.2023.1080p.UHD.BluRay.x264"), ["1080p", "蓝光"]);
  assert.deepEqual(titleTags("Movie.UHD.BluRay"), ["4K", "蓝光"]);
  assert.deepEqual(titleTags("沙丘2 2160p WEB-DL 内封多国语言字幕"), ["4K", "WEB"]);
  assert.deepEqual(titleTags("暂无中字"), []);
  assert.deepEqual(titleTags("无中字"), []);
  assert.deepEqual(titleTags("非原盘"), []);
  assert.deepEqual(titleTags("4K原盘压制"), ["4K"]);
});

test("集数、季的边角：第1080集不是 1080p，「S01-4K」不是第 1-4 季，不带「第」的范围，全N季，系列里的一部不算合集，隔着空格的体积", () => {
  assert.deepEqual(titleTags("海贼王 第1080集"), []);
  assert.deepEqual(titleTags("繁花.S01-4K"), ["4K", "第 1 季"]);
  assert.deepEqual(titleTags("某剧 5-30集"), ["5-30 集"]);
  assert.deepEqual(titleTags("权力的游戏1-8季"), ["第 1-8 季"]);
  assert.deepEqual(titleTags("权力的游戏 全5季"), ["第 1-5 季"]);
  assert.deepEqual(titleTags("速度与激情系列第十部"), []);
  assert.deepEqual(titleTags("1.5  GB"), ["1.5G"]);
});

test("按词匹配的口径：全角转半角、不分大小写、去空白；标题和标签分开，不跨着对", () => {
  assert.equal(matchKey(" ＴＣ "), "tc");
  assert.equal(matchKey("第 1 季"), "第1季");
  const text = matchTextOf({ title: "繁花.S01.2023.1080p", tags: ["1080p", "第 1 季"] });
  assert.ok(text.includes(matchKey("第1季")));
  assert.ok(!matchTextOf({ title: "abc", tags: ["def"] }).includes("cd"), "标题末尾和标签开头拼不成词");
});

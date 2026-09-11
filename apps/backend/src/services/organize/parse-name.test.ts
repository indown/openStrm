/**
 * 文件名解析的样本表：每条是一个真实风格的乱命名 + 期望解析出来的事实。
 * 加规则先在这里加样本；一条样本改坏了另一条，说明规则在打架。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/parse-name.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasReleaseNoise, isExtrasDirName, parseCjkNumber, parseMediaName, seasonDirNumber, stripSubtitleSuffix, titleCandidates, type ParsedName, looksLikeReleaseDir } from "./parse-name.js";

type Expect = Partial<Omit<ParsedName, "tags" | "titles">> & { tags?: Partial<ParsedName["tags"]>; titles?: string[] };

const samples: Array<[string, Expect]> = [
  // 场景组 / PT 风格
  ["Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX", { title: "Dune Part Two", year: "2024", tags: { resolution: "2160p", source: "WEB-DL", audio: "DDP", hdr: "DV", videoCodec: "H.265", group: "FLUX" } }],
  ["BEEF.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-XXX", { title: "BEEF", season: 1, episode: 1, tags: { resolution: "1080p", source: "WEB-DL", videoCodec: "H.264", group: "XXX" } }],
  ["BEEF.S01.1080p.NF.WEB-DL.DDP5.1.H.264-XXX", { title: "BEEF", season: 1, episode: undefined, cutoff: "season" }],
  ["Game.of.Thrones.S01E01.Winter.Is.Coming.1080p.BluRay.x265-RARBG", { title: "Game of Thrones", season: 1, episode: 1, tags: { source: "BluRay", videoCodec: "x265", group: "RARBG" } }],
  ["The.Bear.S03E01E02.1080p.WEB.h264-ETHEL", { title: "The Bear", season: 3, episode: 1, episodeEnd: 2 }],
  ["Show.Name.S02E05-E06.720p.HDTV", { title: "Show Name", season: 2, episode: 5, episodeEnd: 6 }],
  ["Blade.Runner.2049.2017.1080p.BluRay.x264", { title: "Blade Runner 2049", year: "2017" }],
  ["2012.2009.1080p.BluRay.x264-GROUP", { title: "2012", year: "2009", tags: { group: "GROUP" } }],
  ["1917 (2019)", { title: "1917", year: "2019" }],
  ["Avatar (2009)", { title: "Avatar", year: "2009" }],
  ["Avatar (2009)-cd1", { title: "Avatar", year: "2009", part: 1 }],
  ["Avatar 2009", { title: "Avatar", year: "2009" }],
  ["300 (2006) - 1080p", { title: "300", year: "2006", tags: { resolution: "1080p" } }],
  ["Blade.Runner.1982.Final.Cut.2160p.UHD.BluRay.x265", { title: "Blade Runner", year: "1982", edition: "Final Cut", tags: { resolution: "2160p" } }],
  ["The.Lord.of.the.Rings.2001.Extended.1080p", { title: "The Lord of the Rings", year: "2001", edition: "Extended" }],
  ["Ocean's Eleven 2001 1080p", { title: "Ocean's Eleven", year: "2001" }],
  ["The 100 S01E01", { title: "The 100", season: 1, episode: 1 }],
  ["Mr.Robot.S01E01.eps1.0_hellofriend.mov.1080p", { title: "Mr Robot", season: 1, episode: 1 }],
  ["Westworld 1x01 The Original", { title: "Westworld", season: 1, episode: 1 }],
  ["Frieren.Beyond.Journeys.End.S01E13.1080p", { title: "Frieren Beyond Journeys End", season: 1, episode: 13 }],
  ["Show.Name.2019.S01E01.1080p", { title: "Show Name", year: "2019", season: 1, episode: 1 }],
  ["Show.Name.S01E01.2019.1080p", { title: "Show Name", year: "2019", season: 1, episode: 1 }],
  ["The.Daily.Show.2020.01.31.1080p", { title: "The Daily Show", date: "2020-01-31" }],
  ["Conan.2019-11-14.Guest", { title: "Conan", date: "2019-11-14" }],
  ["movie.sample", { isSample: true }],
  ["Movie.2020.1080p-trailer", { title: "Movie", year: "2020", tags: { resolution: "1080p" } }],
  // 字幕组
  ["[Nekomoe kissaten][Sousou no Frieren][01][1080p][JPSC]", { title: "Sousou no Frieren", absolute: 1, tags: { group: "Nekomoe kissaten", resolution: "1080p" } }],
  ["[Nekomoe kissaten][Sousou no Frieren / 葬送的芙莉莲][13][1080p][JPSC]", { title: "葬送的芙莉莲", titles: ["葬送的芙莉莲", "Sousou no Frieren", "Sousou no Frieren / 葬送的芙莉莲"], absolute: 13 }],
  ["[ANi] 葬送的芙莉莲 - 01 [1080P][Baha][WEB-DL][AAC AVC][CHT]", { title: "葬送的芙莉莲", absolute: 1, tags: { group: "ANi", resolution: "1080p" } }],
  ["[SubsPlease] Sousou no Frieren - 28 (1080p) [ABC123]", { title: "Sousou no Frieren", absolute: 28 }],
  ["[Sakurato] Sousou no Frieren [01][AVC-8bit 1080p AAC][CHS]", { title: "Sousou no Frieren", absolute: 1 }],
  ["[LoliHouse] Kusuriya no Hitorigoto - 13 [WebRip 1080p HEVC-10bit AAC ASSx2].mkv".replace(".mkv", ""), { title: "Kusuriya no Hitorigoto", absolute: 13 }],
  ["Sousou no Frieren - 01v2 [1080p]", { title: "Sousou no Frieren", absolute: 1 }],
  ["[Group] Title [01-12][1080p]", { title: "Title", absolute: 1, absoluteEnd: 12 }],
  ["[Group] Title [SP01][1080p]", { title: "Title", isSpecial: true, episode: 1 }],
  ["[Group] Title [NCOP][1080p]", { title: "Title", isExtra: true }],
  ["[Group] Title [OVA][1080p]", { title: "Title", isSpecial: true }],
  // 中文
  ["权力的游戏.Game.of.Thrones.S01E01.1080p.BluRay.x265", { title: "权力的游戏", titles: ["权力的游戏", "Game of Thrones", "权力的游戏 Game of Thrones"], season: 1, episode: 1 }],
  ["怒呛人生S01E01", { title: "怒呛人生", season: 1, episode: 1 }],
  ["怒呛人生 第一季 第01集", { title: "怒呛人生", season: 1, episode: 1 }],
  ["怒呛人生 第一季 第1-2集", { title: "怒呛人生", season: 1, episode: 1, episodeEnd: 2 }],
  ["葬送的芙莉莲 第13话", { title: "葬送的芙莉莲", absolute: 13 }],
  ["葬送的芙莉莲2023", { title: "葬送的芙莉莲", year: "2023" }],
  ["流浪地球2.2023.4K.HDR.国语中字", { title: "流浪地球2", year: "2023", tags: { resolution: "4K", hdr: "HDR" } }],
  ["沙丘2.Dune.Part.Two.2024.2160p.国英双语.中字", { title: "沙丘2", titles: ["沙丘2", "Dune Part Two", "沙丘2 Dune Part Two"], year: "2024" }],
  ["三体 Three-Body (2023) S01E01", { title: "三体", titles: ["三体", "Three-Body", "三体 Three-Body"], year: "2023", season: 1, episode: 1 }],
  ["【高清剧集】漫长的季节.The.Long.Season.2023.S01.E01.1080p", { title: "漫长的季节", year: "2023", season: 1, episode: 1 }],
  ["繁花.Blossoms.Shanghai.2023.S01E01.2160p.WEB-DL.H265.DDP5.1-XXX@CMCT", { title: "繁花", year: "2023", season: 1, episode: 1, tags: { group: "XXX@CMCT" } }],
  ["请回答1988 E01", { title: "请回答1988", absolute: 1 }],
  ["请回答1988.S01E01.1080p", { title: "请回答1988", season: 1, episode: 1 }],
  ["EP01", { title: "", absolute: 1 }],
  ["E01", { title: "", absolute: 1 }],
  ["第01集", { title: "", absolute: 1 }],
  ["01", { title: "", absolute: 1 }],
  ["007", { title: "", absolute: 7 }],
  ["Some Show S01", { title: "Some Show", season: 1 }],
  ["Some Show Season 2", { title: "Some Show", season: 2 }],
  ["Some Show 2nd Season - 05", { title: "Some Show 2nd Season", absolute: 5 }],
  ["Movie Title 导演剪辑版 1080p", { title: "Movie Title", edition: "导演剪辑版" }],
  ["黑客帝国.The.Matrix.1999.Remastered.1080p", { title: "黑客帝国", year: "1999", edition: "Remastered" }],
];

for (const [name, expect] of samples) {
  test(`解析：${name}`, () => {
    const p = parseMediaName(name);
    for (const [k, v] of Object.entries(expect)) {
      if (k === "tags") {
        for (const [tk, tv] of Object.entries(v as Record<string, string>)) {
          assert.equal((p.tags as Record<string, string | undefined>)[tk], tv, `${name} tags.${tk}`);
        }
        continue;
      }
      if (k === "titles") {
        assert.deepEqual(p.titles, v, `${name} titles`);
        continue;
      }
      assert.deepEqual((p as unknown as Record<string, unknown>)[k], v, `${name} ${k}（实际 ${JSON.stringify(p)}）`);
    }
  });
}

test("字幕后缀：语言和标记从末尾剥掉，主名保留", () => {
  assert.deepEqual(stripSubtitleSuffix("Movie.2020.zh-CN.forced"), { stem: "Movie.2020", lang: "zh-CN", forced: true });
  assert.deepEqual(stripSubtitleSuffix("Movie.chs"), { stem: "Movie", lang: "zh-CN" });
  assert.deepEqual(stripSubtitleSuffix("Movie.简体"), { stem: "Movie", lang: "zh-CN" });
  assert.deepEqual(stripSubtitleSuffix("Movie.cht"), { stem: "Movie", lang: "zh-TW" });
  assert.deepEqual(stripSubtitleSuffix("Movie.en.sdh"), { stem: "Movie", lang: "en", sdh: true });
  assert.deepEqual(stripSubtitleSuffix("Movie.2020"), { stem: "Movie.2020" });
  const p = parseMediaName("BEEF.S01E01.1080p.WEB-DL.chs", { subtitle: true });
  assert.equal(p.subtitleLang, "zh-CN");
  assert.equal(p.episode, 1);
});

test("标题候选：中文 / 英文 / 整段，中文优先", () => {
  assert.deepEqual(titleCandidates("权力的游戏 Game of Thrones"), ["权力的游戏", "Game of Thrones", "权力的游戏 Game of Thrones"]);
  assert.deepEqual(titleCandidates("Sousou no Frieren / 葬送的芙莉莲"), ["葬送的芙莉莲", "Sousou no Frieren", "Sousou no Frieren / 葬送的芙莉莲"]);
  assert.deepEqual(titleCandidates("BEEF"), ["BEEF"]);
  assert.deepEqual(titleCandidates("流浪地球2"), ["流浪地球2"]);
});

test("中文数字", () => {
  assert.equal(parseCjkNumber("一"), 1);
  assert.equal(parseCjkNumber("十"), 10);
  assert.equal(parseCjkNumber("十二"), 12);
  assert.equal(parseCjkNumber("二十"), 20);
  assert.equal(parseCjkNumber("二十三"), 23);
  assert.equal(parseCjkNumber("一百零一"), 101);
  assert.equal(parseCjkNumber("07"), 7);
  assert.equal(parseCjkNumber("abc"), null);
});

test("季目录 / 花絮目录", () => {
  assert.equal(seasonDirNumber("Season 1"), 1);
  assert.equal(seasonDirNumber("Season 01"), 1);
  assert.equal(seasonDirNumber("S02"), 2);
  assert.equal(seasonDirNumber("第三季"), 3);
  assert.equal(seasonDirNumber("第10季"), 10);
  assert.equal(seasonDirNumber("Specials"), 0);
  assert.equal(seasonDirNumber("Season 00"), 0);
  assert.equal(seasonDirNumber("SP"), 0);
  assert.equal(seasonDirNumber("怒呛人生"), null);
  assert.equal(seasonDirNumber("Extras"), null);
  assert.equal(isExtrasDirName("Featurettes"), true);
  assert.equal(isExtrasDirName("花絮"), true);
  assert.equal(isExtrasDirName("Season 1"), false);
});

test("有没有发布噪音：规范过的名字没有，原始命名有，集名里的普通词不算", () => {
  assert.equal(hasReleaseNoise("沙丘：第二部 (2024) - 2160p"), false);
  assert.equal(hasReleaseNoise("怒呛人生 - S01E01 - 飞鸟不鸣"), false);
  assert.equal(hasReleaseNoise("Charlotte's Web (2006)"), false);
  assert.equal(hasReleaseNoise("Cam (2018)"), false);
  assert.equal(hasReleaseNoise("Show - S01E01 - Web of Lies"), false);
  assert.equal(hasReleaseNoise("Dune (2024) - WEB-DL x265 [RARBG]"), false, "用户模板里带了来源 / 编码也是规范形状");
  assert.equal(hasReleaseNoise("Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX"), true);
  assert.equal(hasReleaseNoise("[Nekomoe kissaten][Sousou no Frieren][01][1080p][JPSC]"), true);
  assert.equal(hasReleaseNoise("BEEF.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-XXX"), true);
  assert.equal(hasReleaseNoise("Some Movie 2020"), false, "只是没有年份括号，不算噪音");
});

test("looksLikeReleaseDir：发布目录 vs 收件箱式目录", () => {
  for (const n of ["Captain.America.Brave.New.World.2025.2160p.WEB-DL.DD5.1.H264-COLLECTiVE", "Lord.of.the.Flies.S01.2160p.WEB-DL.H.265-HiveWeb", "亿万地堡（2025）", "钢铁之心(2025)4KHDR10", "[Nekomoe kissaten] Frieren S01", "Season 01"]) {
    assert.equal(looksLikeReleaseDir(n), true, n);
  }
  for (const n of ["inbox", "downloads", "电影", "movie", "孤注一掷", "新下载"]) {
    assert.equal(looksLikeReleaseDir(n), false, n);
  }
});

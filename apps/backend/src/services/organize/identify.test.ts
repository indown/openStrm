/**
 * 识别的打分和置信度：TMDB 换成内存桩。
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/identify.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TmdbDetails, TmdbEpisode, TmdbSearchResult } from "../tmdb.js";
import { identifyUnit, normalizeTitle, type TmdbApi } from "./identify.js";
import { buildUnits, type ScopeEntry } from "./units.js";

const videoExts = new Set([".mkv"]);
const unitOf = (paths: string[], scopeName = "root") =>
  buildUnits(paths.map((p, i): ScopeEntry => ({ path: p, isDir: false, id: `n${i}` })), { scopePath: "", scopeName, videoExts, rules: [] })[0];

const hit = (id: number, mediaType: "movie" | "tv", title: string, year: string, originalTitle?: string): TmdbSearchResult => ({ id, mediaType, title, year, originalTitle, posterUrl: "", overview: "" });

class StubTmdb implements TmdbApi {
  readonly calls: string[] = [];
  constructor(
    private readonly results: Record<string, TmdbSearchResult[]>,
    private readonly detailsMap: Record<string, Partial<TmdbDetails>> = {},
  ) {}
  async search(query: string, kind: "movie" | "tv" | "multi", year?: string): Promise<TmdbSearchResult[]> {
    this.calls.push(`search ${kind} ${query}${year ? ` ${year}` : ""}`);
    return this.results[query.toLowerCase()] ?? [];
  }
  async details(kind: "movie" | "tv", id: number): Promise<TmdbDetails | null> {
    this.calls.push(`details ${kind} ${id}`);
    const d = this.detailsMap[`${kind}:${id}`];
    if (!d) return null;
    return { id, mediaType: kind, title: "", originalTitle: "", enTitle: "", year: "", posterUrl: "", imdbId: "", genreIds: [], countries: [], originalLanguage: "", aliases: [], ...d };
  }
  async season(): Promise<TmdbEpisode[]> {
    this.calls.push("season");
    return [{ episode: 1, name: "飞鸟不鸣" }];
  }
}

test("标题归一化：大小写、标点、全角、开头的 the", () => {
  assert.equal(normalizeTitle("The Lord of the Rings"), "lordoftherings");
  assert.equal(normalizeTitle("沙丘：第二部"), normalizeTitle("沙丘:第二部"));
  assert.equal(normalizeTitle("Dune: Part Two"), "duneparttwo");
});

test("标题和年份都对上是 high；标题对上年份缺是 medium；只是最像是 low", async () => {
  const tmdb = new StubTmdb(
    { beef: [hit(153312, "tv", "BEEF", "2023"), hit(1, "tv", "Beef Wars", "2010")] },
    { "tv:153312": { title: "怒呛人生", originalTitle: "BEEF", year: "2023", seasons: [{ season: 1, episodeCount: 10 }] } },
  );
  const high = await identifyUnit({ unit: unitOf(["BEEF.2023.S01E01.mkv"]), evidence: {}, episodeTitles: false }, tmdb);
  assert.equal(high.match?.confidence, "high");
  assert.equal(high.match?.title, "怒呛人生");
  assert.equal(high.match?.candidates?.length, 2);
  const medium = await identifyUnit({ unit: unitOf(["BEEF.S01E01.mkv"]), evidence: {}, episodeTitles: false }, tmdb);
  assert.equal(medium.match?.confidence, "medium");
  const low = await identifyUnit({ unit: unitOf(["Beef Wars 2 S01E01.mkv"]), evidence: {}, episodeTitles: false }, new StubTmdb({ "beef wars 2": [hit(1, "tv", "Beef Wars", "2010")] }, { "tv:1": { title: "Beef Wars" } }));
  assert.equal(low.match?.confidence, "low");
});

test("搜索结果的标题是译名时按原名对：Dune Part Two 不会被同名花絮抢走", async () => {
  const tmdb = new StubTmdb(
    { "dune part two": [hit(1765119, "movie", "Dune: Part Two - An Ensemble for the Ages", "2024", "Dune: Part Two - An Ensemble for the Ages"), hit(693134, "movie", "沙丘：第二部", "2024", "Dune: Part Two")] },
    { "movie:693134": { title: "沙丘：第二部", originalTitle: "Dune: Part Two", year: "2024" }, "movie:1765119": { title: "Dune: Part Two - An Ensemble for the Ages", year: "2024" } },
  );
  const r = await identifyUnit({ unit: unitOf(["Dune.Part.Two.2024.2160p.WEB-DL.mkv"]), evidence: {}, episodeTitles: false }, tmdb);
  assert.equal(r.match?.tmdbId, 693134);
  assert.equal(r.match?.confidence, "high");
  assert.equal(r.match?.title, "沙丘：第二部");
});

test("标题和原名都对不上时看前几名的别名：第二名别名命中就选第二名", async () => {
  const tmdb = new StubTmdb(
    { beef: [hit(207503, "tv", "Celebrity Beef", "2022", "Celebrity Beef"), hit(153312, "tv", "怒呛人生", "2023", "怒呛人生")] },
    { "tv:207503": { title: "Celebrity Beef", year: "2022", aliases: [] }, "tv:153312": { title: "怒呛人生", originalTitle: "怒呛人生", year: "2023", aliases: ["BEEF"], seasons: [{ season: 1, episodeCount: 10 }] } },
  );
  const r = await identifyUnit({ unit: unitOf(["BEEF.S01E01.mkv"]), evidence: {}, episodeTitles: false }, tmdb);
  assert.equal(r.match?.tmdbId, 153312);
  assert.equal(r.match?.confidence, "medium");
  assert.equal(r.match?.reason, "别名对上，文件名里没有年份");
  const withYear = await identifyUnit({ unit: unitOf(["BEEF.2023.S01E01.mkv"]), evidence: {}, episodeTitles: false }, tmdb);
  assert.equal(withYear.match?.tmdbId, 153312);
  assert.equal(withYear.match?.confidence, "high");
});

test("证据优先：识别词直指 > 记忆 > 影库 / nfo，都不搜索", async () => {
  const tmdb = new StubTmdb({}, { "tv:7": { title: "直指" }, "movie:8": { title: "记忆" }, "tv:9": { title: "影库" } });
  const unit = unitOf(["Whatever.S01E01.mkv"]);
  const a = await identifyUnit({ unit: { ...unit, direct: { tmdbId: 7, mediaType: "tv" } }, evidence: {}, episodeTitles: false }, tmdb);
  assert.equal(a.match?.title, "直指");
  assert.equal(a.match?.reason, "识别词直接指定");
  const b = await identifyUnit({ unit, evidence: { memory: { accountName: "a", srcPath: "/x", mediaType: "movie", tmdbId: 8, title: "", year: "", season: null, episodeOffset: 0, updatedAt: 0 } }, episodeTitles: false }, tmdb);
  assert.equal(b.match?.title, "记忆");
  const c = await identifyUnit({ unit, evidence: { known: { tmdbId: 9, mediaType: "tv", source: "影库条目" } }, episodeTitles: false }, tmdb);
  assert.equal(c.match?.title, "影库");
  assert.ok(!tmdb.calls.some((x) => x.startsWith("search")), "有 id 证据就不搜索");
});

test("中英双名依次搜；别名对上也算；开了集标题就拉季", async () => {
  const tmdb = new StubTmdb(
    { 权力的游戏: [], "game of thrones": [hit(1399, "tv", "权力的游戏", "2011")] },
    { "tv:1399": { title: "权力的游戏", originalTitle: "Game of Thrones", year: "2011", aliases: ["冰与火之歌"], seasons: [{ season: 1, episodeCount: 10 }] } },
  );
  const r = await identifyUnit({ unit: unitOf(["权力的游戏.Game.of.Thrones.2011.S01E01.mkv"]), evidence: {}, episodeTitles: true }, tmdb);
  assert.equal(r.match?.tmdbId, 1399);
  assert.equal(r.match?.confidence, "high");
  assert.equal(r.episodeTitles.get("1:1"), "飞鸟不鸣");
  assert.ok(tmdb.calls.includes("search tv 权力的游戏 2011"));
  assert.ok(tmdb.calls.includes("search tv Game of Thrones 2011"));
});

test("搜不到：none", async () => {
  const r = await identifyUnit({ unit: unitOf(["Nothing.Here.S01E01.mkv"]), evidence: {}, episodeTitles: false }, new StubTmdb({}));
  assert.equal(r.match, null);
});

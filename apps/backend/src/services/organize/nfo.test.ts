/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/nfo.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DATA_DIR } from "../../paths.js";
import { nfoEvidence, readNfoFacts } from "./nfo.js";
import { buildUnits, type ScopeEntry } from "./units.js";

// 本机镜像里 黑镜 (2011) 的三种 nfo（删掉了和 id 无关的长字段）：剧 id 同时在 tmdbid 和 uniqueid；
// 分集 nfo 的 uniqueid 是这一集自己的，演员块里也带 tmdbid，title 是集名
const TVSHOW = `<?xml version="1.0" encoding="utf-8"?>
<tvshow>
  <tmdbid>42009</tmdbid>
  <uniqueid type="tmdb" default="false">42009</uniqueid>
  <tvdbid>253463</tvdbid>
  <uniqueid type="tvdb">253463</uniqueid>
  <plot><![CDATA[《黑镜》（英语：Black Mirror）是一部英国独立单元剧。]]></plot>
  <genre>Sci-Fi &amp; Fantasy</genre>
  <title>黑镜</title>
  <originaltitle>Black Mirror</originaltitle>
  <year>2011</year>
</tvshow>`;
const SEASON = `<?xml version="1.0" encoding="utf-8"?>
<season>
  <title>季 7</title>
  <seasonnumber>7</seasonnumber>
</season>`;
const EPISODE = `<?xml version="1.0" encoding="utf-8"?>
<episodedetails>
  <uniqueid type="tmdb" default="true">6085098</uniqueid>
  <tmdbid>42009</tmdbid>
  <title>普通人</title>
  <season>7</season>
  <episode>1</episode>
  <director tmdbid="2426910">Ally Pankiw</director>
  <actor>
    <name>克里斯·奥多德</name>
    <type>Actor</type>
    <tmdbid>40477</tmdbid>
  </actor>
</episodedetails>`;

test("readNfoFacts：本机真实的三种 nfo", () => {
  assert.deepEqual(readNfoFacts(TVSHOW), { root: "tvshow", tmdbId: 42009, titles: ["黑镜", "Black Mirror"] });
  assert.deepEqual(readNfoFacts(SEASON), { root: "season", titles: [] }, "季 nfo 没有作品 id");
  assert.deepEqual(readNfoFacts(EPISODE), { root: "episodedetails", tmdbId: 42009, titles: [] }, "分集 nfo 只认 <tmdbid>；uniqueid 是这一集的，title 是集名");
});

test("readNfoFacts：演员 / 合集块里的 tmdbid 不算；分集 nfo 只有自己的 uniqueid 就没有作品 id；实体和 CDATA 照常解", () => {
  const kodiShow = `<tvshow><title>黑镜</title><uniqueid type="tmdb" default="true">42009</uniqueid><actor><name>某演员</name><tmdbid>40477</tmdbid></actor></tvshow>`;
  assert.equal(readNfoFacts(kodiShow)?.tmdbId, 42009, "原来会取到演员的 40477");
  const noShowId = `<tvshow><title>某剧</title><actor><name>某演员</name><tmdbid>40477</tmdbid></actor></tvshow>`;
  assert.equal(readNfoFacts(noShowId)?.tmdbId, undefined);
  const epOnly = `<episodedetails><title>第 1 集</title><showtitle>黑镜</showtitle><uniqueid type="tmdb">6085098</uniqueid></episodedetails>`;
  assert.deepEqual(readNfoFacts(epOnly), { root: "episodedetails", tmdbId: undefined, titles: ["黑镜"] });
  const movie = `<movie><title>Ocean&apos;s Eleven</title><originaltitle><![CDATA[Ocean's Eleven]]></originaltitle><set><name>十一罗汉系列</name><tmdbid>304</tmdbid></set><tmdbid>161</tmdbid></movie>`;
  assert.deepEqual(readNfoFacts(movie), { root: "movie", tmdbId: 161, titles: ["Ocean's Eleven", "Ocean's Eleven"] });
});

test("readNfoFacts：发布组的纯文本说明不是 XML", () => {
  assert.equal(readNfoFacts("RELEASE INFO\n------------\nVideo: HEVC 2160p <3\nhttps://www.imdb.com/title/tt2085059/"), null);
});

test("nfoEvidence：tvshow.nfo 先读、season.nfo 不读、分集 nfo 标 strict；本地没下载就没有证据", async () => {
  const saveDir = fs.mkdtempSync(path.join(DATA_DIR, "nfo-"));
  const write = (rel: string, text: string) => {
    const full = path.join(saveDir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  };
  const paths = ["黑镜 (2011)/tvshow.nfo", "黑镜 (2011)/Season 7/season.nfo", "黑镜 (2011)/Season 7/黑镜 - S07E01 - 第 1 集.nfo", "黑镜 (2011)/Season 7/黑镜 - S07E01 - 第 1 集.mkv"];
  const unit = buildUnits(paths.map((p, i): ScopeEntry => ({ path: p, isDir: false, id: `n${i}` })), { scopePath: "", taskRootName: "tv", videoExts: new Set([".mkv"]), rules: [] })[0];
  try {
    assert.equal(await nfoEvidence(saveDir, unit), null);
    write("黑镜 (2011)/Season 7/season.nfo", SEASON);
    write("黑镜 (2011)/Season 7/黑镜 - S07E01 - 第 1 集.nfo", EPISODE);
    assert.deepEqual(await nfoEvidence(saveDir, unit), { tmdbId: 42009, mediaType: "tv", source: "本地 黑镜 - S07E01 - 第 1 集.nfo 里的 tmdbid", titles: [], strict: true });
    write("黑镜 (2011)/tvshow.nfo", TVSHOW);
    assert.deepEqual(await nfoEvidence(saveDir, unit), { tmdbId: 42009, mediaType: "tv", source: "本地 tvshow.nfo 里的 tmdbid", titles: ["黑镜", "Black Mirror"], strict: false });
  } finally {
    fs.rmSync(saveDir, { recursive: true, force: true });
  }
});

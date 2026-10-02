/**
 * 影库第二阶段：抄完的目录树切作品单元 → 识别（假 TMDB）→ 认出来的名字进搜索、结果挂作品 → 海报墙聚合 / 作品弹框 →
 * 换匹配 / 不是影视 / 重新认 → 重切保留识别结果 → 升级补切。115 的内存假网盘。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/library/library-works.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, AppSettings, LibrarySearchResult, LibraryWorkDetail, LibraryWorksResult, MediaLibraryEntry } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import libraryRoute from "./index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { getAll, remove } from "../../db/repositories/media-library.js";
import { deleteUnits, getUnit, unitsOfSource } from "../../db/repositories/library-units.js";
import { updateShare } from "../../db/repositories/library-shares.js";
import { deleteAppSetting, patchAppSettings, readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { deleteKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";
import { setDriveProviderFactory } from "../../services/drive/registry.js";
import { setLibraryHealthDeps, startLibraryHealth, stopLibraryHealth } from "../../services/library/health.js";
import { __test_whenIdle as indexerIdle, setIndexerDeps, startIndexer, stopIndexer } from "../../services/library/indexer.js";
import { __test_whenIdle as identifyIdle, akaOf, kickIdentify, setIdentifyDeps, startLibraryIdentify, stopLibraryIdentify } from "../../services/library/identify.js";
import { rebuildUnits, rebuildUnitsIfStale } from "../../services/library/units.js";
import { recordLibrarySave } from "../../services/library/saves.js";
import { listWorks, lookupWorks } from "../../services/library/works.js";
import { sqlite } from "../../db/client.js";
import type { TmdbApi } from "../../services/organize/identify.js";
import type { TmdbDetails, TmdbSearchResult } from "../../services/tmdb.js";
import { FakeDrive, type FakeTree } from "../../test/fake-drive.js";
import { agentLibraryItem } from "../../services/agent/tools/library.js";

const acc: AccountInfo = { accountType: "115", name: "a", cookie: "c" };
const drive = new FakeDrive("115", acc, { share: true });
const share = drive.share!;
const LINK = "https://115.com/s/pack?password=ab12";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { accounts: AccountInfo[]; settings: AppSettings };
let now = 1_800_000_000;
let tree: FakeTree;

function definePack() {
  const t = share.define("pack", { title: "老K", password: "ab12" });
  t.addFile("/老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界/Forrest.Gump.1994.2160p.BluRay.REMUX.mkv", { size: 50 });
  t.addFile("/老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界/阿甘正传.jpg", { size: 1 });
  t.addFile("/老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界/sample.mkv", { size: 2 });
  t.addFile("/老K/1. 电影/一次别离 奥斯卡提名 豆瓣8.8 蓝光原盘REMUX/A.Separation.2011.1080p.BluRay.REMUX.mkv", { size: 28 });
  t.addFile("/老K/1. 电影/大白鲨 4部 4K原盘REMUX/大白鲨1 4K原盘REMUX/Jaws.1975.2160p.mkv", { size: 40 });
  t.addFile("/老K/1. 电影/大白鲨 4部 4K原盘REMUX/大白鲨2 4K原盘REMUX/Jaws.2.1978.2160p.mkv", { size: 30 });
  t.addFile("/老K/1. 电影/不知道是什么 4K原盘REMUX/Unknown.Thing.2020.mkv", { size: 3 });
  t.addFile("/老K/1. 电影/碟中谍 全 4K原盘REMUX/碟中谍 第2部 4K原盘REMUX/Mission.Impossible.II.2000.2160p.mkv", { size: 5 });
  t.addFile("/老K/2. 剧集/神探夏洛克/神探夏洛克 第1季 4K原盘REMUX/Sherlock.S01E01.2160p.mkv", { size: 10 });
  t.addFile("/老K/2. 剧集/神探夏洛克/神探夏洛克 第1季 4K原盘REMUX/Sherlock.S01E02.2160p.mkv", { size: 10 });
  t.addFile("/老K/2. 剧集/神探夏洛克/神探夏洛克 第2季 蓝光原盘REMUX/Sherlock.S02E01.1080p.mkv", { size: 8 });
  return t;
}

/* ------------------------------- 假 TMDB ------------------------------- */

const MOVIE = (id: number, title: string, originalTitle: string, year: string): TmdbSearchResult => ({ id, mediaType: "movie", title, originalTitle, year, posterUrl: `https://img/${id}.jpg`, overview: "" });
const TV = (id: number, title: string, originalTitle: string, year: string): TmdbSearchResult => ({ id, mediaType: "tv", title, originalTitle, year, posterUrl: `https://img/${id}.jpg`, overview: "" });
const catalog: Record<string, TmdbSearchResult[]> = {
  阿甘正传: [MOVIE(13, "阿甘正传", "Forrest Gump", "1994")],
  "forrest gump": [MOVIE(13, "阿甘正传", "Forrest Gump", "1994")],
  一次别离: [MOVIE(60243, "一次别离", "Jodaeiye Nader az Simin", "2011")],
  大白鲨1: [MOVIE(578, "大白鲨", "Jaws", "1975")],
  jaws: [MOVIE(578, "大白鲨", "Jaws", "1975")],
  大白鲨2: [MOVIE(579, "大白鲨2", "Jaws 2", "1978")],
  碟中谍2: [MOVIE(955, "碟中谍2", "Mission: Impossible II", "2000")],
  "jaws 2": [MOVIE(579, "大白鲨2", "Jaws 2", "1978")],
  神探夏洛克: [TV(19885, "神探夏洛克", "Sherlock", "2010")],
  sherlock: [TV(19885, "神探夏洛克", "Sherlock", "2010")],
  "the matrix": [MOVIE(603, "黑客帝国", "The Matrix", "1999")],
};
const aliases: Record<number, string[]> = { 19885: ["新福尔摩斯", "BBC Sherlock"], 13: ["福雷斯特·冈普"] };
/** 详情里的类型、国家 / 地区（收藏夹按类型、地区筛） */
const facts: Record<number, { genreIds: number[]; countries: string[]; originalLanguage: string }> = {
  13: { genreIds: [35, 18, 10749], countries: ["US"], originalLanguage: "en" },
  60243: { genreIds: [18], countries: ["IR"], originalLanguage: "fa" },
  19885: { genreIds: [80, 18, 9648], countries: ["GB"], originalLanguage: "en" },
};
let tmdbCalls = 0;
let tmdbDown = false;
const fakeTmdb: TmdbApi = {
  async search(query) {
    tmdbCalls++;
    if (tmdbDown) throw Object.assign(new Error("socket hang up"), { isAxiosError: true });
    return catalog[query.trim().toLowerCase()] ?? catalog[query.trim()] ?? [];
  },
  async details(kind, id): Promise<TmdbDetails | null> {
    tmdbCalls++;
    const hit = Object.values(catalog)
      .flat()
      .find((r) => r.id === id && r.mediaType === kind);
    if (!hit) return null;
    return {
      id,
      mediaType: kind,
      title: hit.title,
      originalTitle: hit.originalTitle ?? "",
      enTitle: hit.originalTitle ?? "",
      year: hit.year,
      posterUrl: hit.posterUrl,
      imdbId: "",
      genreIds: facts[id]?.genreIds ?? [],
      countries: facts[id]?.countries ?? [],
      originalLanguage: facts[id]?.originalLanguage ?? "",
      aliases: aliases[id] ?? [],
    };
  },
  async season() {
    return [];
  },
};

/* ------------------------------- 工具 ------------------------------- */

const call = (method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, headers: auth, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });
const sources = async (): Promise<MediaLibraryEntry[]> => (await call("GET", "/api/library")).json();
const search = async (q: string): Promise<LibrarySearchResult> => (await call("GET", `/api/library/search?q=${encodeURIComponent(q)}`)).json();
const works = async (query = ""): Promise<LibraryWorksResult> => {
  const res = await call("GET", `/api/library/works${query}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
};
const detail = async (key: string): Promise<LibraryWorkDetail> => {
  const res = await call("GET", `/api/library/works/detail?key=${encodeURIComponent(key)}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
};

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await indexerIdle();
    await identifyIdle();
  }
}

async function addPack(): Promise<MediaLibraryEntry> {
  const res = await call("POST", "/api/library", { shareUrl: LINK });
  assert.equal(res.statusCode, 201, res.body);
  await settle();
  return res.json().entry;
}

before(async () => {
  baseline = { accounts: listAccounts(), settings: readAppSettings() };
  replaceAccounts([acc]);
  patchAppSettings({ tmdb: { apiKey: "k", language: "zh-CN" } });
  await writeAuthPassword("library-works-itest-pw");
  setDriveProviderFactory((a) => (a.name === "a" ? drive : null));
  setIndexerDeps({ now: () => now, sleep: async () => {}, busy: () => false, retryDelaysMs: [0, 0, 0], gapMs: 0, yieldMaxMs: 0 });
  setLibraryHealthDeps({ now: () => now, notify: async () => {}, verifyDelayMs: 0 });
  setIdentifyDeps({ now: () => now, tmdb: () => (readAppSettings().tmdb?.apiKey ? fakeTmdb : null), pauseS: 0 });
  startLibraryHealth({ patrol: false });
  startIndexer();
  startLibraryIdentify();

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(libraryRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  stopLibraryIdentify();
  stopIndexer();
  stopLibraryHealth();
  setIdentifyDeps(null);
  setIndexerDeps(null);
  setLibraryHealthDeps(null);
  await app.close();
  for (const s of getAll()) remove(s.id);
  setDriveProviderFactory(null);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  await writeAuthPassword(DEFAULT_AUTH.password);
});

beforeEach(async () => {
  await settle();
  for (const s of getAll()) remove(s.id);
  share.shares.clear();
  share.log.length = 0;
  tree = definePack();
  now += 3600;
  tmdbDown = false;
  patchAppSettings({ tmdb: { apiKey: "k", language: "zh-CN" } });
  stopLibraryHealth();
  startLibraryHealth({ patrol: false });
});

/* ------------------------------- 用例 ------------------------------- */

test("抄完切作品单元：电影一部一个、合集拆开、剧的季目录各一个、名字里的发布信息切掉", async () => {
  const entry = await addPack();
  const list = unitsOfSource(entry.id);
  const byTitle = Object.fromEntries(list.map((u) => [u.parsedTitle, u]));
  assert.deepEqual(Object.keys(byTitle).sort(), ["一次别离", "不知道是什么", "大白鲨1", "大白鲨2", "碟中谍2", "神探夏洛克", "阿甘正传"].sort());
  assert.equal(list.length, 8, "夏洛克两季两个单元");
  const gump = byTitle["阿甘正传"];
  assert.equal(gump.kindHint, "movie");
  assert.equal(gump.parsedYear, "1994", "年份从文件名来");
  assert.ok(gump.parsedTitles.includes("Forrest Gump"), "文件名里的英文名也是搜索候选");
  assert.equal(gump.ownsDir, true);
  assert.equal(gump.videoCount, 1);
  assert.equal(gump.fileIds.length, 2, "图片跟着；sample 不算这部作品的文件，转存时不带");
  const mi2 = list.find((u) => u.rawName.startsWith("碟中谍 第2部"))!;
  assert.equal(mi2.kindHint, "movie", "电影合集里的「第2部」不当季");
  assert.deepEqual(mi2.seasons, []);
  assert.equal(mi2.parsedTitles[0], "碟中谍2");
  const sherlock = list.filter((u) => u.parsedTitle === "神探夏洛克");
  assert.deepEqual(sherlock.map((u) => u.kindHint), ["tv", "tv"]);
  assert.deepEqual(sherlock.map((u) => u.seasons).sort(), [[1], [2]]);
});

test("识别：认出来的挂到结果上，正式名 / 原名 / 别名进搜索；没认出的单独一类", async () => {
  const entry = await addPack();
  const list = unitsOfSource(entry.id);
  assert.ok(list.every((u) => u.status === "done"), JSON.stringify(list.map((u) => [u.parsedTitle, u.status])));
  const gump = list.find((u) => u.parsedTitle === "阿甘正传")!;
  assert.equal(gump.tmdbId, 13);
  assert.equal(gump.confidence, "high", "标题年份都对上");
  assert.equal(list.find((u) => u.parsedTitle === "不知道是什么")!.tmdbId, null);

  // 结果挂作品：目录自己是单元；季目录在剧的单元里
  const hit = (await search("阿甘正传")).hits[0];
  assert.equal(hit.work?.tmdbId, 13);
  assert.equal(hit.work?.posterUrl, "https://img/13.jpg");
  // 别名：「新福尔摩斯」只在 TMDB 的别名里，目录名、文件名里都没有
  const alias = await search("新福尔摩斯");
  assert.equal(alias.total, 2, "两季两个单元都搜得到");
  assert.ok(alias.hits.every((h) => h.matched === "name" && h.work?.tmdbId === 19885));
  // 智能体拿到的条目也带作品
  const item = agentLibraryItem(hit);
  assert.deepEqual(item.tmdb, { id: 13, type: "movie", title: "阿甘正传", year: "1994", confidence: "high" });
  // 一个分类目录不因为里面有作品就挂作品
  assert.equal((await search("1. 电影")).hits.find((h) => h.name === "1. 电影")?.work, undefined);
  // 剧目录自己不是单元、里面的两季都认成了同一部：挂上；合集目录里是两部，不挂
  assert.equal((await search("神探夏洛克")).hits.find((h) => h.name === "神探夏洛克")?.work?.tmdbId, 19885);
  assert.equal((await search("大白鲨 4部")).hits.find((h) => h.name.startsWith("大白鲨 4部"))?.work, undefined);

  const w = await works();
  assert.equal(w.tmdbConfigured, true);
  assert.equal(w.counts.pending, 0);
  assert.equal(w.counts.none, 1);
  assert.deepEqual(w.works.map((x) => x.key).sort(), ["movie:13", "movie:578", "movie:579", "movie:60243", "movie:955", "tv:19885"].sort());
  const sher = w.works.find((x) => x.key === "tv:19885")!;
  assert.equal(sher.versions, 2);
  assert.deepEqual(sher.seasons, [1, 2]);
  assert.equal((await works("?view=tv")).works.length, 1);
  assert.equal((await works("?view=movie")).total, 5);
  const none = await works("?view=none");
  assert.equal(none.works[0].title, "不知道是什么");
  assert.ok(none.works[0].key.startsWith("unit:"));
  assert.deepEqual(
    (await works("?sort=title")).works.map((x) => x.title),
    [...w.works.map((x) => x.title)].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })),
  );
  // 来源卡片：整包里好几部，不给海报
  const [s] = await sources();
  assert.equal(s.works?.total, 8);
  assert.equal(s.works?.identified, 7);
  assert.equal(s.works?.poster, "");
});

test("作品弹框：版本列表带打开 / 转存要的东西；换匹配、不是影视、重新认", async () => {
  const entry = await addPack();
  const d = await detail("tv:19885");
  assert.equal(d.units.length, 2);
  const s1 = d.units.find((u) => u.seasons[0] === 1)!;
  assert.equal(s1.parentId, tree.get("/老K/2. 剧集/神探夏洛克")!.id);
  assert.deepEqual(s1.crumbs.map((c) => c.name), ["老K", "2. 剧集", "神探夏洛克", "神探夏洛克 第1季 4K原盘REMUX"]);
  assert.equal(s1.work?.originalTitle, "Sherlock");
  assert.equal(s1.health.status, "ok");

  // 换匹配：大白鲨1 认成了 578（标题差个 1），手动指定成别的
  const jaws = unitsOfSource(entry.id).find((u) => u.parsedTitle === "大白鲨1")!;
  let res = await call("POST", "/api/library/units", { action: "match", sourceId: entry.id, unitKey: jaws.unitKey, mediaType: "movie", tmdbId: 603 });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().unit.work.title, "黑客帝国");
  assert.equal(res.json().unit.status, "manual");
  assert.equal((await search("matrix")).hits[0]?.name, "大白鲨1 4K原盘REMUX", "手动指定的名字也进搜索");
  res = await call("POST", "/api/library/units", { action: "match", sourceId: entry.id, unitKey: jaws.unitKey, mediaType: "tv", tmdbId: 999 });
  assert.equal(res.statusCode, 404);

  // 不是影视：不再出现在海报墙、「没认出」里，名字也不进搜索
  const unknown = unitsOfSource(entry.id).find((u) => u.parsedTitle === "不知道是什么")!;
  res = await call("POST", "/api/library/units", { action: "ignore", sourceId: entry.id, unitKey: unknown.unitKey });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await works("?view=none")).total, 0);
  const ignoredSherlock = unitsOfSource(entry.id).find((u) => u.parsedTitle === "神探夏洛克" && u.seasons[0] === 2)!;
  await call("POST", "/api/library/units", { action: "ignore", sourceId: entry.id, unitKey: ignoredSherlock.unitKey });
  assert.equal((await search("新福尔摩斯")).total, 1, "忽略的那一季别名清掉了");

  // 重新认：放回待认，工人马上认回来（手动指定的也放掉）
  res = await call("POST", "/api/library/units", { action: "reidentify", sourceId: entry.id, unitKey: jaws.unitKey });
  assert.equal(res.statusCode, 200);
  await settle();
  assert.equal(getUnit(entry.id, jaws.unitKey)?.tmdbId, 578);

  // 整个来源重新认：手动的、忽略的不动
  await call("POST", "/api/library/units", { action: "match", sourceId: entry.id, unitKey: jaws.unitKey, mediaType: "movie", tmdbId: 603 });
  res = await call("POST", `/api/library/${entry.id}/reidentify`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().count, 5, "自动认的 5 个（阿甘、一次别离、大白鲨2、碟中谍2、夏洛克第 1 季）");
  await settle();
  assert.equal(getUnit(entry.id, jaws.unitKey)?.status, "manual");
  assert.equal(getUnit(entry.id, unknown.unitKey)?.status, "ignored");
});

test("重切单元：识别结果按单元键保留，名字变了的重认；手动的一直保留；升级上来的补切", async () => {
  const entry = await addPack();
  const gump = unitsOfSource(entry.id).find((u) => u.parsedTitle === "阿甘正传")!;
  const before = tmdbCalls;
  rebuildUnits(entry.id);
  assert.equal(getUnit(entry.id, gump.unitKey)?.tmdbId, 13);
  assert.equal(getUnit(entry.id, gump.unitKey)?.status, "done");
  await settle();
  assert.equal(tmdbCalls, before, "没变的不重认");

  // 升级：rc.1 抄完的来源没有单元，版本号也没有
  deleteUnits(entry.id);
  deleteKv(KEY.libraryUnitsVersion);
  assert.equal(rebuildUnitsIfStale(), 1);
  assert.equal(unitsOfSource(entry.id).length, 8);
  assert.equal(rebuildUnitsIfStale(), 0, "版本对上了不再切");
  kickIdentify();
  await settle();
  assert.equal(getUnit(entry.id, gump.unitKey)?.tmdbId, 13);
  assert.ok((await search("福雷斯特冈普")).total >= 1, "补切之后别名照样进搜索");
});

test("没配 TMDB：单元等着认；配上接着认。TMDB 一时出错：过一阵再认，不卡住后面的", async () => {
  deleteAppSetting("tmdb");
  const entry = await addPack();
  assert.ok(unitsOfSource(entry.id).every((u) => u.status === "pending"));
  let w = await works();
  assert.equal(w.tmdbConfigured, false);
  assert.equal(w.counts.pending, 8);
  assert.equal(w.works.length, 0);

  tmdbDown = true;
  patchAppSettings({ tmdb: { apiKey: "k", language: "zh-CN" } });
  kickIdentify();
  await settle();
  const failed = unitsOfSource(entry.id).filter((u) => u.error);
  assert.ok(failed.length >= 1, "出错的记下原因");
  assert.ok(failed.every((u) => u.status === "pending" && (u.retryAt ?? 0) > now));

  tmdbDown = false;
  now += 3600;
  kickIdentify();
  await settle();
  w = await works();
  assert.equal(w.counts.pending, 0);
  assert.equal(w.works.length, 6);
});

test("已失效分享里的作品不进海报墙，作品弹框里照样列出来、标上", async () => {
  const entry = await addPack();
  updateShare(entry.shareCode, { status: "expired", expiredAt: now });
  const w = await works();
  assert.equal(w.works.length, 0);
  const d = await detail("movie:13");
  assert.equal(d.units[0].health.status, "expired");
});

test("按名字 / 年份筛（原名、英文名也算）；剧的几季分开放在同一个目录下的，作品详情给一组「一起转存」", async () => {
  await addPack();
  assert.deepEqual((await works("?keyword=forrest")).works.map((w) => w.key), ["movie:13"], "英文原名");
  assert.deepEqual((await works("?keyword=%E5%A4%A7%E7%99%BD%E9%B2%A8")).works.map((w) => w.key).sort(), ["movie:578", "movie:579"]);
  assert.deepEqual((await works("?year=1975-1978&sort=year")).works.map((w) => w.key), ["movie:579", "movie:578"]);
  assert.deepEqual((await works("?year=1994")).works.map((w) => w.key), ["movie:13"]);
  const sherlock = await detail("tv:19885");
  assert.equal(sherlock.seriesGroups.length, 1);
  assert.equal(sherlock.seriesGroups[0].folder, "神探夏洛克");
  assert.deepEqual(sherlock.seriesGroups[0].seasons, [1, 2]);
  const bySeason = sherlock.seriesGroups[0].units.map((k) => sherlock.units.find((u) => `${u.sourceId}:${u.unitKey}` === k)!.seasons[0]);
  assert.deepEqual(bySeason, [1, 2], "按季排好");
  assert.deepEqual((await detail("movie:13")).seriesGroups, [], "电影不给");
});

test("从收藏夹存过的记下来：存了剧所在的目录也算里面的每一季；作品详情列出存到哪，海报墙标「已有」；来源删掉记录跟着没", async () => {
  const entry = await addPack();
  assert.equal(recordLibrarySave({ shareCode: "pack", itemIds: [tree.get("/老K/2. 剧集/神探夏洛克")!.id], taskId: "t-tv", subPath: "美剧" }, now), 2);
  const sherlock = await detail("tv:19885");
  assert.equal(sherlock.work.owned, true);
  assert.equal(sherlock.owned.length, 2);
  assert.ok(sherlock.owned.every((o) => o.via === "saved" && o.taskId === "t-tv" && o.path.startsWith("美剧/神探夏洛克 第") && o.savedAt === now));
  const wall = await works();
  assert.equal(wall.works.find((w) => w.key === "tv:19885")?.owned, true);
  assert.equal(wall.works.find((w) => w.key === "movie:13")?.owned, undefined);

  // 只存了目录里的一个文件也算存过这一部；同一个任务再存一次只留一条
  const gumpFile = tree.get("/老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界/Forrest.Gump.1994.2160p.BluRay.REMUX.mkv")!.id;
  recordLibrarySave({ shareCode: "pack", itemIds: [gumpFile], taskId: "t-movie", subPath: "" }, now);
  recordLibrarySave({ shareCode: "pack", itemIds: [gumpFile], taskId: "t-movie", subPath: "" }, now + 5);
  const gump = await detail("movie:13");
  assert.deepEqual(gump.owned.map((o) => [o.via, o.taskId, o.savedAt]), [["saved", "t-movie", now + 5]]);
  assert.equal((await detail("movie:578")).owned.length, 0, "同一个分类目录里别的片不算");
  assert.equal(recordLibrarySave({ shareCode: "other", itemIds: [gumpFile], taskId: "t-movie", subPath: "" }, now), 0, "不在收藏夹里的分享不记");

  remove(entry.id);
  await addPack();
  assert.equal((await detail("tv:19885")).owned.length, 0, "来源删掉，记录跟着删");
});

test("认出来的顺手存上类型、国家 / 地区，能按它们筛；以前认的（没存）识别工人闲下来时补，不重认", async () => {
  const entry = await addPack();
  const gump = unitsOfSource(entry.id).find((u) => u.parsedTitle === "阿甘正传")!;
  assert.deepEqual(gump.genres, [35, 18, 10749]);
  assert.deepEqual(gump.countries, ["US"]);
  assert.equal(gump.originalLanguage, "en");
  const q = { view: "all" as const, sort: "title" as const, offset: 0, limit: 50 };
  assert.deepEqual(listWorks({ ...q, genres: [18] }).works.map((w) => w.key).sort(), ["movie:13", "movie:60243", "tv:19885"]);
  assert.deepEqual(listWorks({ ...q, genres: [9648] }).works.map((w) => w.key), ["tv:19885"]);
  assert.deepEqual(listWorks({ ...q, countries: ["GB", "IR"] }).works.map((w) => w.key).sort(), ["movie:60243", "tv:19885"]);
  assert.deepEqual(listWorks({ ...q, genres: [18], countries: ["US"] }).works.map((w) => w.key), ["movie:13"]);
  assert.deepEqual((await detail("tv:19885")).work.countries, ["GB"]);

  // 升级上来的：认过但没存类型——工人补上，识别结果（手动的也一样）不动
  sqlite.prepare("UPDATE library_units SET genres = NULL, countries = NULL, original_language = NULL WHERE source_id = ?").run(entry.id);
  const before = tmdbCalls;
  kickIdentify();
  await settle();
  const after = unitsOfSource(entry.id).find((u) => u.parsedTitle === "阿甘正传")!;
  assert.deepEqual(after.genres, [35, 18, 10749]);
  assert.equal(after.status, "done");
  assert.equal(after.tmdbId, 13);
  assert.ok(tmdbCalls > before, "补的时候问了详情");
  assert.ok(unitsOfSource(entry.id).every((u) => u.tmdbId == null || u.genres !== null), "认出来的都补上了");
});

test("片单：一串片名逐个找，整个名字对上的优先，原名也算，带年份要对上；重名给几部让人挑；owned 同海报墙", async () => {
  await addPack();
  const rows = lookupWorks(["阿甘正传 1994", "Forrest Gump", "大白鲨", "神探夏洛克 2010", "阿甘正传 2001", "不存在的片"], new Set(["movie:13"]));
  assert.deepEqual(
    rows.map((r) => [r.query, r.work?.key ?? null, r.maybe.map((w) => w.key)]),
    [
      ["阿甘正传 1994", "movie:13", []],
      ["Forrest Gump", "movie:13", []],
      ["大白鲨", "movie:578", []],
      ["神探夏洛克 2010", "tv:19885", []],
      ["阿甘正传 2001", null, []],
      ["不存在的片", null, []],
    ],
  );
  assert.equal(rows[0].work?.owned, true);
  // 名字只包含、又有好几部：说不准，给几部
  const loose = lookupWorks(["大白"]);
  assert.equal(loose[0].work, null);
  assert.deepEqual(loose[0].maybe.map((w) => w.key).sort(), ["movie:578", "movie:579"]);
});

test("aka：名字归一化、去重、限长", () => {
  assert.equal(akaOf(["神探夏洛克", "Sherlock", "SHERLOCK", "", undefined, "BBC Sherlock"]), "神探夏洛克|sherlock|bbcsherlock");
  assert.ok(akaOf(Array.from({ length: 500 }, (_, i) => `名字${i}`)).length <= 2000);
});

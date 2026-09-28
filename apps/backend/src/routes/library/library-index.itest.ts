/**
 * 影库索引的闭环：加入 → 宽度优先抄目录 → 搜索（中文名 / 英文文件名 / 年份在文件里 / 收拢）→ 刷新 → 判重叠吸收 →
 * 分享死活（失效、提取码不对、疑似失效三连、子目录打不开）→ 清理失效。115 的内存假网盘。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/library/library-index.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, AppSettings, LibrarySearchResult, MediaLibraryEntry } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import libraryRoute from "./index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { getAll, getIndexGen, remove } from "../../db/repositories/media-library.js";
import { getShare } from "../../db/repositories/library-shares.js";
import { deleteAppSetting, patchAppSettings, readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { setDriveProviderFactory } from "../../services/drive/registry.js";
import { ShareGoneError } from "../../services/drive/types.js";
import { checkShare, patrolOnce, setLibraryHealthDeps, startLibraryHealth, stopLibraryHealth } from "../../services/library/health.js";
import { INDEX_LIMITS, INDEX_SLICE, __test_whenIdle, rebuildSearchTextIfStale, setIndexerDeps, startIndexer, stopIndexer } from "../../services/library/indexer.js";
import { SEARCH_TEXT_VERSION } from "../../services/library/search-text.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";
import { sqlite } from "../../db/client.js";
import { setScrapeWorkerDeps } from "../../services/library/scrape-worker.js";
import { FakeDrive, type FakeTree } from "../../test/fake-drive.js";

const acc: AccountInfo = { accountType: "115", name: "a", cookie: "c" };
const drive = new FakeDrive("115", acc, { share: true });
const share = drive.share!;
const LINK = "https://115.com/s/pack?password=ab12";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { accounts: AccountInfo[]; settings: AppSettings };
let now = 1_800_000_000;
let tree: FakeTree;

/** 「老K」那种分类大包的缩小版 */
function definePack(): FakeTree {
  const t = share.define("pack", { title: "老K", password: "ab12" });
  t.addFile("/老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界/Forrest.Gump.1994.2160p.BluRay.REMUX.mkv", { size: 50 });
  t.addFile("/老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界/阿甘正传.jpg", { size: 1 });
  t.addFile("/老K/1. 电影/一次别离 奥斯卡提名 豆瓣8.8 蓝光原盘REMUX/A.Separation.2011.1080p.BluRay.REMUX.mkv", { size: 28 });
  t.addFile("/老K/1. 电影/大白鲨 4部 4K原盘REMUX/大白鲨1 4K原盘REMUX/Jaws.1975.2160p.mkv", { size: 40 });
  t.addFile("/老K/1. 电影/大白鲨 4部 4K原盘REMUX/大白鲨2 4K原盘REMUX/Jaws.2.1978.2160p.mkv", { size: 30 });
  t.addFile("/老K/2. 剧集/神探夏洛克/神探夏洛克 第1季 4K原盘REMUX/Sherlock.S01E01.2160p.mkv", { size: 10 });
  t.addFile("/老K/2. 剧集/神探夏洛克/神探夏洛克 第1季 4K原盘REMUX/Sherlock.S01E02.2160p.mkv", { size: 10 });
  t.addFile("/老K/2. 剧集/神探夏洛克/神探夏洛克 第2季 蓝光原盘REMUX/Sherlock.S02E01.1080p.mkv", { size: 8 });
  t.addFile("/老K/2. 剧集/越狱/越狱 全5季 760G/Prison.Break.S01.1080p/Prison.Break.S01E01.mkv", { size: 5 });
  return t;
}

const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers: auth, payload: payload as Record<string, unknown> });
const search = async (q: string, extra = ""): Promise<LibrarySearchResult> => {
  const res = await app.inject({ method: "GET", url: `/api/library/search?q=${encodeURIComponent(q)}${extra}`, headers: auth });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
};
const sources = async (): Promise<MediaLibraryEntry[]> => (await app.inject({ method: "GET", url: "/api/library", headers: auth })).json();

async function addWhole(link = LINK): Promise<MediaLibraryEntry> {
  const res = await post("/api/library", { shareUrl: link });
  assert.equal(res.statusCode, 201, res.body);
  await __test_whenIdle();
  return res.json().entry;
}

before(async () => {
  baseline = { accounts: listAccounts(), settings: readAppSettings() };
  replaceAccounts([acc]);
  deleteAppSetting("tmdb");
  await writeAuthPassword("library-index-itest-pw");
  setDriveProviderFactory((a) => (a.name === "a" ? drive : null));
  setIndexerDeps({ now: () => now, sleep: async () => {}, busy: () => false, retryDelaysMs: [0, 0, 0], gapMs: 0, yieldMaxMs: 0 });
  setLibraryHealthDeps({ now: () => now, notify: async () => {}, verifyDelayMs: 0 });
  startLibraryHealth({ patrol: false });
  startIndexer();

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(libraryRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

beforeEach(async () => {
  await __test_whenIdle();
  for (const s of getAll()) remove(s.id);
  share.shares.clear();
  share.log.length = 0;
  share.listHook = null;
  share.pageSize = 100;
  tree = definePack();
  now += 3600;
  // 每个用例都从干净的分享登记开始（上一个用例删了来源，分享码也跟着撤）
  stopLibraryHealth();
  startLibraryHealth({ patrol: false });
});

after(async () => {
  stopIndexer();
  stopLibraryHealth();
  setIndexerDeps(null);
  setLibraryHealthDeps(null);
  setScrapeWorkerDeps(null);
  await app.close();
  for (const s of getAll()) remove(s.id);
  setDriveProviderFactory(null);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  await writeAuthPassword(DEFAULT_AUTH.password);
});

test("整包加入：宽度优先抄完；中文目录名、英文文件名、目录名加文件里的年份都搜得到，年份只加分，季目录收进剧目录", async () => {
  share.pageSize = 2; // 顺带验翻页
  const entry = await addWhole();
  const [s] = await sources();
  assert.equal(s.id, entry.id);
  assert.equal(s.indexStatus, "done");
  assert.equal(s.shareTitle, "老K");
  assert.equal(s.videoCount, 8);
  assert.equal(s.totalSize, 50 + 1 + 28 + 40 + 30 + 10 + 10 + 8 + 5);
  assert.equal(s.health?.status, "ok");

  // 宽度优先：浅的目录先列（根 → 老K → 两个分类 → 作品目录 …）
  const listed = share.log.filter((l) => l.startsWith("list ") && !l.includes("@")).map((l) => tree.pathOf(l.slice(5)) ?? l);
  assert.deepEqual(listed.slice(0, 4), ["/", "/老K", "/老K/1. 电影", "/老K/2. 剧集"]);

  const byName = await search("阿甘正传");
  assert.equal(byName.total, 1);
  const hit = byName.hits[0];
  assert.equal(hit.name, "阿甘正传 4K原盘REMUX 杜比视界");
  assert.equal(hit.matched, "name");
  assert.equal(hit.shareTitle, "老K");
  assert.equal(hit.shareUrl, LINK);
  assert.equal(hit.path, "老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界");
  assert.deepEqual(hit.crumbs.map((c) => c.name), ["老K", "1. 电影", "阿甘正传 4K原盘REMUX 杜比视界"]);
  assert.ok(hit.crumbs.every((c) => c.id), "面包屑每段都有 id，弹框能直接定位");
  assert.deepEqual(hit.files, [{ name: "Forrest.Gump.1994.2160p.BluRay.REMUX.mkv", size: 50 }]);
  assert.ok(hit.tags.includes("4K") && hit.tags.includes("杜比视界"), hit.tags.join(","));
  assert.equal(hit.keyword, "阿甘正传", "找替代的关键词不带年份");
  assert.equal(hit.size, 51);

  assert.equal((await search("Forrest Gump")).hits[0]?.name, "阿甘正传 4K原盘REMUX 杜比视界");
  assert.equal((await search("Forrest Gump")).hits[0]?.matched, "files");
  assert.equal((await search("阿甘正传 1994")).total, 1, "片名在目录名、年份在文件名，也要对上");
  // 年份只加分：目录名、文件名里都没写年份的照样给；年份对上的排前面
  assert.equal((await search("神探夏洛克 2010")).hits[0]?.name, "神探夏洛克");
  assert.deepEqual((await search("jaws 1978")).hits.map((h) => h.name), ["大白鲨2 4K原盘REMUX", "大白鲨1 4K原盘REMUX"]);
  assert.equal((await search("2046")).total, 0, "只有年份时照常要对上");

  const sherlock = await search("神探夏洛克");
  assert.equal(sherlock.total, 1);
  assert.equal(sherlock.hits[0].name, "神探夏洛克");
  assert.equal(sherlock.hits[0].childHits, 2, "两个季目录收进剧目录");
  // 剧目录自己没有视频：报子树的视频数、下一层的季目录、第一季里的样例，标签取季目录名的
  assert.equal(sherlock.hits[0].videoCount, 3);
  assert.deepEqual(sherlock.hits[0].subdirs, ["神探夏洛克 第1季 4K原盘REMUX", "神探夏洛克 第2季 蓝光原盘REMUX"]);
  assert.equal(sherlock.hits[0].subdirCount, 2);
  assert.deepEqual(sherlock.hits[0].files.map((f) => f.name), ["Sherlock.S01E01.2160p.mkv", "Sherlock.S01E02.2160p.mkv"]);
  assert.ok(sherlock.hits[0].tags.includes("4K"), sherlock.hits[0].tags.join(","));
  assert.equal(hit.subdirs.length, 0, "直接放着视频的不报下一层");
  // 汉字数字：「第一季」对得上「第1季」
  assert.equal((await search("神探夏洛克 第一季")).hits[0]?.name, "神探夏洛克 第1季 4K原盘REMUX");

  // 合集下的两部各自一条（合集目录本身不含 jaws）
  assert.deepEqual((await search("jaws")).hits.map((h) => h.name).sort(), ["大白鲨1 4K原盘REMUX", "大白鲨2 4K原盘REMUX"]);
  // 搜分享标题：根是虚拟的，落在里面那层同名目录上（能直接转存）
  const byTitle = await search("老K");
  assert.equal(byTitle.total, 1);
  assert.equal(byTitle.hits[0].nodeId, tree.get("/老K")!.id);
  assert.equal(byTitle.hits[0].parentId, "0");
});

test("搜索规则换了：启动时按库里的目录树就地重算搜索文本，不用重抄", async () => {
  await addWhole();
  const [s] = await sources();
  // 模拟旧规则算的：搜索文本清空、版本号退回去
  sqlite.prepare(`UPDATE library_nodes SET search_text = '' WHERE source_id = ?`).run(s.id);
  writeKv(KEY.librarySearchTextVersion, 1);
  assert.equal((await search("阿甘正传")).total, 0);
  share.log.length = 0;
  rebuildSearchTextIfStale();
  assert.equal(readKv(KEY.librarySearchTextVersion), SEARCH_TEXT_VERSION);
  assert.equal((await search("阿甘正传")).total, 1);
  assert.equal((await search("Forrest Gump")).total, 1, "文件名也重算进去了");
  assert.equal(share.log.length, 0, "没去问网盘");
  // 版本对上了不再重算
  sqlite.prepare(`UPDATE library_nodes SET search_text = '' WHERE source_id = ?`).run(s.id);
  rebuildSearchTextIfStale();
  assert.equal((await search("阿甘正传")).total, 0);
  writeKv(KEY.librarySearchTextVersion, 1);
  rebuildSearchTextIfStale();
});

test("浅层先能搜：还在抄深层的时候，作品目录名已经搜得到", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let lists = 0;
  setIndexerDeps({
    sleep: async () => {
      lists++;
      // 列完根、老K、1. 电影 之后停在这里
      if (lists === 3) await gate;
    },
    gapMs: 1,
  });
  try {
    const res = await post("/api/library", { shareUrl: LINK });
    assert.equal(res.statusCode, 201);
    for (let i = 0; i < 100 && lists < 3; i++) await new Promise((r) => setTimeout(r, 5));
    const mid = await search("阿甘正传");
    assert.equal(mid.total, 1, "作品目录一被列出来就能按名字搜");
    assert.equal(mid.indexing, 1, "告诉调用方还在抄");
    assert.equal((await search("Forrest Gump")).total, 0, "文件名还没抄到");
    release();
    await __test_whenIdle();
    assert.equal((await search("Forrest Gump")).total, 1);
  } finally {
    release();
    setIndexerDeps({ sleep: async () => {}, gapMs: 0 });
  }
});

test("续抄：中途停掉再启动，接着这一轮，已经列过的目录不再列", async () => {
  let lists = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  setIndexerDeps({
    sleep: async () => {
      lists++;
      if (lists === 4) await gate;
    },
    gapMs: 1,
  });
  try {
    await post("/api/library", { shareUrl: LINK });
    for (let i = 0; i < 100 && lists < 4; i++) await new Promise((r) => setTimeout(r, 5));
    stopIndexer(); // 相当于进程退出
    release();
    await __test_whenIdle();
    const before = share.log.filter((l) => l.startsWith("list ")).length;
    assert.equal((await sources())[0].indexStatus, "indexing");
    setIndexerDeps({ sleep: async () => {}, gapMs: 0 });
    startIndexer();
    await __test_whenIdle();
    const lists2 = share.log.filter((l) => l.startsWith("list ")).map((l) => l.slice(5));
    assert.equal(new Set(lists2).size, lists2.length, `没有目录被列两次：${lists2.join(" ")}`);
    assert.ok(lists2.length > before);
    assert.equal((await sources())[0].indexStatus, "done");
  } finally {
    release();
    setIndexerDeps({ sleep: async () => {}, gapMs: 0 });
  }
});

test("刷新：分享里删掉的搜不到了，新加的搜得到", async () => {
  const entry = await addWhole();
  tree.remove("/老K/1. 电影/一次别离 奥斯卡提名 豆瓣8.8 蓝光原盘REMUX");
  tree.addFile("/老K/1. 电影/沙丘2 4K原盘REMUX/Dune.Part.Two.2024.2160p.mkv", { size: 60 });
  const res = await post(`/api/library/${entry.id}/refresh`, {});
  assert.equal(res.statusCode, 200);
  await __test_whenIdle();
  assert.equal((await search("一次别离")).total, 0);
  assert.equal((await search("沙丘2")).total, 1);
  assert.equal((await search("阿甘正传")).total, 1, "没动的照旧");
});

test("判重叠：整包收了再收子目录 409；先收子目录再收整包，旧的被吸收（标签并过来）", async () => {
  const drama = tree.get("/老K/2. 剧集")!;
  const sub = await post("/api/library", { shareUrl: LINK, cid: drama.id, rawName: "2. 剧集", sharePath: "老K/2. 剧集", tags: ["剧"] });
  assert.equal(sub.statusCode, 201, sub.body);
  await __test_whenIdle();
  assert.equal((await search("神探夏洛克")).total, 1);
  assert.equal((await search("阿甘正传")).total, 0, "只收了剧集");
  const dup = await post("/api/library", { shareUrl: LINK, cid: drama.id, rawName: "2. 剧集", sharePath: "老K/2. 剧集" });
  assert.equal(dup.statusCode, 409);

  const whole = await post("/api/library", { shareUrl: LINK });
  assert.equal(whole.statusCode, 201, whole.body);
  assert.equal(whole.json().absorbed, 1);
  await __test_whenIdle();
  const list = await sources();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].tags, ["剧"]);
  assert.equal((await search("阿甘正传")).total, 1);

  const again = await post("/api/library", { shareUrl: LINK, cid: drama.id, rawName: "2. 剧集", sharePath: "老K/2. 剧集" });
  assert.equal(again.statusCode, 409);
  assert.match(again.json().message, /整个分享「老K」/);
});

test("分享失效：根上明确说不存在就判失效；搜索里折叠成个数；清理按钮删掉记录", async () => {
  await addWhole();
  share.shares.get("pack")!.gone = true;
  now += 7 * 3600;
  const health = await checkShare("pack");
  assert.equal(health.status, "expired");
  assert.match(health.reason, /not exist/);
  const r = await search("阿甘正传");
  assert.equal(r.total, 0);
  assert.equal(r.expired, 1);
  assert.equal((await search("阿甘正传", "&expired=1")).expiredHits?.[0]?.name, "阿甘正传 4K原盘REMUX 杜比视界");
  assert.equal((await sources())[0].health?.status, "expired");

  const del = await app.inject({ method: "DELETE", url: "/api/library/expired", headers: auth });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { shares: 1, sources: 1 });
  assert.equal((await sources()).length, 0);
  assert.equal(getShare("pack"), null, "分享码的登记也撤了");
});

test("提取码不对：记 locked、来源停下；改好提取码就恢复并重新抄", async () => {
  const res = await post("/api/library", { shareUrl: "https://115.com/s/pack?password=zz99" });
  assert.equal(res.statusCode, 201);
  await __test_whenIdle();
  let [s] = await sources();
  assert.equal(s.health?.status, "locked");
  assert.equal(s.indexStatus, "failed");
  assert.match(s.indexError, /提取码/);

  const put = await app.inject({ method: "PUT", url: `/api/library/${s.id}`, headers: auth, payload: { receiveCode: "ab12" } });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal(put.json().health.status, "ok");
  await __test_whenIdle();
  [s] = await sources();
  assert.equal(s.receiveCode, "ab12");
  assert.equal(s.shareUrl, LINK);
  assert.equal(s.indexStatus, "done");
  assert.equal((await search("阿甘正传")).total, 1);
});

test("含糊的失败：先疑似失效，按时复查，连续三次才判失效；中间好一次就恢复", async () => {
  await addWhole();
  const realInfo = share.info.bind(share);
  let failing = true;
  share.info = async (s) => {
    if (failing) throw new ShareGoneError("服务器开小差", 990);
    return realInfo(s);
  };
  try {
    now += 25 * 3600;
    assert.equal((await checkShare("pack")).status, "suspect");
    assert.equal((await search("阿甘正传")).total, 1, "疑似失效的照常给");
    // 还没到复查时间：巡检不查它
    now += 60;
    assert.equal(await patrolOnce(), 0);
    now += 31 * 60;
    assert.equal(await patrolOnce(), 1);
    assert.equal(getShare("pack")?.status, "suspect");
    assert.equal(getShare("pack")?.failStreak, 2);
    // 中间好了一次：恢复、清零
    failing = false;
    now += 3 * 3600 + 60;
    await patrolOnce();
    assert.equal(getShare("pack")?.status, "ok");
    assert.equal(getShare("pack")?.failStreak, 0);
    // 再连着坏三次才判失效
    failing = true;
    now += 25 * 3600;
    await checkShare("pack");
    now += 31 * 60;
    await patrolOnce();
    assert.equal(getShare("pack")?.status, "suspect");
    now += 3 * 3600 + 60;
    await patrolOnce();
    assert.equal(getShare("pack")?.status, "expired");
  } finally {
    share.info = realInfo;
  }
});

test("再查一次：失效的分享又能打开了，点一下就恢复、停下的接着这一轮抄；还是打不开、没问到网盘都说清楚", async () => {
  // 抄到一半分享没了（列完第三个目录）：来源停下
  let lists = 0;
  share.listHook = (_dirId, entries) => {
    if (++lists === 3) share.shares.get("pack")!.gone = true;
    return entries;
  };
  await addWhole();
  now += 60;
  await checkShare("pack");
  await new Promise((r) => setTimeout(r, 10)); // 子目录复核的定时器也跑完
  let [s] = await sources();
  assert.equal(s.health?.status, "expired");
  assert.equal(s.indexStatus, "failed");
  assert.match(s.indexError, /^分享已失效/);
  const listed = s.dirsListed;
  assert.ok(listed >= 3 && listed < s.dirsTotal, `${listed}/${s.dirsTotal}`);
  const gen = getIndexGen(s.id)?.gen;

  // 还是打不开：说原因，不去排队
  now += 60;
  let res = await post(`/api/library/${s.id}/refresh`, {});
  assert.equal(res.statusCode, 500, res.body);
  assert.equal(res.json().code, "SHARE_GONE");
  assert.match(res.json().message, /^分享还是打不开：.*not exist/);
  assert.equal((await sources())[0].indexStatus, "failed");

  // 没问到网盘（网络、账号）：不算分享的错，别说「还是打不开」
  drive.failWith = new Error("socket hang up");
  now += 60;
  try {
    res = await post(`/api/library/${s.id}/refresh`, {});
  } finally {
    drive.failWith = null;
  }
  assert.equal(res.statusCode, 500);
  assert.match(res.json().message, /没查成/);
  assert.equal(getShare("pack")?.status, "expired");

  // 审核完又能打开了：恢复，接着那一轮抄——同一代，根目录不再列
  share.shares.get("pack")!.gone = false;
  share.listHook = null;
  share.log.length = 0;
  now += 60;
  res = await post(`/api/library/${s.id}/refresh`, {});
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().health.status, "ok");
  await __test_whenIdle();
  [s] = await sources();
  assert.equal(s.indexStatus, "done");
  assert.equal(s.indexError, "");
  assert.equal(getIndexGen(s.id)?.gen, gen, "接着那一轮，不是从头来");
  assert.ok(!share.log.includes("list 0"), share.log.join(","));
  assert.equal((await search("神探夏洛克")).total, 1);
  assert.equal((await search("阿甘正传")).total, 1);
});

test("分享又能打开了：不管是谁用到时发现的，因为失效停下的来源都接着抄；抄完的不重抄", async () => {
  let lists = 0;
  share.listHook = (_dirId, entries) => {
    if (++lists === 3) share.shares.get("pack")!.gone = true;
    return entries;
  };
  await addWhole();
  now += 60;
  await checkShare("pack");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await sources())[0].indexStatus, "failed");

  // 没点「再查一次」：弹框、转存、智能体用到这个分享时发现能打开了（这里用一次主动查代替）
  share.shares.get("pack")!.gone = false;
  share.listHook = null;
  now += 60;
  assert.equal((await checkShare("pack")).status, "ok");
  await __test_whenIdle();
  const [s] = await sources();
  assert.equal(s.indexStatus, "done");
  const doneGen = getIndexGen(s.id)?.gen;

  // 抄完之后再失效、再恢复：索引是好的，不用重抄
  share.shares.get("pack")!.gone = true;
  now += 60;
  await checkShare("pack");
  share.shares.get("pack")!.gone = false;
  share.log.length = 0;
  now += 60;
  await checkShare("pack");
  await __test_whenIdle();
  assert.equal((await sources())[0].indexStatus, "done");
  assert.equal(getIndexGen(s.id)?.gen, doneGen);
  assert.equal(share.log.filter((l) => l.startsWith("list ")).length, 0);
});

test("分享还在、某个目录打不开了：只标那个目录，别的照常，整包不算失效", async () => {
  const gone = tree.get("/老K/1. 电影/一次别离 奥斯卡提名 豆瓣8.8 蓝光原盘REMUX")!;
  share.listHook = (dirId, entries) => {
    if (dirId === gone.id) throw new ShareGoneError("目录不存在", 4102);
    return entries;
  };
  await post("/api/library", { shareUrl: LINK });
  // 工人碰到打不开的目录先歇 30 秒；复核（没等待）标了 missing 以后把来源挪回在抄，这里推进时间让它接着抄
  for (let i = 0; i < 50; i++) {
    await __test_whenIdle();
    const [s] = await sources();
    if (s.indexStatus === "done") break;
    now += 60;
    startIndexer();
    await new Promise((r) => setTimeout(r, 10));
  }
  const [s] = await sources();
  assert.equal(s.indexStatus, "done", s.indexError);
  assert.equal(s.health?.status, "ok");
  assert.equal((await search("一次别离")).total, 0);
  assert.equal((await search("阿甘正传")).total, 1);
});

test("网络出错：同一目录重试几次，还不行就暂停一会儿（带原因），到点接着抄", async () => {
  const movies = tree.get("/老K/1. 电影")!;
  let fails = 5;
  share.listHook = (dirId, entries) => {
    if (dirId === movies.id && fails-- > 0) throw new Error("socket hang up");
    return entries;
  };
  await post("/api/library", { shareUrl: LINK });
  await __test_whenIdle();
  let [s] = await sources();
  assert.equal(s.indexStatus, "indexing");
  assert.match(s.indexError, /暂时连不上/);
  now += 11 * 60;
  startIndexer();
  await __test_whenIdle();
  [s] = await sources();
  assert.equal(s.indexStatus, "done");
  assert.equal(s.indexError, "");
});

test("让路：账号上有别人在排队就先等再发", async () => {
  let busyChecks = 0;
  const waits: number[] = [];
  setIndexerDeps({
    busy: () => ++busyChecks % 3 !== 0,
    sleep: async (ms) => {
      waits.push(ms);
    },
    yieldMaxMs: 60_000,
  });
  try {
    await addWhole();
    assert.ok(waits.filter((ms) => ms === 250).length > 0, "忙的时候等了");
  } finally {
    setIndexerDeps({ busy: () => false, sleep: async () => {}, yieldMaxMs: 0 });
  }
});

test("轮流抄：大包抄着的时候后加的小分享不用排到大包抄完", async () => {
  const saved = INDEX_SLICE.DIRS;
  INDEX_SLICE.DIRS = 2;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let lists = 0;
  setIndexerDeps({
    sleep: async () => {
      lists++;
      // 大包列了一个目录后停一下，让小分享在这时候加进来
      if (lists === 1) await gate;
    },
    gapMs: 1,
  });
  try {
    const small = share.define("tiny", { title: "单片" });
    small.addFile("/阿凡达 2009/Avatar.2009.mkv", { size: 1 });
    await post("/api/library", { shareUrl: LINK });
    for (let i = 0; i < 100 && lists < 1; i++) await new Promise((r) => setTimeout(r, 5));
    const res = await post("/api/library", { shareUrl: "https://115.com/s/tiny" });
    assert.equal(res.statusCode, 201, res.body);
    release();
    await __test_whenIdle();
    const listed = share.log.filter((l) => l.startsWith("list ")).map((l) => l.slice(5));
    const tinyRoot = listed.indexOf("0", 1);
    const lastPack = listed.length - 1 - [...listed].reverse().findIndex((id) => (tree.pathOf(id) ?? "").startsWith("/老K") || id === "0");
    assert.ok(tinyRoot > 0 && tinyRoot < lastPack, `小分享在大包抄完之前就轮到了：${listed.join(" ")}`);
    const list = await sources();
    assert.ok(list.every((x) => x.indexStatus === "done"));
    assert.equal((await search("阿凡达")).total, 1);
  } finally {
    release();
    INDEX_SLICE.DIRS = saved;
    setIndexerDeps({ sleep: async () => {}, gapMs: 0 });
  }
});

test("加入时就先查一次：提取码不对当场记下，不去排队", async () => {
  const res = await post("/api/library", { shareUrl: "https://115.com/s/pack?password=zz99" });
  assert.equal(res.statusCode, 201);
  const entry = res.json().entry as MediaLibraryEntry;
  assert.equal(entry.health?.status, "locked");
  assert.equal(entry.indexStatus, "failed");
  assert.equal(share.log.filter((l) => l.startsWith("list ")).length, 0, "没去列目录");
});

test("超过上限：停下标 truncated，已经抄到的照样能搜", async () => {
  const saved = { ...INDEX_LIMITS };
  INDEX_LIMITS.MAX_DIRS = 3;
  try {
    await addWhole();
    const [s] = await sources();
    assert.equal(s.indexStatus, "done");
    assert.equal(s.truncated, true);
    assert.match(s.indexError, /上限/);
    assert.equal((await search("1. 电影")).total, 1);
  } finally {
    Object.assign(INDEX_LIMITS, saved);
  }
});

test("刮海报：看起来是一部作品才刮，整包不刮", async () => {
  patchAppSettings({ tmdb: { apiKey: "k", language: "zh-CN" } });
  setScrapeWorkerDeps({ searchMulti: async () => [], searchTv: async () => [], searchMovie: async () => [], throttle: async () => {}, retryDelayMs: () => 1 });
  try {
    await addWhole();
    assert.equal((await sources())[0].scrapeStatus, "done", "整包不刮");
    const single = share.define("one", { title: "阿甘正传" });
    single.addFile("/阿甘正传 4K/Forrest.Gump.1994.mkv", { size: 1 });
    const res = await post("/api/library", { shareUrl: "https://115.com/s/one" });
    assert.equal(res.statusCode, 201, res.body);
    await __test_whenIdle();
    const one = (await sources()).find((x) => x.shareCode === "one")!;
    assert.notEqual(one.scrapeStatus, "done", "一部作品排进刮削（stub 回空会记 failed）");
  } finally {
    deleteAppSetting("tmdb");
  }
});

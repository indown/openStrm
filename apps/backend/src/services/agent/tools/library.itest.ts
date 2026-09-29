/**
 * 收藏夹工具：
 *   - library_search：按名字找目录，给得出判断对不对的东西（文件名、画质、大小、位置）和直接转存要的 id；失效分享里的只报个数；没找到给下一步
 *   - library_works / library_work：按作品看，一部作品的全部版本、本地有没有、交给 share_save 的参数、剧分季的一起转存
 *   - library_add：收藏分享（一个或几个），已经收着的、认不出的
 *   - library_match / library_sources：纠错写回、收藏的分享和失效分享里的作品；library_works 的片单、类型 / 地区筛、纠错要看的东西
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/agent/tools/library.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgentToken } from "@openstrm/shared";
import { createApiToken, deleteAllApiTokens } from "../../../db/repositories/api-tokens.js";
import { writeAppSetting } from "../../../db/repositories/settings.js";
import { seedLibrarySource, unseedLibrarySource } from "../../../test/library-seed.js";
import { getUnit, saveDetails, saveIdentified, unitsOfSource } from "../../../db/repositories/library-units.js";
import { setIdentifyDeps } from "../../library/identify.js";
import type { TmdbDetails } from "../../tmdb.js";
import { getAll, remove } from "../../../db/repositories/media-library.js";
import { rebuildUnits } from "../../library/units.js";
import { recordLibrarySave } from "../../library/saves.js";
import { __test_resetOwned } from "../../library/owned.js";
import type { ToolDef } from "../define.js";
import { callTool, type ToolOutcome } from "../calls.js";
import { libraryAddTool, libraryMatchTool, librarySearchTool, librarySourcesTool, libraryWorkTool, libraryWorksTool } from "./library.js";
import { toolsFor } from "./index.js";

let reader: AgentToken;
let runner: AgentToken;

const A = { id: "lib-a", shareCode: "swpacka", shareUrl: "https://115.com/s/swpacka?password=ab12", shareTitle: "老K" };
const B = { id: "lib-b", shareCode: "swpackb", shareUrl: "https://115.com/s/swpackb?password=cd34", shareTitle: "旧包" };

before(() => {
  writeAppSetting("agent", { enabled: true });
  reader = createApiToken({ name: "只读", scopes: ["read"], toolsets: ["transfer"], expiresAt: null }).info;
  runner = createApiToken({ name: "日常", scopes: ["read", "run"], toolsets: ["transfer"], expiresAt: null }).info;
  seedLibrarySource({
    ...A,
    files: {
      "老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界/Forrest.Gump.1994.2160p.BluRay.REMUX.mkv": 50 * 1024 ** 3,
      "老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界/阿甘正传.jpg": 1024,
      "老K/2. 剧集/神探夏洛克/神探夏洛克 第1季/Sherlock.S01E01.mkv": 10,
      "老K/2. 剧集/神探夏洛克/神探夏洛克 第2季/Sherlock.S02E01.mkv": 10,
    },
  });
  seedLibrarySource({ ...B, status: "expired", files: { "旧包/阿甘正传 1080P/Forrest.Gump.1994.1080p.mkv": 8 } });
});

after(() => {
  unseedLibrarySource(A.id, A.shareCode);
  unseedLibrarySource(B.id, B.shareCode);
  deleteAllApiTokens();
});

async function call(tool: ToolDef, args: Record<string, unknown>, token = reader): Promise<ToolOutcome> {
  return callTool(tool, args, { token, ip: "127.0.0.1" }, { signal: new AbortController().signal, progress: () => {} });
}

async function runTool(tool: ToolDef, args: Record<string, unknown>, token = reader): Promise<Record<string, any>> {
  const out = await call(tool, args, token);
  assert.equal(out.ok, true, out.ok ? "" : JSON.stringify(out.failure));
  return (out as { ok: true; data: Record<string, any> }).data;
}

const run = (args: Record<string, unknown>) => runTool(librarySearchTool, args);

/** 切作品单元，再给阿甘正传、夏洛克两季写上识别结果（不走 TMDB） */
function identifyPack(): void {
  rebuildUnits(A.id);
  const now = Math.floor(Date.now() / 1000);
  for (const u of unitsOfSource(A.id)) {
    const gump = u.path.includes("阿甘正传");
    const sherlock = u.path.includes("神探夏洛克");
    if (!gump && !sherlock) continue;
    saveIdentified(
      A.id,
      u.unitKey,
      gump
        ? { status: "done", tmdbId: 13, mediaType: "movie", title: "阿甘正传", originalTitle: "Forrest Gump", enTitle: "Forrest Gump", year: "1994", posterUrl: "", confidence: "high", reason: "", candidates: [], aka: "" }
        : { status: "done", tmdbId: 19885, mediaType: "tv", title: "神探夏洛克", originalTitle: "Sherlock", enTitle: "Sherlock", year: "2010", posterUrl: "", confidence: "high", reason: "", candidates: [], aka: "" },
      now,
    );
  }
}

test("中文名、英文文件名都找得到；每条带判断用的信息和转存要的 id", async () => {
  const d = await run({ keyword: "阿甘正传" });
  assert.equal(d.total, 1, "失效分享里的那条不算");
  assert.equal(d.expired, 1);
  const [item] = d.items;
  assert.equal(item.title, "阿甘正传 4K原盘REMUX 杜比视界");
  assert.equal(item.share, "老K");
  assert.equal(item.link, A.shareUrl);
  assert.equal(item.itemId, "d:老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界");
  assert.equal(item.dirId, "d:老K/1. 电影");
  assert.deepEqual(item.files, ["Forrest.Gump.1994.2160p.BluRay.REMUX.mkv"]);
  assert.equal(item.size, "50.0 GB");
  assert.ok(item.tags.includes("4K"));
  assert.equal(item.shareStatus, "ok");
  assert.match(d.next, /share_inspect.*itemId.*share_save/);
  assert.equal((await run({ keyword: "forrest gump 1994" })).items[0].title, "阿甘正传 4K原盘REMUX 杜比视界");
});

test("剧的各季收进剧目录；limit 截断时说怎么缩小；没找到给下一步", async () => {
  const d = await run({ keyword: "sherlock" });
  assert.deepEqual(
    d.items.map((i: { title: string }) => i.title),
    ["神探夏洛克 第1季", "神探夏洛克 第2季"],
    "sherlock 只在文件名里，剧目录本身不含它，各季各一条",
  );
  const byName = await run({ keyword: "神探夏洛克" });
  assert.equal(byName.items.length, 1);
  assert.equal(byName.items[0].alsoMatchedInside, 2);

  const one = await run({ keyword: "sherlock", limit: 1 });
  assert.equal(one.items.length, 1);
  assert.match(one.truncated, /加词缩小范围/);

  const none = await run({ keyword: "不存在的片名" });
  assert.equal(none.items.length, 0);
  assert.match(none.message, /resource_search/);
});

test("library_works：按作品逛，同一部的几季合成一条；按名字、年份筛；owned 标本地已有 / 存过的", async () => {
  identifyPack();
  __test_resetOwned();
  const all = await runTool(libraryWorksTool, {});
  const keys = all.items.map((i: { work: string }) => i.work).sort();
  assert.deepEqual(keys, ["movie:13", "tv:19885"]);
  const sherlock = all.items.find((i: { work: string }) => i.work === "tv:19885");
  assert.deepEqual(sherlock.seasons, [1, 2]);
  assert.equal(sherlock.versions, 2);
  assert.equal(sherlock.owned, undefined);
  assert.match(all.next, /library_work/);
  assert.deepEqual((await runTool(libraryWorksTool, { keyword: "sherlock" })).items.map((i: { work: string }) => i.work), ["tv:19885"], "英文名也算");
  assert.deepEqual((await runTool(libraryWorksTool, { year: "1990-1999" })).items.map((i: { work: string }) => i.work), ["movie:13"]);
  const bad = await call(libraryWorksTool, { year: "九十年代" });
  assert.equal(bad.ok, false);

  recordLibrarySave({ shareCode: A.shareCode, itemIds: ["d:老K/2. 剧集/神探夏洛克"], taskId: "t-tv", subPath: "" });
  const again = await runTool(libraryWorksTool, { view: "tv" });
  assert.equal(again.items[0].owned, true);
});

test("library_work：全部版本带交给 share_save 的参数，剧分季的给 seriesSave；按名字找；owned 列出存到哪", async () => {
  identifyPack();
  __test_resetOwned();
  const d = await runTool(libraryWorkTool, { work: "tv:19885" });
  assert.equal(d.work.title, "神探夏洛克");
  assert.equal(d.work.originalTitle, "Sherlock");
  assert.equal(d.versions.length, 2);
  for (const v of d.versions) {
    assert.equal(v.save.link, A.shareUrl);
    assert.equal(v.save.dirId, "d:老K/2. 剧集/神探夏洛克");
    assert.equal(v.save.itemIds.length, 1);
    assert.equal(v.shareStatus, "ok");
  }
  assert.equal(d.seriesSave.length, 1);
  assert.deepEqual(d.seriesSave[0].seasons, [1, 2]);
  assert.deepEqual(d.seriesSave[0].save.itemIds, ["d:老K/2. 剧集/神探夏洛克/神探夏洛克 第1季", "d:老K/2. 剧集/神探夏洛克/神探夏洛克 第2季"]);
  assert.match(d.next, /share_save/);
  assert.ok(Array.isArray(d.owned));

  const byTitle = await runTool(libraryWorkTool, { title: "Forrest Gump" });
  assert.equal(byTitle.work.key, "movie:13");
  assert.equal(byTitle.versions[0].save.dirId, "d:老K/1. 电影");
  assert.deepEqual(byTitle.versions[0].save.itemIds, ["d:老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界"]);
  assert.equal(byTitle.seriesSave, undefined, "电影没有");

  recordLibrarySave({ shareCode: A.shareCode, itemIds: ["d:老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界"], taskId: "t-movie", subPath: "电影" });
  const owned = (await runTool(libraryWorkTool, { work: "movie:13" })).owned;
  assert.deepEqual(
    owned.map((o: { via: string; taskId: string; path: string }) => [o.via, o.taskId, o.path]),
    [["saved", "t-movie", "电影/阿甘正传 4K原盘REMUX 杜比视界"]],
  );

  const missing = await call(libraryWorkTool, { title: "不存在的片名" });
  assert.equal(missing.ok, false);
  const neither = await call(libraryWorkTool, {});
  assert.equal(neither.ok, false);
});

test("library_add：一段话里几个链接一个一个收，已经收着的是 exists；认不出、超过上限的报错；要运行档", async () => {
  const text = "链接：https://pan.quark.cn/s/abc123 提取码：ab12\nhttps://115.com/s/swnewpack?password=zz99\n" + A.shareUrl;
  const visible = (scopes: AgentToken["scopes"]) => toolsFor({ scopes, toolsets: ["transfer"] }).map((t) => t.name);
  assert.ok(!visible(["read"]).includes("library_add"), "只读令牌看不到");
  assert.ok(visible(["read"]).includes("library_work") && visible(["read", "run"]).includes("library_add"));
  try {
    const d = await runTool(libraryAddTool, { text }, runner);
    assert.deepEqual(
      d.results.map((r: { code: string; status: string }) => [r.code, r.status]),
      [
        ["abc123", "added"],
        ["swnewpack", "added"],
        [A.shareCode, "exists"],
      ],
    );
    assert.equal(d.results[2].title, "老K");
    assert.equal(d.added, 2);
    assert.equal(d.exists, 1);
    assert.match(d.next, /library_search/);
    const again = await runTool(libraryAddTool, { text: "https://115.com/s/swnewpack?password=zz99" }, runner);
    assert.equal(again.results[0].status, "exists");

    const none = await call(libraryAddTool, { text: "随便写的一段话" }, runner);
    assert.equal(none.ok, false);
    const many = Array.from({ length: 21 }, (_, i) => `https://115.com/s/swmany${i}?password=ab12`).join("\n");
    const tooMany = await call(libraryAddTool, { text: many }, runner);
    assert.equal(tooMany.ok, false);
  } finally {
    for (const s of getAll()) if (s.id !== A.id && s.id !== B.id) remove(s.id);
  }
});

/** 换匹配要拿 TMDB 详情：假的几部 */
const DETAILS: Record<string, Partial<TmdbDetails>> = {
  "movie:13": { title: "阿甘正传", originalTitle: "Forrest Gump", year: "1994", genreIds: [35, 18], countries: ["US"] },
  "tv:19885": { title: "神探夏洛克", originalTitle: "Sherlock", year: "2010", genreIds: [80, 18], countries: ["GB"] },
};
function stubTmdb(): void {
  setIdentifyDeps({
    tmdb: () => ({
      search: async () => [],
      season: async () => [],
      details: async (kind: "movie" | "tv", id: number) => {
        const d = DETAILS[`${kind}:${id}`];
        return d
          ? ({ id, mediaType: kind, enTitle: "", posterUrl: "", imdbId: "", genreIds: [], countries: [], originalLanguage: "en", aliases: [], ...d } as TmdbDetails)
          : null;
      },
    }),
  });
}

test("library_works：把握低 / 没认出的带纠错要看的（单元引用、目录名、样例文件名、备选）；library_match 写回：指定、不是影视、重新认，一条错不影响别的", async () => {
  identifyPack();
  stubTmdb();
  try {
    // 阿甘正传认得没把握，备选里有对的那部
    const gump = unitsOfSource(A.id).find((u) => u.path.includes("阿甘正传"))!;
    saveIdentified(
      A.id,
      gump.unitKey,
      {
        status: "done",
        tmdbId: 999,
        mediaType: "movie",
        title: "阿甘外传",
        originalTitle: "",
        enTitle: "",
        year: "1994",
        posterUrl: "",
        confidence: "low",
        reason: "",
        candidates: [{ tmdbId: 13, mediaType: "movie", title: "阿甘正传", year: "1994", posterUrl: "", overview: "", score: 5 }],
        aka: "",
      },
      Math.floor(Date.now() / 1000),
    );
    const low = await runTool(libraryWorksTool, { view: "low" });
    assert.equal(low.items.length, 1);
    const item = low.items[0];
    assert.equal(item.unit, `unit:${A.id}:${gump.unitKey}`);
    assert.equal(item.name, "阿甘正传 4K原盘REMUX 杜比视界");
    assert.equal(item.sampleFile, "Forrest.Gump.1994.2160p.BluRay.REMUX.mkv");
    assert.deepEqual(item.candidates, [{ tmdbId: 13, type: "movie", title: "阿甘正传", year: "1994" }]);

    const sherlock = unitsOfSource(A.id).filter((u) => u.path.includes("神探夏洛克"));
    const d = await runTool(
      libraryMatchTool,
      {
        items: [
          { unit: item.unit, tmdbId: 13, type: "movie" },
          { unit: `unit:${A.id}:${sherlock[0].unitKey}`, ignore: true },
          { unit: `unit:${A.id}:${sherlock[1].unitKey}`, reidentify: true },
          { unit: "不是单元引用", ignore: true },
          { unit: item.unit, tmdbId: 13 },
          { unit: item.unit, tmdbId: 424242, type: "movie" },
        ],
      },
      runner,
    );
    assert.deepEqual(
      d.results.map((r: { status: string }) => r.status),
      ["matched", "ignored", "requeued", "failed", "failed", "failed"],
    );
    assert.equal(d.results[0].work, "movie:13");
    assert.equal(d.results[0].title, "阿甘正传");
    assert.match(d.results[5].error, /TMDB 上没有编号 424242/);
    assert.equal(d.matched, 1);
    assert.equal(d.failed, 3);
    const fixed = getUnit(A.id, gump.unitKey)!;
    assert.equal(fixed.status, "manual");
    assert.deepEqual(fixed.genres, [35, 18], "换匹配顺手存上类型");
    assert.equal(getUnit(A.id, sherlock[0].unitKey)!.status, "ignored");
    assert.equal(getUnit(A.id, sherlock[1].unitKey)!.status, "pending");
  } finally {
    setIdentifyDeps(null);
  }
});

test("library_sources：收藏的分享、死活、建索引、作品数；失效的附上里面认出来的作品；按状态筛", async () => {
  identifyPack();
  rebuildUnits(B.id);
  const bUnit = unitsOfSource(B.id)[0];
  saveIdentified(
    B.id,
    bUnit.unitKey,
    { status: "done", tmdbId: 13, mediaType: "movie", title: "阿甘正传", originalTitle: "Forrest Gump", enTitle: "", year: "1994", posterUrl: "", confidence: "high", reason: "", candidates: [], aka: "" },
    Math.floor(Date.now() / 1000),
  );
  const all = await runTool(librarySourcesTool, {});
  assert.equal(all.counts.all, 2);
  assert.equal(all.counts.expired, 1);
  const a = all.items.find((i: { id: string }) => i.id === A.id);
  assert.equal(a.title, "老K");
  assert.equal(a.shareStatus, "ok");
  assert.equal(a.index.status, "done");
  assert.ok(a.works.total >= 3 && a.works.identified >= 3);
  assert.equal(a.worksInside, undefined, "能用的分享不附作品");
  const expired = await runTool(librarySourcesTool, { status: "expired" });
  assert.deepEqual(expired.items.map((i: { id: string }) => i.id), [B.id]);
  assert.deepEqual(expired.items[0].worksInside, { total: 1, works: [{ work: "movie:13", title: "阿甘正传", year: "1994" }] });
  assert.match(expired.next, /library_work.*resource_search.*library_add/);
  assert.equal((await runTool(librarySourcesTool, { status: "indexing" })).items.length, 0);
});

test("library_works：片单逐个查；按类型、地区筛（认不出的报错）；条目带类型、地区的中文名", async () => {
  identifyPack();
  for (const u of unitsOfSource(A.id)) {
    if (u.path.includes("阿甘正传")) saveDetails(A.id, u.unitKey, { genres: [35, 18], countries: ["US"], originalLanguage: "en" });
    if (u.path.includes("神探夏洛克")) saveDetails(A.id, u.unitKey, { genres: [80, 18, 9648], countries: ["GB"], originalLanguage: "en" });
  }
  const list = await runTool(libraryWorksTool, { titles: ["阿甘正传 1994", "sherlock", "不存在的片"] });
  assert.deepEqual(
    list.lookup.map((r: { query: string; found: boolean; work?: string }) => [r.query, r.found, r.work ?? null]),
    [
      ["阿甘正传 1994", true, "movie:13"],
      ["sherlock", true, "tv:19885"],
      ["不存在的片", false, null],
    ],
  );
  assert.equal(list.found, 2);
  assert.equal(list.missing, 1);

  const crime = await runTool(libraryWorksTool, { genre: "犯罪" });
  assert.deepEqual(crime.items.map((i: { work: string }) => i.work), ["tv:19885"]);
  assert.deepEqual(crime.items[0].genres, ["犯罪", "剧情", "悬疑"]);
  assert.deepEqual(crime.items[0].countries, ["英国"]);
  assert.deepEqual((await runTool(libraryWorksTool, { country: "美国", view: "movie" })).items.map((i: { work: string }) => i.work), ["movie:13"]);
  assert.deepEqual((await runTool(libraryWorksTool, { genre: "剧情", country: "英剧" })).items.map((i: { work: string }) => i.work), ["tv:19885"]);
  assert.equal((await call(libraryWorksTool, { genre: "不存在的类型" })).ok, false);
  assert.equal((await call(libraryWorksTool, { country: "火星" })).ok, false);
});


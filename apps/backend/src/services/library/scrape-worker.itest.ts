/**
 * 影库刮削队列：TMDB 换成桩，验证重试策略和队列计数。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/library/scrape-worker.itest.ts
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { MediaLibraryEntry } from "@openstrm/shared";
import { patchAppSettings } from "../../db/repositories/settings.js";
import { getAll, getById, insert, remove } from "../../db/repositories/media-library.js";
import {
  __test_whenIdle,
  enqueue,
  setScrapeWorkerDeps,
  status,
} from "./scrape-worker.js";
import type { TmdbSearchResult } from "../tmdb.js";

const hit: TmdbSearchResult = {
  id: 42,
  mediaType: "tv",
  title: "庆余年",
  originalTitle: "Joy of Life",
  year: "2019",
  posterUrl: "https://img/p.jpg",
  overview: "简介",
};

/** 造一个 axios 形状的错误：isAxiosError 是 axios.isAxiosError 唯一认的标记 */
function axiosError(status?: number, retryAfter?: string): Error {
  const err = new Error(status ? `Request failed with status code ${status}` : "connect ETIMEDOUT") as Error & {
    isAxiosError: boolean;
    response?: { status: number; headers: Record<string, string> };
  };
  err.isAxiosError = true;
  if (status !== undefined) {
    err.response = { status, headers: retryAfter ? { "retry-after": retryAfter } : {} };
  }
  return err;
}

const entry = (id: string, rawName: string): MediaLibraryEntry => ({
  id,
  shareUrl: `https://115.com/s/${id}`,
  shareCode: id,
  receiveCode: "0000",
  sharePath: "",
  shareRootCid: "0",
  rawName,
  title: rawName,
  fileCount: 1,
  coverUrl: "",
  tags: [],
  notes: "",
  mediaType: "unknown",
  tmdbId: null,
  year: "",
  overview: "",
  scrapeStatus: "pending",
  createdAt: 0,
  updatedAt: 0,
});

/** 桩按顺序照 script 回；抛完的用 hit 兜底。calls 记下每次问的是哪个接口 */
let script: Array<Error | TmdbSearchResult[]> = [];
const calls: string[] = [];

const scripted = (which: string) => async (): Promise<TmdbSearchResult[]> => {
  const step = script[calls.length];
  calls.push(which);
  if (step instanceof Error) throw step;
  return step ?? [hit];
};

beforeEach(() => {
  for (const e of getAll()) remove(e.id);
  patchAppSettings({ tmdb: { apiKey: "k", language: "zh-CN" } });
  script = [];
  calls.length = 0;
  setScrapeWorkerDeps({
    searchMulti: scripted("multi"),
    searchTv: scripted("tv"),
    searchMovie: scripted("movie"),
    throttle: async () => {},
    // 测试里不真等退避
    retryDelayMs: () => 1,
  });
});

after(() => {
  setScrapeWorkerDeps(null);
});

test("429 之后再试就成了：条目照常 done，不留失败记录", async () => {
  insert(entry("a1", "庆余年 S01"));
  script = [axiosError(429, "0.001"), [hit]];
  enqueue(["a1"]);
  await __test_whenIdle();
  const got = getById("a1")!;
  assert.equal(got.scrapeStatus, "done");
  assert.equal(got.tmdbId, 42);
  assert.equal(got.notes, "", "重试成功就不该留下失败的说明");
  assert.equal(calls.length, 2, "该重试了一次");
});

test("一直 5xx：重试用光才记 failed，原因写进条目", async () => {
  insert(entry("a2", "庆余年 S01"));
  script = [axiosError(503), axiosError(503), axiosError(503), axiosError(503)];
  enqueue(["a2"]);
  await __test_whenIdle();
  const got = getById("a2")!;
  assert.equal(got.scrapeStatus, "failed");
  assert.match(got.notes, /TMDB 请求失败：.*503/);
  assert.equal(calls.length, 3, "第一次 + 两次重试");
});

test("401 是 key 不对：一次就记 failed，不浪费配额", async () => {
  insert(entry("a3", "庆余年 S01"));
  script = [axiosError(401)];
  enqueue(["a3"]);
  await __test_whenIdle();
  assert.equal(getById("a3")!.scrapeStatus, "failed");
  assert.equal(calls.length, 1, "永久失败不该重试");
});

test("连不上（没有响应）也算瞬时，值得再试", async () => {
  insert(entry("a4", "庆余年 S01"));
  script = [axiosError(), [hit]];
  enqueue(["a4"]);
  await __test_whenIdle();
  assert.equal(getById("a4")!.scrapeStatus, "done");
  assert.equal(calls.length, 2);
});

test("TMDB 说没有这部：记 failed，但不当成请求失败去重试", async () => {
  insert(entry("a5", "查无此片"));
  script = [[], [], []];
  enqueue(["a5"]);
  await __test_whenIdle();
  const got = getById("a5")!;
  assert.equal(got.scrapeStatus, "failed");
  assert.match(got.notes, /TMDB 无匹配/);
});

test("一条炸了不影响后面的；还在排队的重复入队只算一条", async () => {
  insert(entry("b1", "庆余年 S01"));
  insert(entry("b2", "庆余年 S02"));
  script = [axiosError(401), [hit]];
  // b1 立刻开跑，b2 排队；第二个 b2 还在队里，不再排一次
  enqueue(["b1", "b2", "b2"]);
  assert.deepEqual(status(), { queued: 1, active: 1 });
  await __test_whenIdle();
  assert.equal(getById("b1")!.scrapeStatus, "failed");
  assert.equal(getById("b2")!.scrapeStatus, "done");
  assert.deepEqual(status(), { queued: 0, active: 0 });
});

test("没配 TMDB key 的条目直接算刮完，不去问", async () => {
  patchAppSettings({ tmdb: { apiKey: "  " } });
  insert(entry("c1", "庆余年 S01"));
  enqueue(["c1"]);
  await __test_whenIdle();
  assert.equal(getById("c1")!.scrapeStatus, "done");
  assert.equal(calls.length, 0);
});

test("重试只重发失败的那一次，不把已经问成功的再问一遍", async () => {
  insert(entry("r1", "庆余年 S01"));
  // 剧集要先问 searchTv（成功但没结果），再问 searchMulti；让 multi 撞一次 429
  script = [[], axiosError(429, "0.001"), [hit]];
  enqueue(["r1"]);
  await __test_whenIdle();
  assert.equal(getById("r1")!.scrapeStatus, "done");
  assert.deepEqual(calls, ["tv", "multi", "multi"], "重试把 searchTv 也重来一遍的话，正好在人家限速时加倍地打");
});

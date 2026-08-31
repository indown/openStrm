/**
 * Emby 入库通知：/Items 查询和 Telegram 都换成桩，直接驱动 tickEmbyNew 验证游标与聚合。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/emby/library-new.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AppSettings } from "@openstrm/shared";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import type { NotifyEvent } from "../telegram/notify.js";
import {
  __test_resetEmbyNew,
  getEmbyNewWatcherStatus,
  nudgeEmbyNewWatch,
  setEmbyNewDeps,
  startEmbyNewWatcher,
  stopEmbyNewWatcher,
  tickEmbyNew,
  type EmbyNewItem,
} from "./library-new.js";

let baseline: AppSettings;
/** 桩 Emby：null = 未配置 */
let page: EmbyNewItem[] | null = [];
let fetchCalls = 0;
let notified: NotifyEvent[] = [];

const T0 = 1_800_000_000_000;
const ep = (over: Partial<EmbyNewItem>): EmbyNewItem => ({
  id: `${over.seriesName ?? "剧"}-${over.episode ?? 0}`,
  type: "Episode",
  name: `第 ${over.episode ?? 0} 集`,
  seriesName: "怪奇物语",
  season: 5,
  at: T0,
  ...over,
});
const movie = (over: Partial<EmbyNewItem>): EmbyNewItem => ({
  id: "m1", type: "Movie", name: "沙丘 2", year: 2024, at: T0, ...over,
});

before(() => {
  baseline = readAppSettings();
  setEmbyNewDeps({
    fetch: async () => {
      fetchCalls += 1;
      return page ? [...page] : null;
    },
    notify: async (ev) => {
      notified.push(ev);
    },
  });
});

beforeEach(async () => {
  await __test_resetEmbyNew();
  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100" } });
  page = [];
  fetchCalls = 0;
  notified = [];
});

after(async () => {
  await __test_resetEmbyNew();
  setEmbyNewDeps(null);
  replaceAppSettings(baseline);
});

test("开关关着：连 Emby 都不问", async () => {
  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100", notify: { embyNew: false } } });
  await tickEmbyNew();
  assert.equal(fetchCalls, 0);
});

test("Emby 未配置（fetch 回 null）：不动游标；配置好后首轮只定位、不补报存量", async () => {
  page = null;
  await tickEmbyNew();
  assert.equal(notified.length, 0);

  page = [ep({ episode: 1, at: T0 }), ep({ episode: 2, at: T0 - 1000 })];
  await tickEmbyNew();
  assert.equal(notified.length, 0, "首轮只定位游标");
  await tickEmbyNew();
  assert.equal(notified.length, 0, "没有新条目就不响");
});

test("新集按剧+季聚合、电影单列；游标推进后不重复报", async () => {
  page = [ep({ episode: 4, at: T0 })];
  await tickEmbyNew();

  page = [
    movie({ at: T0 + 3000 }),
    ep({ episode: 7, at: T0 + 2000 }),
    ep({ episode: 6, at: T0 + 2000 }),
    ep({ episode: 5, at: T0 + 1000 }),
    ...page,
  ];
  await tickEmbyNew();
  assert.equal(notified.length, 1);
  const evt = notified[0] as Extract<NotifyEvent, { type: "emby-new" }>;
  assert.equal(evt.type, "emby-new");
  assert.equal(evt.total, 4);
  assert.deepEqual(evt.groups, [
    { kind: "movie", name: "沙丘 2", year: 2024, episodes: [], count: 1 },
    { kind: "tv", name: "怪奇物语", season: 5, episodes: [5, 6, 7], count: 3 },
  ]);

  await tickEmbyNew();
  assert.equal(notified.length, 1, "游标已推进，不重复报");
});

test("同一毫秒多条：靠 id 集合补漏，不重报", async () => {
  page = [ep({ episode: 1, at: T0 })];
  await tickEmbyNew();
  // 同一毫秒又出现一条新的（同批入库共享 DateCreated）
  page = [ep({ episode: 2, at: T0 }), ep({ episode: 1, at: T0 })];
  await tickEmbyNew();
  assert.equal(notified.length, 1);
  assert.equal((notified[0] as Extract<NotifyEvent, { type: "emby-new" }>).total, 1);
  await tickEmbyNew();
  assert.equal(notified.length, 1);
});

test("一轮新增太多：只报总数，不逐条列", async () => {
  page = [ep({ episode: 1, at: T0 })];
  await tickEmbyNew();
  page = [
    ...Array.from({ length: 35 }, (_, i) => ep({ episode: i + 2, at: T0 + 1000 + i })),
    ...page,
  ];
  await tickEmbyNew();
  const evt = notified[0] as Extract<NotifyEvent, { type: "emby-new" }>;
  assert.equal(evt.total, 35);
  assert.deepEqual(evt.groups, []);
});

test("坏时间戳和缺 id 的条目直接丢弃", async () => {
  page = [ep({ episode: 1, at: T0 })];
  await tickEmbyNew();
  page = [ep({ episode: 2, at: Number.NaN }), ep({ id: "", episode: 3, at: T0 + 1000 }), ...page];
  await tickEmbyNew();
  assert.equal(notified.length, 0);
});

test("循环启停与加急：没起循环时 nudge 是空操作", async () => {
  nudgeEmbyNewWatch();
  assert.equal(getEmbyNewWatcherStatus().running, false);
  startEmbyNewWatcher();
  assert.equal(getEmbyNewWatcherStatus().running, true);
  await stopEmbyNewWatcher();
  assert.equal(getEmbyNewWatcherStatus().running, false);
});

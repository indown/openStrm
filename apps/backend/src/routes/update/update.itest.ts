/**
 * 检查更新的闭环：接口形状、默认不联网、手动检查与节流、失败时保留上次结果、预发布规则、Telegram 只推一次。
 * GitHub 换成注入的假 fetcher，一个真请求都不发。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/update/update.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppSettings, UpdateStatus } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import updateRoute from "./index.js";
import settingsRoute from "../settings/index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { KEY } from "../../db/keys.js";
import { writeKv } from "../../db/repositories/life.js";
import { patchAppSettings, readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { setNotifySender } from "../../services/telegram/notify.js";
import { checkForUpdates, EMPTY_STATE, readState, setUpdateDeps } from "../../services/update/service.js";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: AppSettings;

/** 假的发布列表；calls 记「真去问了几次」 */
let releases: Array<Record<string, unknown>> = [];
let calls: Array<{ includePrerelease: boolean }> = [];
let fail: Error | null = null;
let notified: string[] = [];
let clock = 1_000_000;
/** 当前跑的版本；仓库自己的版本号在 rc 期间是 `x.y.z-rc.n`，用例不能跟着它走 */
const RELEASE = "2.7.0";
let current = RELEASE;

const rel = (tag: string, opts: { prerelease?: boolean; draft?: boolean; body?: string } = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/indown/openStrm/releases/tag/${tag}`,
  published_at: "2026-09-16T10:00:00Z",
  prerelease: opts.prerelease ?? tag.includes("-"),
  draft: opts.draft ?? false,
  body: opts.body ?? `${tag} 的更新说明`,
});

const json = async <T,>(method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>, expect = 200): Promise<T> => {
  const res = await app.inject({ method, url, headers: auth, ...(payload !== undefined ? { payload } : {}) });
  assert.equal(res.statusCode, expect, `${method} ${url} → ${res.statusCode} ${res.body}`);
  return res.json() as T;
};

before(async () => {
  baseline = readAppSettings();
  await writeAuthPassword("update-itest-pw");
  setUpdateDeps({
    fetchReleases: async (includePrerelease) => {
      calls.push({ includePrerelease });
      if (fail) throw fail;
      return releases;
    },
    now: () => clock,
    current: () => current,
  });
  setNotifySender(async (_chatId, text) => {
    notified.push(text);
  });
  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(updateRoute);
  await app.register(settingsRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  setUpdateDeps(null);
  setNotifySender(null);
  replaceAppSettings(baseline);
  writeKv(KEY.updateState, EMPTY_STATE);
});

beforeEach(() => {
  releases = [];
  calls = [];
  fail = null;
  notified = [];
  clock = 1_000_000;
  current = RELEASE;
  writeKv(KEY.updateState, EMPTY_STATE);
  replaceAppSettings({ ...baseline, update: {}, telegram: {} });
});

test("默认不联网：GET 只回缓存，定时检查不查", async () => {
  const status = await json<UpdateStatus>("GET", "/api/update");
  assert.deepEqual([status.current, status.enabled, status.outdated, status.state.checkedAt], [RELEASE, false, false, 0]);
  await checkForUpdates();
  assert.deepEqual(calls, [], "自动检查关着就一个请求都不发");
});

test("手动检查：关着也能按，查到新版本写进缓存", async () => {
  releases = [rel("v99.0.0", { body: "全新大版本" })];
  const status = await json<UpdateStatus>("POST", "/api/update/check");
  assert.equal(calls.length, 1);
  assert.equal(status.outdated, true);
  assert.deepEqual(
    [status.state.ok, status.state.latest?.version, status.state.latest?.tag, status.state.latest?.notes],
    [true, "99.0.0", "v99.0.0", "全新大版本"],
  );
  assert.equal(status.state.latest?.publishedAt, Math.floor(Date.parse("2026-09-16T10:00:00Z") / 1000));
  // 页面读缓存不再联网
  await json<UpdateStatus>("GET", "/api/update");
  assert.equal(calls.length, 1);
});

test("比当前旧或一样的版本不算更新", async () => {
  releases = [rel(`v${RELEASE}`)];
  const status = await json<UpdateStatus>("POST", "/api/update/check");
  assert.equal(status.outdated, false);
  assert.equal(status.state.latest?.version, RELEASE);
});

test("手动检查有节流：5 分钟内再按只回缓存，429 带上还要等多久", async () => {
  releases = [rel("v99.0.0")];
  await json<UpdateStatus>("POST", "/api/update/check");
  const res = await app.inject({ method: "POST", url: "/api/update/check", headers: auth });
  assert.equal(res.statusCode, 429);
  assert.ok((res.json() as { retryAfter: number }).retryAfter > 0);
  assert.equal(calls.length, 1, "节流命中就不发请求");
  clock += 301;
  await json<UpdateStatus>("POST", "/api/update/check");
  assert.equal(calls.length, 2);
});

test("查失败：记下原因，上一次查到的版本留着", async () => {
  releases = [rel("v99.0.0")];
  await json<UpdateStatus>("POST", "/api/update/check");
  clock += 400;
  fail = new Error("connect ETIMEDOUT 140.82.114.6:443");
  const status = await json<UpdateStatus>("POST", "/api/update/check");
  assert.equal(status.state.ok, false);
  assert.match(status.state.error, /ETIMEDOUT/);
  assert.equal(status.state.latest?.version, "99.0.0", "上次的结果还在");
  assert.equal(status.outdated, true);
});

test("预发布：正式版只看正式版；跑 rc 或开了开关才看 rc", async () => {
  releases = [rel("v99.0.0"), rel("v99.1.0-rc.1")];
  await json<UpdateStatus>("POST", "/api/update/check");
  assert.equal(calls[0].includePrerelease, false, "当前是正式版：只问正式版");
  assert.equal(readState().latest?.version, "99.0.0");

  clock += 400;
  await json<{ message: string }>("PUT", "/api/settings", { update: { includePrerelease: true } });
  const status = await json<UpdateStatus>("POST", "/api/update/check");
  assert.equal(calls[1].includePrerelease, true);
  assert.equal(status.state.latest?.version, "99.1.0-rc.1", "开了开关就挑得出 rc");

  // 手上跑的就是 rc：开关没动过也跟 rc 比，不然会被告知「有新版 99.0.0」（比手上的还旧）
  replaceAppSettings({ ...baseline, update: {}, telegram: {} });
  writeKv(KEY.updateState, EMPTY_STATE);
  current = "99.1.0-rc.0";
  clock += 400;
  const onRc = await json<UpdateStatus>("POST", "/api/update/check");
  assert.equal(calls[2].includePrerelease, true, "跑 rc 就自动看 rc");
  assert.equal(onRc.state.latest?.version, "99.1.0-rc.1");
  assert.equal(onRc.outdated, true);
});

test("草稿和认不出的 tag 不当数", async () => {
  releases = [rel("nightly"), rel("v98.0.0", { draft: true }), rel("v97.0.0")];
  const status = await json<UpdateStatus>("POST", "/api/update/check");
  assert.equal(status.state.latest?.version, "97.0.0");
});

test("Telegram：默认不推；开了之后同一个版本只推一次", async () => {
  releases = [rel("v99.0.0")];
  await json<UpdateStatus>("POST", "/api/update/check");
  assert.deepEqual(notified, [], "通知默认关");

  patchAppSettings({ telegram: { botToken: "t", chatId: "c", notify: { update: true } } });
  writeKv(KEY.updateState, EMPTY_STATE);
  clock += 400;
  await json<UpdateStatus>("POST", "/api/update/check");
  assert.equal(notified.length, 1);
  assert.match(notified[0], /99\.0\.0/);

  clock += 400;
  await json<UpdateStatus>("POST", "/api/update/check");
  assert.equal(notified.length, 1, "同一个版本不再推");

  releases = [rel("v99.1.0")];
  clock += 400;
  await json<UpdateStatus>("POST", "/api/update/check");
  assert.equal(notified.length, 2, "换了版本再推一次");
});

test("开了自动检查之后定时那条路才真的查", async () => {
  releases = [rel("v99.0.0")];
  await json<{ message: string }>("PUT", "/api/settings", { update: { enabled: true } });
  await checkForUpdates();
  assert.equal(calls.length, 1);
  assert.equal((await json<UpdateStatus>("GET", "/api/update")).enabled, true);
});

test("要登录", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/update" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/update/check" })).statusCode, 401);
});

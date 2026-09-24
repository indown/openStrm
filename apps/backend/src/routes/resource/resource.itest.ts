/**
 * 资源搜索的接口：参数校验、没配置 400、PanSou 要登录时回 500 而不是 401（401 会把管理员踢回登录页）、
 * 令牌能调搜索和检测（要「查看」档和转存那组工具），调不了「检查连接」。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/resource/resource.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, AppSettings } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import resourceRoute from "./index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { createApiToken, deleteAllApiTokens } from "../../db/repositories/api-tokens.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { patchAppSettings, readAppSettings, replaceAppSettings, writeAppSetting } from "../../db/repositories/settings.js";
import { __test_resetAgentQuota } from "../../services/agent/rate-limit.js";
import { __test_clearPansouTokens } from "../../services/pansou/client.js";
import { __test_clearPansouCaches } from "../../services/pansou/search.js";
import { FakePansou, SAMPLE } from "../../test/fake-pansou.js";

const fake = new FakePansou();
let app: FastifyInstance;
let session: Record<string, string>;
let baseline: { settings: AppSettings; accounts: AccountInfo[] };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

before(async () => {
  await fake.start();
  baseline = { settings: readAppSettings(), accounts: listAccounts() };
  patchAppSettings({ agent: { enabled: true } });
  await writeAuthPassword("resource-itest-pw");
  replaceAccounts([{ accountType: "quark", name: "q", cookie: "c" }]);

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(resourceRoute);
  await app.ready();
  session = bearer(await app.signJwt({ username: DEFAULT_AUTH.username }));
});

after(async () => {
  await app.close();
  await fake.stop();
  deleteAllApiTokens();
  __test_resetAgentQuota();
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
});

beforeEach(() => {
  fake.reset();
  __test_clearPansouTokens();
  __test_clearPansouCaches();
  writeAppSetting("pansou", { baseUrl: fake.url });
});

const post = (url: string, payload: unknown, headers = session) => app.inject({ method: "POST", url, headers, payload: payload as Record<string, unknown> });

test("搜索：回归一化后的结果；参数不对 400", async () => {
  fake.onSearch = () => ({ quark: [SAMPLE.quarkPwd], baidu: [SAMPLE.baidu] });
  const res = await post("/api/resource/search", { keyword: "沙丘2", phase: "more" });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.keyword, "沙丘2");
  assert.deepEqual(body.counts, { quark: 1, other: 1 });
  assert.equal(body.items[0].url, "https://pan.quark.cn/s/157e84553650?pwd=ab12");
  assert.equal(body.items[0].action, "share");

  assert.equal((await post("/api/resource/search", { keyword: "  " })).statusCode, 400);
  assert.equal((await post("/api/resource/search", { keyword: "长".repeat(101) })).statusCode, 400);
  assert.equal((await post("/api/resource/search", { keyword: "k", phase: "later" })).statusCode, 400);

  // 不给 phase（自建的 agent 走 REST）：一次全量，不只搜 TG、不预热
  const before = fake.searches().length;
  const once = await post("/api/resource/search", { keyword: "沙丘2" });
  assert.equal(once.statusCode, 200, once.body);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(
    fake.searches().slice(before).map((q) => q.body.src),
    ["all"],
  );
});

test("没配置：400 带 PANSOU_NOT_CONFIGURED；PanSou 要登录：回 500 不回 401", async () => {
  writeAppSetting("pansou", { baseUrl: "" });
  const off = await post("/api/resource/search", { keyword: "k" });
  assert.equal(off.statusCode, 400);
  assert.equal(off.json().code, "PANSOU_NOT_CONFIGURED");

  writeAppSetting("pansou", { baseUrl: fake.url });
  fake.users = { admin: "pw" };
  const locked = await post("/api/resource/search", { keyword: "k", phase: "more" });
  assert.equal(locked.statusCode, 500);
  assert.equal(locked.json().code, "PANSOU_AUTH");
  assert.equal(locked.json().upstreamStatus, 401);

  fake.users = null;
  fake.onSearch = () => ({ status: 429, raw: "slow down" });
  const rate = await post("/api/resource/search", { keyword: "k", phase: "more" });
  assert.equal(rate.statusCode, 429);
});

test("检测：一次最多 10 条；按 key 回", async () => {
  const res = await post("/api/resource/check", { urls: ["https://115.com/s/swabc123xyz?password=u796", "https://pan.baidu.com/s/1abc"] });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { supported: true, results: [{ key: "115:swabc123xyz", state: "ok", summary: "链接有效" }] });
  assert.equal((await post("/api/resource/check", { urls: [] })).statusCode, 400);
  assert.equal((await post("/api/resource/check", { urls: Array.from({ length: 11 }, (_, i) => `https://115.com/s/sw${i}`) })).statusCode, 400);
});

test("检查连接：用表单里的值；地址不是 http(s) 的 400", async () => {
  fake.health = { plugins: ["a"], channels: ["b", "c"] };
  const res = await post("/api/resource/status", { baseUrl: fake.url });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { configured: true, ok: true, authEnabled: false, plugins: 1, channels: 2 });
  assert.equal((await post("/api/resource/status", { baseUrl: "ftp://x" })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/resource/status", headers: session })).statusCode, 200, "不带 body 就用已存的");
});

test("令牌：「查看」档 + 转存那组能搜能检测；没勾转存那组 403；检查连接永远不对令牌开放", async () => {
  fake.onSearch = () => ({ quark: [SAMPLE.quark] });
  const { token } = createApiToken({ name: "搜资源", scopes: ["read"], toolsets: ["transfer"], expiresAt: null });
  const ok = await post("/api/resource/search", { keyword: "k", phase: "more" }, bearer(token));
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await post("/api/resource/check", { urls: ["https://pan.quark.cn/s/4efe86519372"] }, bearer(token))).statusCode, 200);

  const status = await post("/api/resource/status", { baseUrl: "http://169.254.169.254" }, bearer(token));
  assert.equal(status.statusCode, 403);
  assert.equal(status.json().code, "TOKEN_NOT_ALLOWED");

  const { token: syncOnly } = createApiToken({ name: "只管同步", scopes: ["read"], toolsets: ["sync"], expiresAt: null });
  const denied = await post("/api/resource/search", { keyword: "k" }, bearer(syncOnly));
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, "TOOLSET_NOT_ALLOWED");
});

test("搜索带 titleEn：原名交给 PanSou（ext.title_en）；太长的 400；结果带标签和屏蔽词藏掉的条数", async () => {
  fake.onSearch = () => ({ quark: [SAMPLE.quarkPwd, SAMPLE.quark] });
  writeAppSetting("pansou", { baseUrl: fake.url, blockWords: ["合集"] });
  const res = await post("/api/resource/search", { keyword: "沙丘2", phase: "more", titleEn: "Dune: Part Two" });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(fake.searches()[0].body.ext, { title_en: "Dune: Part Two" });
  const body = res.json();
  assert.equal(body.blocked, 1);
  assert.deepEqual(body.counts, { quark: 1 });
  assert.equal((await post("/api/resource/search", { keyword: "k", titleEn: "x".repeat(201) })).statusCode, 400);
});

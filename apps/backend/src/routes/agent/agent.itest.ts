/**
 * 令牌管理（只认会话）和令牌调 REST（白名单 + 档位 + 工具集）：
 *   - 建令牌要当前密码；只回一次明文，列表里只有前缀；「查看」总是带上；「全部工具集」存成明确的列表；重名 409；
 *     改档位；撤销、全部撤销；改密码时可以一并撤销
 *   - 令牌碰不了令牌管理、设置、账号、备份（没声明档位的路由一律 403）
 *   - 档位不够 403；/api/share 按动作放行（download_url 不给）；工具集没勾的那组接口 403
 *   - 开关关着、过期、默认口令都挡住；和 /mcp 同一个限流桶；令牌调 REST 也进调用记录（带参数摘要和 IP）
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/agent/agent.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AgentToken, AgentTokenCreated, AppSettings } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import { cronPlugin } from "../../plugins/cron.js";
import agentRoute from "./index.js";
import accountRoute from "../account/index.js";
import settingsRoute from "../settings/index.js";
import taskRoute from "../task/index.js";
import taskStartRoute from "../task/start.js";
import shareRoute from "../share/index.js";
import backupRoute from "../system/backup.js";
import passwordRoute from "../auth/password.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { createApiToken, deleteAllApiTokens } from "../../db/repositories/api-tokens.js";
import { listAgentCalls } from "../../db/repositories/agent-audit.js";
import { patchAppSettings, readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { __test_resetAgentQuota, takeAgentQuota } from "../../services/agent/rate-limit.js";

let app: FastifyInstance;
let session: Record<string, string>;
let baseline: AppSettings;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const PASSWORD = "agent-itest-pw";

before(async () => {
  baseline = readAppSettings();
  patchAppSettings({ agent: { enabled: true } });
  await writeAuthPassword(PASSWORD);

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(cronPlugin);
  for (const route of [agentRoute, accountRoute, settingsRoute, taskRoute, taskStartRoute, shareRoute, backupRoute, passwordRoute]) await app.register(route);
  await app.ready();
  session = bearer(await app.signJwt({ username: DEFAULT_AUTH.username }));
});

after(async () => {
  await app.close();
  deleteAllApiTokens();
  __test_resetAgentQuota();
  replaceAppSettings(baseline);
  await writeAuthPassword(DEFAULT_AUTH.password);
});

async function create(body: Record<string, unknown>): Promise<AgentTokenCreated> {
  const res = await app.inject({ method: "POST", url: "/api/agent/tokens", headers: session, payload: { currentPassword: PASSWORD, ...body } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

test("建令牌：要当前密码（错了回 400 不回 401）；明文只回一次、列表里只有前缀；「查看」总是带上；全部工具集存成列表；重名 409", async () => {
  for (const currentPassword of [undefined, "wrong"]) {
    const res = await app.inject({ method: "POST", url: "/api/agent/tokens", headers: session, payload: { name: "没密码", scopes: ["read"], currentPassword } });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().code, "WRONG_PASSWORD");
  }

  const created = await create({ name: "Claude Code", scopes: ["run", "write"] });
  assert.match(created.token, /^ostk_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(created.info.scopes, ["read", "run", "write"]);
  // 「全部」记下的是眼下的全部组：以后加的组不会自动给这个令牌
  assert.deepEqual(created.info.toolsets, ["sync", "transfer"]);
  assert.ok(created.token.startsWith(created.info.prefix));

  const list = await app.inject({ method: "GET", url: "/api/agent/tokens", headers: session });
  assert.equal(list.statusCode, 200);
  assert.ok(!list.body.includes(created.token), "列表里不能有明文");
  assert.ok(!list.body.includes("token_hash") && !list.body.includes("tokenHash"));

  const dup = await app.inject({ method: "POST", url: "/api/agent/tokens", headers: session, payload: { name: "Claude Code", scopes: ["read"], currentPassword: PASSWORD } });
  assert.equal(dup.statusCode, 409);

  const info = await app.inject({ method: "GET", url: "/api/agent/info", headers: session });
  assert.equal(info.json().mcpPath, "/mcp");
  assert.ok(info.json().tools.some((t: { name: string }) => t.name === "share_save"));
});

test("改档位和工具集；撤销；全部撤销", async () => {
  const { info } = await create({ name: "要改的", scopes: ["read"], toolsets: ["sync"], expiresInDays: 30 });
  assert.ok(info.expiresAt! > Math.floor(Date.now() / 1000));
  const patched = await app.inject({ method: "PATCH", url: `/api/agent/tokens/${info.id}`, headers: session, payload: { scopes: ["write"], toolsets: null } });
  assert.equal(patched.statusCode, 200, patched.body);
  const p: AgentToken = patched.json();
  assert.deepEqual(p.scopes, ["read", "write"]);
  assert.deepEqual(p.toolsets, ["sync", "transfer"]);

  assert.equal((await app.inject({ method: "DELETE", url: `/api/agent/tokens/${info.id}`, headers: session })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/agent/tokens/${info.id}`, headers: session })).statusCode, 404);

  await create({ name: "一", scopes: ["read"] });
  const all = await app.inject({ method: "DELETE", url: "/api/agent/tokens", headers: session });
  assert.ok(all.json().deleted >= 1);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/agent/tokens", headers: session })).json(), []);
});

test("令牌碰不了令牌管理、设置、账号、备份", async () => {
  const { token } = createApiToken({ name: "越权", scopes: ["read", "run", "write", "danger"], toolsets: ["sync", "transfer"], expiresAt: null });
  for (const [method, url] of [
    ["GET", "/api/agent/tokens"],
    ["POST", "/api/agent/tokens"],
    ["GET", "/api/settings"],
    ["PUT", "/api/settings"],
    ["GET", "/api/account"],
    ["GET", "/api/system/backup"],
  ] as const) {
    const res = await app.inject({ method, url, headers: bearer(token), payload: method === "GET" ? undefined : {} });
    assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`);
    assert.equal(res.json().code, "TOKEN_NOT_ALLOWED");
  }
});

test("档位：只读能列任务、不能开跑；转存分享另要 write", async () => {
  const { token } = createApiToken({ name: "只读 REST", scopes: ["read"], toolsets: ["sync", "transfer"], expiresAt: null });
  assert.equal((await app.inject({ method: "GET", url: "/api/task", headers: bearer(token) })).statusCode, 200);

  const start = await app.inject({ method: "POST", url: "/api/startTask", headers: bearer(token), payload: { id: "nope" } });
  assert.equal(start.statusCode, 403);
  assert.equal(start.json().code, "INSUFFICIENT_SCOPE");

  const receive = await app.inject({
    method: "POST",
    url: "/api/share",
    headers: bearer(token),
    payload: { action: "receive", url: "https://115.com/s/abc", taskId: "x", items: [{ id: "1", name: "a", isDir: false }] },
  });
  assert.equal(receive.statusCode, 403);
  assert.equal(receive.json().code, "INSUFFICIENT_SCOPE");

  const { token: runner } = createApiToken({ name: "能跑", scopes: ["read", "run"], toolsets: ["sync", "transfer"], expiresAt: null });
  const ran = await app.inject({ method: "POST", url: "/api/startTask", headers: bearer(runner), payload: { id: "nope" } });
  assert.equal(ran.statusCode, 404, "过了档位检查，任务不存在才 404");

  const calls = listAgentCalls({ limit: 200 });
  assert.ok(calls.some((c) => c.tokenName === "只读 REST" && c.tool === "GET /api/task" && c.ok));
  assert.ok(calls.some((c) => c.tokenName === "只读 REST" && c.tool === "POST /api/startTask" && !c.ok));
  // 参数摘要：同一个接口按 action 干不同的事，得记下来；链接里的提取码抹掉；带 IP
  const recv = calls.find((c) => c.tokenName === "只读 REST" && c.tool === "POST /api/share")!;
  assert.match(recv.args, /"action":"receive"/);
  assert.ok(recv.ip);
});

test("/api/share 按动作放行：download_url 不对令牌开放；只勾了「同步」的令牌碰不了转存那一组的接口", async () => {
  const { token } = createApiToken({ name: "看分享", scopes: ["read", "run", "write"], toolsets: ["sync", "transfer"], expiresAt: null });
  const direct = await app.inject({ method: "POST", url: "/api/share", headers: bearer(token), payload: { action: "download_url", url: "https://115.com/s/abc?password=1234", fileId: "1" } });
  assert.equal(direct.statusCode, 403, direct.body);
  assert.equal(direct.json().code, "TOKEN_NOT_ALLOWED");
  const row = listAgentCalls({ limit: 50 }).find((c) => c.tokenName === "看分享")!;
  assert.match(row.args, /download_url/);
  assert.ok(!row.args.includes("1234"), row.args);

  const { token: syncOnly } = createApiToken({ name: "只管同步", scopes: ["read", "run", "write"], toolsets: ["sync"], expiresAt: null });
  const blocked = await app.inject({ method: "POST", url: "/api/share", headers: bearer(syncOnly), payload: { action: "list", url: "https://115.com/s/abc" } });
  assert.equal(blocked.statusCode, 403, blocked.body);
  assert.equal(blocked.json().code, "TOOLSET_NOT_ALLOWED");
  // 任务列表是基础接口，谁都能看
  assert.equal((await app.inject({ method: "GET", url: "/api/task", headers: bearer(syncOnly) })).statusCode, 200);
});

test("令牌调 REST 也扣配额：和 /mcp 同一个桶，掏空了回 429 带 retry-after（这一下不记调用记录）", async () => {
  const t = createApiToken({ name: "刷接口", scopes: ["read"], toolsets: ["sync", "transfer"], expiresAt: null });
  while (takeAgentQuota(t.info.id).ok) {
    /* 把桶掏空 */
  }
  const res = await app.inject({ method: "GET", url: "/api/task", headers: bearer(t.token) });
  assert.equal(res.statusCode, 429, res.body);
  assert.ok(Number(res.headers["retry-after"]) >= 1);
  assert.equal(res.json().code, "RATE_LIMITED");
  assert.ok(!listAgentCalls({ tokenId: t.info.id, limit: 10 }).length, "被限流挡下的不写库");
});

test("开关关着、过期、默认口令都挡住", async () => {
  const { token } = createApiToken({ name: "挡住", scopes: ["read"], toolsets: ["sync", "transfer"], expiresAt: null });
  patchAppSettings({ agent: { enabled: false } });
  try {
    const off = await app.inject({ method: "GET", url: "/api/task", headers: bearer(token) });
    assert.equal(off.statusCode, 403);
    assert.equal(off.json().code, "AGENT_DISABLED");
  } finally {
    patchAppSettings({ agent: { enabled: true } });
  }

  const { token: expired } = createApiToken({ name: "过期", scopes: ["read"], toolsets: ["sync", "transfer"], expiresAt: Math.floor(Date.now() / 1000) - 1 });
  assert.equal((await app.inject({ method: "GET", url: "/api/task", headers: bearer(expired) })).statusCode, 401);

  await writeAuthPassword(DEFAULT_AUTH.password);
  try {
    const guarded = await app.inject({ method: "GET", url: "/api/task", headers: bearer(token) });
    assert.equal(guarded.statusCode, 403);
    assert.equal(guarded.json().code, "PASSWORD_CHANGE_REQUIRED");
  } finally {
    await writeAuthPassword(PASSWORD);
  }
});

test("设置：管理界面地址要是 http(s) 地址", async () => {
  const fresh = bearer(await app.signJwt({ username: DEFAULT_AUTH.username }));
  const bad = await app.inject({ method: "PUT", url: "/api/settings", headers: fresh, payload: { agent: { enabled: true, uiBaseUrl: "nas:3000" } } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: "PUT", url: "/api/settings", headers: fresh, payload: { agent: { enabled: true, uiBaseUrl: "http://nas:3000" } } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(readAppSettings().agent?.uiBaseUrl, "http://nas:3000");
});

test("改密码：当前密码错了回 400（不回 401，免得前端当成会话失效）；可以一并撤销全部令牌", async () => {
  const fresh = bearer(await app.signJwt({ username: DEFAULT_AUTH.username }));
  createApiToken({ name: "改密码前的", scopes: ["read"], toolsets: ["sync", "transfer"], expiresAt: null });
  const wrong = await app.inject({ method: "POST", url: "/api/auth/password", headers: fresh, payload: { currentPassword: "nope", newPassword: "agent-itest-pw-2" } });
  assert.equal(wrong.statusCode, 400, wrong.body);
  assert.equal(wrong.json().code, "WRONG_PASSWORD");

  try {
    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: fresh,
      payload: { currentPassword: PASSWORD, newPassword: "agent-itest-pw-2", revokeAgentTokens: true },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.ok(changed.json().revokedAgentTokens >= 1);
    const again = bearer(await app.signJwt({ username: DEFAULT_AUTH.username }));
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/agent/tokens", headers: again })).json(), []);
  } finally {
    await writeAuthPassword(PASSWORD);
  }
});

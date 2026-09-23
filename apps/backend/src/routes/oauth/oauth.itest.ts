/**
 * 网页客户端走的 OAuth 闭环（设计见 .claude/plans/agent-access.md「OAuth」「测试与验收」「实施记录」）：
 *   - 两份元数据的字段（资源那边不列 danger / offline_access；CIMD 开了才声明）；/mcp 的 401 只在公网域名上指到元数据
 *   - 动态注册：none、回带 scope、多要的授权方式收窄、body 大小、按来源 / 全局限流、只存用得上的
 *   - 授权页 → 管理界面输入配对码 + 当前密码批准 → 轮询拿到授权码 → 换令牌 → 用令牌调 /mcp；给的档位按客户端要的收窄
 *   - 配对码对不上不批；授权码一次性、宽限期内原样重试、PKCE、redirect_uri、resource；回环地址出错直接跳回，别的给链接
 *   - 刷新轮换、宽限期内并发刷新拿同一对、之后重放整个作废、旧访问令牌到期前还认；撤销
 *   - 拒绝、全部拒绝、过期、丢了回应再取；预注册客户端（post / basic）；CIMD（开关、缓存、ChatGPT 的真文档）；授权页密码批准
 *   - 限流：每小时、每个来源同时在等的、全局在等的；Telegram（开关、发配对码才出批准按钮、通知限量）
 *   - 公网守卫（主机名各种写法）；设置（规范化）；改密码 / 全部断开连没走完的请求一起撤；公网地址改了之后的授权
 *   - 共用域名（这个域名也用来打开管理界面）：守卫不拦、授权页密码批准在前；密码批准只给授权码别人拿不到的回调；
 *     保存设置马上生效；连接自检（来源地址探针、两种模式各自的检查项、被 Access 挡住、带端口）；没设 TRUST_PROXY 的提示
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/oauth/oauth.itest.ts
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import cors from "@fastify/cors";
import type { AgentSelfCheckItem, AppSettings } from "@openstrm/shared";
import { eq } from "drizzle-orm";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import { corsDelegator } from "../../plugins/cors.js";
import { __test_resetUntrustedProxy, invalidatePublicHost, publicHostPlugin } from "../../plugins/public-host.js";
import { securityHeadersPlugin } from "../../plugins/security-headers.js";
import agentRoute from "../agent/index.js";
import mcpRoute from "../mcp/index.js";
import settingsRoute from "../settings/index.js";
import passwordRoute from "../auth/password.js";
import oauthMetadataRoute from "./metadata.js";
import oauthRegisterRoute from "./register.js";
import oauthAuthorizeRoute from "./authorize.js";
import oauthTokenRoute from "./token.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { db } from "../../db/client.js";
import { oauthClients, oauthGrants, oauthRequests, oauthUsedRefresh } from "../../db/schema.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listAgentCalls } from "../../db/repositories/agent-audit.js";
import { createApiToken, deleteAllApiTokens, listApiTokens } from "../../db/repositories/api-tokens.js";
import { deleteStaleOAuthClients, listOAuthGrants } from "../../db/repositories/oauth.js";
import { patchAppSettings, readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { __test_resetAgentQuota } from "../../services/agent/rate-limit.js";
import { loginThrottle } from "../../services/login-throttle.js";
import { trustProxyOption } from "../../lib/trust-proxy.js";
import { __test_resetPasswordGuard } from "../../services/password-check.js";
import { setCimdFetcher } from "../../services/oauth/cimd.js";
import { SOURCE_PROBE_HEADER } from "../../services/oauth/selfcheck.js";
import { __test_resetOAuthUnlocks, handleUpdate } from "../../services/telegram/commands.js";
import { setButtonSender } from "../../services/telegram/notify.js";
import type { BotLike, InlineKeyboard } from "../../services/telegram/bot.js";

const PUBLIC = "https://mcp.example.com";
const PUB = { host: "mcp.example.com" };
const RESOURCE = `${PUBLIC}/mcp`;
const PASSWORD = "oauth-itest-pw";
const CALLBACK = "https://client.example/callback";
const LOOPBACK = "http://127.0.0.1:43210/callback";
/** claude.ai 的回调：授权码发到这里别人拿不到，授权页上能用密码批准 */
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

let app: FastifyInstance;
let session: Record<string, string>;
let baseline: AppSettings;
const sent: Array<{ chatId: string; text: string; buttons: InlineKeyboard }> = [];

before(async () => {
  baseline = readAppSettings();
  patchAppSettings({ agent: { enabled: true, publicBaseUrl: PUBLIC } });
  await writeAuthPassword(PASSWORD);
  setButtonSender(async (chatId, text, buttons) => {
    sent.push({ chatId, text, buttons });
  });

  // 和生产一样按 TRUST_PROXY=true 认来源（反代在本机）：自检那几条模拟本机反代往 X-Forwarded-For 里追加来源
  app = Fastify({ trustProxy: trustProxyOption("true") });
  registerErrorHandling(app);
  await app.register(cors, { delegator: corsDelegator });
  await app.register(securityHeadersPlugin);
  await app.register(publicHostPlugin);
  await app.register(authPlugin);
  for (const route of [agentRoute, mcpRoute, settingsRoute, passwordRoute, oauthMetadataRoute, oauthRegisterRoute, oauthAuthorizeRoute, oauthTokenRoute]) {
    await app.register(route);
  }
  // 代替管理界面的静态页和别的 /api：不然「公网域名下 404」是因为路由本来就不存在，测不出守卫
  app.get("/*", async () => ({ stub: true }));
  await app.ready();
  session = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  setButtonSender(null);
  setCimdFetcher(null);
  resetOAuthTables();
  deleteAllApiTokens();
  __test_resetAgentQuota();
  invalidatePublicHost();
  __test_resetPasswordGuard();
  __test_resetUntrustedProxy();
  __test_resetOAuthUnlocks();
  loginThrottle.reset();
  replaceAppSettings(baseline);
  await writeAuthPassword(DEFAULT_AUTH.password);
});

function resetOAuthTables(): void {
  db.delete(oauthRequests).run();
  db.delete(oauthGrants).run();
  db.delete(oauthClients).run();
  db.delete(oauthUsedRefresh).run();
}

beforeEach(() => {
  resetOAuthTables();
  __test_resetAgentQuota();
  invalidatePublicHost();
  __test_resetPasswordGuard();
  __test_resetUntrustedProxy();
  __test_resetOAuthUnlocks();
  loginThrottle.reset();
  sent.length = 0;
  setCimdFetcher(null);
  patchAppSettings({ agent: { enabled: true, publicBaseUrl: PUBLIC, allowPasswordApproval: false, oauthCimd: false } });
});

const nowS = () => Math.floor(Date.now() / 1000);
const ascii = /^[\x20-\x7e]*$/;

/* ------------------------------- 小工具 ------------------------------- */

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(body: unknown, remoteAddress = "127.0.0.1") {
  return app.inject({ method: "POST", url: "/oauth/register", payload: body as object, remoteAddress });
}

async function registerClient(redirectUris = [CALLBACK], extra: Record<string, unknown> = {}): Promise<string> {
  const res = await register({ client_name: "测试客户端", redirect_uris: redirectUris, ...extra });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().client_id as string;
}

async function authorize(params: Record<string, string>, remoteAddress = "127.0.0.1"): Promise<LightMyRequestResponse> {
  return app.inject({ method: "GET", url: `/oauth/authorize?${new URLSearchParams(params)}`, headers: PUB, remoteAddress });
}

interface PageData {
  id: string;
  k: string;
  /** 页面上显示的配对码 */
  code: string;
}

/** 授权页里嵌着的请求 id、轮询密钥，和显示出来的配对码 */
function pageData(html: string): PageData {
  const m = /const d = (\{.*?\});/.exec(html);
  assert.ok(m, "授权页里没有轮询数据");
  const code = /<div class="code" id="code">([^<]+)<\/div>/.exec(html);
  assert.ok(code, "授权页里没有配对码");
  const d = JSON.parse(m[1]) as { id: string; k: string };
  return { id: d.id, k: d.k, code: code[1] };
}

async function poll(d: { id: string; k: string }) {
  const res = await app.inject({ method: "POST", url: "/oauth/authorize/status", headers: PUB, payload: { id: d.id, k: d.k } });
  return res.json() as { status: string; url?: string; auto?: boolean };
}

async function approve(d: PageData, opts: { scopes?: string[]; toolsets?: string[]; code?: string; password?: string } = {}) {
  return app.inject({
    method: "POST",
    url: `/api/agent/oauth/requests/${d.id}/approve`,
    headers: session,
    payload: {
      pairingCode: opts.code ?? d.code,
      scopes: opts.scopes ?? ["read", "run", "write"],
      currentPassword: opts.password ?? PASSWORD,
      ...(opts.toolsets ? { toolsets: opts.toolsets } : {}),
    },
  });
}

async function token(form: Record<string, string>, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded", ...PUB, ...headers },
    payload: new URLSearchParams(form).toString(),
  });
}

function authParams(clientId: string, extra: Record<string, string> = {}) {
  const { verifier, challenge } = pkce();
  return {
    verifier,
    params: { response_type: "code", client_id: clientId, redirect_uri: CALLBACK, state: "st-1", code_challenge: challenge, code_challenge_method: "S256", ...extra },
  };
}

/** 从授权页一路走到拿到授权码 */
async function authorizeAndApprove(opts: { clientId: string; scope?: string; approveScopes?: string[]; toolsets?: string[]; redirectUri?: string }) {
  const { verifier, params } = authParams(opts.clientId, {
    redirect_uri: opts.redirectUri ?? CALLBACK,
    scope: opts.scope ?? "read run write offline_access",
    resource: RESOURCE,
  });
  const page = await authorize(params);
  assert.equal(page.statusCode, 200, page.body);
  const d = pageData(page.body);
  const ok = await approve(d, { scopes: opts.approveScopes, toolsets: opts.toolsets });
  assert.equal(ok.statusCode, 200, ok.body);
  const r = await poll(d);
  assert.equal(r.status, "redirect", JSON.stringify(r));
  const url = new URL(r.url!);
  return { code: url.searchParams.get("code")!, url, verifier, d };
}

type Tokens = { access_token: string; refresh_token: string; scope: string; expires_in: number; token_type: string };

async function fullFlow(opts: { clientId?: string; scope?: string; approveScopes?: string[]; toolsets?: string[] } = {}) {
  const clientId = opts.clientId ?? (await registerClient());
  const { code, verifier } = await authorizeAndApprove({ clientId, scope: opts.scope, approveScopes: opts.approveScopes, toolsets: opts.toolsets });
  const res = await token({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
  assert.equal(res.statusCode, 200, res.body);
  return { clientId, code, verifier, tokens: res.json() as Tokens };
}

async function mcp(accessToken: string, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-06-18", ...PUB, ...headers },
    payload: JSON.stringify(body),
  });
  const text = res.body;
  const json = text.trim().startsWith("{") ? JSON.parse(text) : text.includes("data: ") ? JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) : null;
  return { res, json };
}

const toolNames = (json: { result: { tools: Array<{ name: string }> } }) => json.result.tools.map((x) => x.name);

async function oauthState() {
  return (await app.inject({ method: "GET", url: "/api/agent/oauth", headers: session })).json();
}

/* ------------------------------- 元数据与 401 ------------------------------- */

test("元数据：资源那边只列日常三档（不列 danger、offline_access）；授权服务器那边全列；CIMD 开了才声明；不挂 OIDC 发现地址", async () => {
  for (const url of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const prm = (await app.inject({ method: "GET", url, headers: PUB })).json();
    assert.equal(prm.resource, RESOURCE);
    assert.deepEqual(prm.authorization_servers, [PUBLIC]);
    assert.deepEqual(prm.scopes_supported, ["read", "run", "write"]);
  }
  const as = (await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server", headers: PUB })).json();
  assert.equal(as.issuer, PUBLIC);
  assert.equal(as.authorization_endpoint, `${PUBLIC}/oauth/authorize`);
  assert.equal(as.token_endpoint, `${PUBLIC}/oauth/token`);
  assert.equal(as.registration_endpoint, `${PUBLIC}/oauth/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.token_endpoint_auth_methods_supported[0], "none", "none 必须排第一");
  assert.equal(as.client_id_metadata_document_supported, undefined, "CIMD 默认不声明：声明了客户端就不会退回动态注册");
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.ok(as.scopes_supported.includes("offline_access") && as.scopes_supported.includes("danger"));
  assert.equal((await app.inject({ method: "GET", url: "/.well-known/openid-configuration", headers: PUB })).statusCode, 404);

  patchAppSettings({ agent: { enabled: true, publicBaseUrl: PUBLIC, oauthCimd: true } });
  assert.equal((await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server", headers: PUB })).json().client_id_metadata_document_supported, true);
});

test("没填公网地址或开关关着：OAuth 这些路径都是 404", async () => {
  patchAppSettings({ agent: { enabled: true, publicBaseUrl: "" } });
  assert.equal((await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" })).statusCode, 404);
  assert.equal((await register({ redirect_uris: [CALLBACK] })).statusCode, 404);
  patchAppSettings({ agent: { enabled: false, publicBaseUrl: PUBLIC } });
  invalidatePublicHost();
  assert.equal((await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource", headers: PUB })).statusCode, 404);
  assert.equal((await authorize({ client_id: "x" })).statusCode, 404);
});

test("/mcp：公网域名上不带令牌 401 指到元数据；局域网地址上只说要令牌；带了不认的令牌标 invalid_token", async () => {
  const bare = await app.inject({ method: "POST", url: "/mcp", headers: { ...PUB, "content-type": "application/json" }, payload: "{}" });
  assert.equal(bare.statusCode, 401);
  const challenge = String(bare.headers["www-authenticate"]);
  assert.match(challenge, new RegExp(`resource_metadata="${PUBLIC}/\\.well-known/oauth-protected-resource/mcp"`));
  assert.match(challenge, /scope="read run write"/);
  assert.doesNotMatch(challenge, /invalid_token/);

  const lan = await app.inject({ method: "POST", url: "/mcp", headers: { host: "nas.lan:3000", "content-type": "application/json" }, payload: "{}" });
  assert.equal(lan.statusCode, 401);
  assert.equal(lan.headers["www-authenticate"], 'Bearer realm="OpenStrm"', "局域网的客户端跟着公网元数据走会因为资源地址对不上而失败");

  const bad = await app.inject({ method: "POST", url: "/mcp", headers: { ...PUB, "content-type": "application/json", authorization: "Bearer osat_nope" }, payload: "{}" });
  assert.match(String(bad.headers["www-authenticate"]), /error="invalid_token"/);

  const withOrigin = await app.inject({ method: "POST", url: "/mcp", headers: { ...PUB, origin: "http://localhost:6274", "content-type": "application/json" }, payload: "{}" });
  assert.match(String(withOrigin.headers["access-control-expose-headers"]), /WWW-Authenticate/i, "浏览器里的客户端要读得到 401 的 WWW-Authenticate");
});

test("没登录的请求按来源限流：一下子最多 30 个，第 31 个回 429 带 retry-after（/mcp 的 401、token 端点都算）", async () => {
  const ip = "203.0.113.77";
  for (let i = 0; i < 20; i++) {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { ...PUB, "content-type": "application/json" }, payload: "{}", remoteAddress: ip });
    assert.equal(res.statusCode, 401);
  }
  for (let i = 0; i < 10; i++) {
    const res = await app.inject({ method: "POST", url: "/oauth/token", headers: { ...PUB, "content-type": "application/x-www-form-urlencoded" }, payload: "grant_type=refresh_token", remoteAddress: ip });
    assert.equal(res.statusCode, 400);
  }
  const over = await app.inject({ method: "POST", url: "/mcp", headers: { ...PUB, "content-type": "application/json" }, payload: "{}", remoteAddress: ip });
  assert.equal(over.statusCode, 429);
  assert.ok(Number(over.headers["retry-after"]) > 0);
  const overToken = await app.inject({ method: "POST", url: "/oauth/token", headers: { ...PUB, "content-type": "application/x-www-form-urlencoded" }, payload: "grant_type=refresh_token", remoteAddress: ip });
  assert.equal(overToken.statusCode, 429);
  assert.equal(overToken.json().error, "temporarily_unavailable");
  const other = await app.inject({ method: "POST", url: "/mcp", headers: { ...PUB, "content-type": "application/json" }, payload: "{}", remoteAddress: "203.0.113.78" });
  assert.equal(other.statusCode, 401, "别的来源不受影响");
});

/* ------------------------------- 动态注册 ------------------------------- */

test("动态注册：公开客户端（none）、回带默认 scope、多要的授权方式收窄；坏的回调、缺 authorization_code 拒；说明是 ASCII", async () => {
  const res = await register({ client_name: "Open WebUI", redirect_uris: ["http://192.168.1.5:8080/oauth/clients/mcp:openstrm/callback"], token_endpoint_auth_method: "client_secret_post" });
  assert.equal(res.statusCode, 201, res.body);
  const reg = res.json();
  assert.match(reg.client_id, /^oc_/);
  assert.equal(reg.token_endpoint_auth_method, "none", "要了 secret 也按公开客户端注册，回应里如实写");
  assert.equal(reg.scope, "read run write", "没要 scope 就回带默认的（不含 danger、offline_access）");
  assert.equal((await register({ redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/callback"], scope: "read" })).json().scope, "read");

  // claude.ai 注册时会带上 jwt-bearer
  const claude = await register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"], response_types: ["code", "token"] });
  assert.equal(claude.statusCode, 201, claude.body);
  assert.deepEqual(claude.json().grant_types, ["authorization_code", "refresh_token"]);
  assert.deepEqual(claude.json().response_types, ["code"]);

  const badUri = await register({ redirect_uris: ["javascript:alert(1)"] });
  assert.equal(badUri.statusCode, 400);
  assert.equal(badUri.json().error, "invalid_redirect_uri");
  assert.match(badUri.json().error_description, ascii);
  const noCode = await register({ redirect_uris: [CALLBACK], grant_types: ["client_credentials"] });
  assert.equal(noCode.json().error, "invalid_client_metadata");
});

test("动态注册：body 超过 16 KB、不是合法 JSON 都回 OAuth 格式的 invalid_request；多交的字段不落库", async () => {
  const big = await register({ redirect_uris: [CALLBACK], junk: "a".repeat(20 * 1024) });
  assert.equal(big.statusCode, 413);
  assert.equal(big.json().error, "invalid_request");
  const broken = await app.inject({ method: "POST", url: "/oauth/register", headers: { "content-type": "application/json" }, payload: "{nope" });
  assert.equal(broken.statusCode, 400);
  assert.equal(broken.json().error, "invalid_request");

  await registerClient([CALLBACK], { junk: "b".repeat(10 * 1024), logo_uri: "https://x.example/logo.png" });
  const rows = db.select().from(oauthClients).all();
  assert.equal(rows.length, 1);
  assert.ok(JSON.stringify(rows[0]).length < 1000, "只存名字、回调地址、scope");
});

test("动态注册限流：同一来源一小时 10 个（IPv6 按 /64 算），全局一小时 60 个", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await register({ redirect_uris: [CALLBACK] }, `2001:db8:1:2::${i + 1}`)).statusCode, 201);
  const sameSlash64 = await register({ redirect_uris: [CALLBACK] }, "2001:db8:1:2:ffff::1");
  assert.equal(sameSlash64.statusCode, 429, "同一个 /64 里换地址绕不过去");
  assert.ok(Number(sameSlash64.headers["retry-after"]) > 0);

  __test_resetAgentQuota();
  let created = 0;
  for (let ip = 1; ip <= 7; ip++) {
    for (let i = 0; i < 10; i++) if ((await register({ redirect_uris: [CALLBACK] }, `198.51.100.${ip}`)).statusCode === 201) created++;
  }
  assert.equal(created, 60, "换着地址来也只有 60 个");
});

/* ------------------------------- 授权码流程 ------------------------------- */

test("完整流程：授权页出配对码 → 管理界面输入配对码和密码批准 → 跳回带 code / state / iss → 换令牌 → 调 /mcp", async () => {
  const clientId = await registerClient();
  const { verifier, params } = authParams(clientId, { state: "abc", scope: "read run write offline_access", resource: RESOURCE });
  const page = await authorize(params);
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
  const d = pageData(page.body);
  assert.match(d.code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);

  // 管理界面的待批准里看得到：客户端名、回调域名、要的档位——但没有配对码（得看授权页）
  const state = await oauthState();
  assert.equal(state.active, true);
  const pending = state.pending.find((p: { id: string }) => p.id === d.id);
  assert.equal(pending.clientName, "测试客户端");
  assert.equal(pending.clientKind, "dcr");
  assert.equal(pending.clientHost, null);
  assert.equal(pending.redirectHost, "client.example");
  assert.equal(pending.redirectInsecure, false);
  assert.deepEqual(pending.requestedScopes, ["read", "run", "write"]);
  assert.ok(!JSON.stringify(state).includes(d.code), "列表里不给配对码");

  assert.equal((await poll(d)).status, "pending");
  const wrongCode = await approve(d, { code: "2222-2222" });
  assert.equal(wrongCode.statusCode, 400);
  assert.equal(wrongCode.json().code, "WRONG_PAIRING_CODE");
  const wrongPassword = await approve(d, { password: "nope" });
  assert.equal(wrongPassword.statusCode, 400);
  assert.equal(wrongPassword.json().code, "WRONG_PASSWORD");
  assert.equal((await poll(d)).status, "pending", "配对码、密码不对都没批");
  assert.equal((await approve(d, { code: d.code.toLowerCase().replace("-", " ") })).statusCode, 200, "配对码不分大小写、横线写不写都行");

  const r = await poll(d);
  assert.equal(r.status, "redirect");
  const back = new URL(r.url!);
  assert.equal(`${back.origin}${back.pathname}`, CALLBACK);
  assert.equal(back.searchParams.get("state"), "abc");
  assert.equal(back.searchParams.get("iss"), PUBLIC);
  const code = back.searchParams.get("code")!;

  const res = await token({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["cache-control"], "no-store");
  const t = res.json();
  assert.match(t.access_token, /^osat_/);
  assert.match(t.refresh_token, /^osrt_/);
  assert.equal(t.token_type, "Bearer");
  assert.equal(t.expires_in, 3600);
  assert.equal(t.scope, "read run write offline_access");
  assert.equal((await poll(d)).status, "done", "换过令牌就完了");

  const { res: listed, json } = await mcp(t.access_token);
  assert.equal(listed.statusCode, 200, listed.body);
  assert.ok(toolNames(json).includes("share_save"), "日常档看得到写工具");
  const call = await mcp(t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "overview", arguments: {} } });
  assert.equal(call.res.statusCode, 200);
  const grants = (await oauthState()).grants;
  assert.equal(grants.length, 1);
  assert.equal(grants[0].clientName, "测试客户端");
  assert.equal(grants[0].status, "active");
  assert.equal(grants[0].approvedVia, "ui");
  assert.equal(grants[0].requestIp, "127.0.0.1");
  assert.ok(listAgentCalls({ tokenId: grants[0].id, limit: 5 }).some((c) => c.tool === "overview" && c.tokenName === "测试客户端（OAuth）"));
});

test("取授权码的回应丢了：授权页再问会换一个新的（旧的作废），换过令牌之后才算完", async () => {
  const clientId = await registerClient();
  const { verifier, params } = authParams(clientId);
  const d = pageData((await authorize(params)).body);
  assert.equal((await approve(d)).statusCode, 200);
  const first = new URL((await poll(d)).url!).searchParams.get("code")!;
  const second = new URL((await poll(d)).url!).searchParams.get("code")!;
  assert.notEqual(first, second);
  const stale = await token({ grant_type: "authorization_code", code: first, client_id: clientId, code_verifier: verifier });
  assert.equal(stale.json().error, "invalid_grant");
  const ok = await token({ grant_type: "authorization_code", code: second, client_id: clientId, code_verifier: verifier });
  assert.equal(ok.statusCode, 200, ok.body);
});

test("给的档位按客户端要的收窄：客户端只要了查看，管理员选日常也只给查看；没要 offline_access 就不在 scope 里", async () => {
  const { tokens } = await fullFlow({ scope: "read" });
  assert.equal(tokens.scope, "read");
  assert.ok(tokens.refresh_token, "刷新令牌总是发");
  const { json } = await mcp(tokens.access_token);
  assert.ok(!toolNames(json).includes("share_save"));
  assert.ok(toolNames(json).includes("overview"));
});

test("批准时的档位和工具集：客户端什么都没要、选了完全就给 danger；只勾同步那组，转存工具就看不到；一个档位都不选 400", async () => {
  const full = await fullFlow({ scope: "", approveScopes: ["read", "run", "write", "danger"] });
  assert.equal(full.tokens.scope, "read run write danger");

  const syncOnly = await fullFlow({ toolsets: ["sync"] });
  const names = toolNames((await mcp(syncOnly.tokens.access_token)).json);
  assert.ok(names.includes("sync_start"));
  assert.ok(!names.includes("share_save"), "没勾转存那组");

  const clientId = await registerClient();
  const d = pageData((await authorize(authParams(clientId).params)).body);
  assert.equal((await approve(d, { scopes: [] })).statusCode, 400);
});

test("授权码重复使用：一分钟内同一个客户端、PKCE 对得上 → 回同一对令牌；PKCE 不对或者过了一分钟 → 用它换的令牌整个作废", async () => {
  const first = await fullFlow();
  const retry = await token({ grant_type: "authorization_code", code: first.code, redirect_uri: CALLBACK, client_id: first.clientId, code_verifier: first.verifier });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().access_token, first.tokens.access_token, "回应丢了重试，拿回的是同一对");
  assert.equal(retry.json().refresh_token, first.tokens.refresh_token);
  assert.equal((await mcp(first.tokens.access_token)).res.statusCode, 200);

  const stolen = await token({ grant_type: "authorization_code", code: first.code, client_id: first.clientId, code_verifier: pkce().verifier });
  assert.equal(stolen.json().error, "invalid_grant");
  assert.equal((await mcp(first.tokens.access_token)).res.statusCode, 401, "截获了授权码的人没有 code_verifier：当成重放，整个作废");

  const second = await fullFlow();
  db.update(oauthRequests).set({ usedAt: nowS() - 61 }).where(eq(oauthRequests.status, "used")).run();
  const late = await token({ grant_type: "authorization_code", code: second.code, client_id: second.clientId, code_verifier: second.verifier });
  assert.equal(late.json().error, "invalid_grant");
  assert.equal((await mcp(second.tokens.access_token)).res.statusCode, 401);
});

test("换不到令牌的各种情况：授权码过期、PKCE 不对、redirect_uri 不对、resource 不对、不是发给这个客户端的、没带 grant_type", async () => {
  const clientId = await registerClient();
  const other = await registerClient();
  const check = async (mutate: (f: Record<string, string>) => void, error: string) => {
    const { code, verifier } = await authorizeAndApprove({ clientId });
    const form: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier };
    mutate(form);
    const res = await token(form);
    assert.equal(res.statusCode, 400, `${error}: ${res.body}`);
    assert.equal(res.json().error, error);
    assert.match(res.json().error_description, ascii, "error_description 只能是 ASCII");
  };
  await check((f) => (f.code_verifier = pkce().verifier), "invalid_grant");
  await check((f) => (f.redirect_uri = "https://client.example/other"), "invalid_grant");
  await check((f) => (f.resource = "https://evil.example/mcp"), "invalid_target");
  await check((f) => (f.client_id = other), "invalid_grant");
  await check((f) => delete f.grant_type, "invalid_request");
  await check((f) => (f.grant_type = "password"), "unsupported_grant_type");

  const { code, verifier } = await authorizeAndApprove({ clientId });
  db.update(oauthRequests).set({ codeExpiresAt: nowS() - 1 }).run();
  const expired = await token({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier });
  assert.equal(expired.json().error, "invalid_grant");

  const sameResource = await authorizeAndApprove({ clientId });
  const upper = await token({ grant_type: "authorization_code", code: sameResource.code, client_id: clientId, code_verifier: sameResource.verifier, resource: "https://MCP.example.com:443/mcp/" });
  assert.equal(upper.statusCode, 200, "资源地址大小写、默认端口、结尾的 / 不计较");

  const broken = await app.inject({ method: "POST", url: "/oauth/token", headers: { ...PUB, "content-type": "application/json" }, payload: "{nope" });
  assert.equal(broken.json().error, "invalid_request");
});

test("授权页：回调地址核对过之后出错，回环地址直接跳回，别的给链接不自动跳；回调对不上停在错误页；回环端口随便；登记的查询串原样保留", async () => {
  const clientId = await registerClient([CALLBACK, "http://127.0.0.1:1234/cb"]);
  const { challenge } = pkce();
  const base = { response_type: "code", client_id: clientId, redirect_uri: CALLBACK, state: "s", code_challenge: challenge, code_challenge_method: "S256" };

  const plain = await authorize({ ...base, code_challenge_method: "plain" });
  assert.equal(plain.statusCode, 400, "不自动跳：动态注册谁都能登记任意回调地址，自动跳等于任意跳转器");
  assert.equal(plain.headers.location, undefined);
  const link = /<a class="back" href="([^"]+)"/.exec(plain.body);
  assert.ok(link, "给一个回到客户端的链接");
  const linkUrl = new URL(link[1].replace(/&amp;/g, "&"));
  assert.equal(linkUrl.searchParams.get("error"), "invalid_request");
  assert.equal(linkUrl.searchParams.get("state"), "s");
  assert.equal(linkUrl.searchParams.get("iss"), PUBLIC);

  const loopbackPlain = await authorize({ ...base, redirect_uri: "http://127.0.0.1:5555/cb", code_challenge_method: "plain" });
  assert.equal(loopbackPlain.statusCode, 302, "回环地址（命令行客户端在等）直接跳回去");
  assert.equal(new URL(String(loopbackPlain.headers.location)).searchParams.get("error"), "invalid_request");

  const wrongResource = await authorize({ ...base, redirect_uri: "http://127.0.0.1:5555/cb", resource: "https://evil.example/mcp" });
  assert.equal(new URL(String(wrongResource.headers.location)).searchParams.get("error"), "invalid_target");
  const noType = await authorize({ ...base, redirect_uri: "http://127.0.0.1:5555/cb", response_type: "" });
  assert.equal(new URL(String(noType.headers.location)).searchParams.get("error"), "invalid_request");

  const wrongCallback = await authorize({ ...base, redirect_uri: "https://evil.example/cb" });
  assert.equal(wrongCallback.statusCode, 400, "回调地址对不上不能跳过去");
  assert.equal(wrongCallback.headers.location, undefined);
  assert.ok(!wrongCallback.body.includes('class="back"'), "也不给链接");

  assert.equal((await authorize({ ...base, redirect_uri: "http://127.0.0.1:5555/cb" })).statusCode, 200);
  assert.equal((await authorize({ ...base, client_id: "oc_unknown" })).statusCode, 400);

  const withQuery = "https://client.example/cb?a=b%20c&flag";
  const qClient = await registerClient([withQuery]);
  const { code, url } = await authorizeAndApprove({ clientId: qClient, redirectUri: withQuery });
  assert.ok(url.toString().startsWith(`${withQuery}&code=`), url.toString());
  assert.ok(code);
});

test("授权页：客户端名是别人写的，一律转义；公网上的 http 回调、回环回调各有提醒", async () => {
  const evil = await registerClient(["http://203.0.113.5/cb"], { client_name: '<img src=x onerror="alert(1)">' });
  const page = await authorize({ ...authParams(evil).params, redirect_uri: "http://203.0.113.5/cb" });
  assert.equal(page.statusCode, 200);
  assert.ok(!page.body.includes("<img"), "不能原样出现在页面里");
  assert.ok(page.body.includes("&lt;img"));
  assert.match(page.body, /公网上的 http/);
  const pending = (await oauthState()).pending[0];
  assert.equal(pending.redirectInsecure, true);

  const cli = await registerClient([LOOPBACK]);
  const cliPage = await authorize({ ...authParams(cli).params, redirect_uri: LOOPBACK });
  assert.match(cliPage.body, /跳回本机/);
});

test("拒绝：跳回带 access_denied（授权页说拒绝）；拒过的、过期的不能再批；轮询密钥不对什么也看不到；轮询只收 POST", async () => {
  const clientId = await registerClient();
  const { params } = authParams(clientId);
  const d = pageData((await authorize(params)).body);
  assert.equal((await app.inject({ method: "POST", url: `/api/agent/oauth/requests/${d.id}/deny`, headers: session })).statusCode, 200);
  const denied = await poll(d);
  assert.equal(denied.status, "denied", "授权页要说拒绝，不能说批准");
  assert.equal(new URL(denied.url!).searchParams.get("error"), "access_denied");
  assert.equal((await approve(d)).statusCode, 404, "拒绝过的不能再批");

  const d2 = pageData((await authorize(params)).body);
  db.update(oauthRequests).set({ expiresAt: nowS() - 1 }).run();
  const expired = await poll(d2);
  assert.equal(expired.status, "expired");
  assert.equal(new URL(expired.url!).searchParams.get("error"), "access_denied", "过期了也给个回客户端的地址");
  assert.equal(expired.auto, false, "不是回环地址：页面上给链接，不自动跳");
  assert.equal((await approve(d2)).statusCode, 404, "过期的不能再批");
  assert.equal((await poll({ id: d2.id, k: "wrong" })).status, "missing", "轮询密钥不对什么也看不到");
  const get = await app.inject({ method: "GET", url: `/oauth/authorize/status?id=${d2.id}&k=${d2.k}`, headers: PUB });
  assert.equal(get.statusCode, 404, "轮询密钥不能放进地址（会进访问日志）；公网域名上这个路径也只放 POST");
});

test("全部拒绝：待批准的一次清掉", async () => {
  const clientId = await registerClient();
  const pages = [];
  for (let i = 0; i < 3; i++) pages.push(pageData((await authorize(authParams(clientId).params)).body));
  const res = await app.inject({ method: "POST", url: "/api/agent/oauth/requests/deny-all", headers: session });
  assert.equal(res.json().denied, 3);
  assert.equal((await oauthState()).pending.length, 0);
  assert.equal((await poll(pages[0])).status, "denied");
});

test("刷新：换一对新的，旧的访问令牌到它过期前还认；一分钟内拿同一个刷新令牌再来（并发）回同一对；之后再拿旧的来整个作废", async () => {
  const { clientId, tokens } = await fullFlow();
  const r1 = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId, resource: RESOURCE });
  assert.equal(r1.statusCode, 200, r1.body);
  const t1 = r1.json();
  assert.notEqual(t1.access_token, tokens.access_token);
  assert.notEqual(t1.refresh_token, tokens.refresh_token);
  assert.equal((await mcp(t1.access_token)).res.statusCode, 200);
  assert.equal((await mcp(tokens.access_token)).res.statusCode, 200, "刷新时正在路上的请求不会平白 401");

  const parallel = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(parallel.statusCode, 200, "并发的第二个刷新：回同一对，不当成重放");
  assert.equal(parallel.json().access_token, t1.access_token);
  assert.equal(parallel.json().refresh_token, t1.refresh_token);
  assert.equal(listOAuthGrants(RESOURCE).length, 1);

  const r2 = await token({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: clientId });
  assert.equal(r2.statusCode, 200);
  assert.equal((await mcp(tokens.access_token)).res.statusCode, 401, "两代以前的访问令牌不认了");
  const movedOn = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(movedOn.json().error, "invalid_grant", "之后已经又刷新过了还拿最早的来：重放");
  assert.equal((await mcp(r2.json().access_token)).res.statusCode, 401, "整个授权作废");
  assert.equal(listOAuthGrants(RESOURCE).length, 0);

  const again = await fullFlow();
  const a1 = await token({ grant_type: "refresh_token", refresh_token: again.tokens.refresh_token, client_id: again.clientId });
  db.update(oauthUsedRefresh).set({ usedAt: nowS() - 61 }).run();
  const late = await token({ grant_type: "refresh_token", refresh_token: again.tokens.refresh_token, client_id: again.clientId });
  assert.equal(late.json().error, "invalid_grant", "过了一分钟再拿旧的来：重放");
  assert.equal((await mcp(a1.json().access_token)).res.statusCode, 401);
});

test("撤销：刷新令牌 → 整个授权作废；访问令牌 → 只作废它，刷新令牌照样能换；不认识的令牌也回 200", async () => {
  const { clientId, tokens } = await fullFlow();
  const revoke = (t: string) =>
    app.inject({ method: "POST", url: "/oauth/revoke", headers: { ...PUB, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ token: t, client_id: clientId }).toString() });
  assert.equal((await revoke(tokens.access_token)).statusCode, 200);
  assert.equal((await mcp(tokens.access_token)).res.statusCode, 401);
  const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.equal((await revoke("osrt_unknown")).statusCode, 200);
  assert.equal((await revoke(refreshed.json().refresh_token)).statusCode, 200);
  assert.equal((await mcp(refreshed.json().access_token)).res.statusCode, 401);
});

test("预注册客户端：secret 只给一次；post / basic（方案名不分大小写）都能换令牌；认证失败用 basic 的 401 带 WWW-Authenticate，不用的 400", async () => {
  const created = await app.inject({ method: "POST", url: "/api/agent/oauth/clients", headers: session, payload: { name: "Home Assistant", redirectUris: [CALLBACK] } });
  assert.equal(created.statusCode, 201, created.body);
  const { clientId, clientSecret } = created.json();
  assert.match(clientSecret, /^ocs_/);
  assert.ok(!JSON.stringify(await oauthState()).includes(clientSecret), "列表里不能有 secret");

  const viaPost = await authorizeAndApprove({ clientId });
  const post = await token({ grant_type: "authorization_code", code: viaPost.code, redirect_uri: CALLBACK, client_id: clientId, client_secret: clientSecret, code_verifier: viaPost.verifier });
  assert.equal(post.statusCode, 200, post.body);

  const viaBasic = await authorizeAndApprove({ clientId });
  const basic = `basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  const basicRes = await token({ grant_type: "authorization_code", code: viaBasic.code, redirect_uri: CALLBACK, code_verifier: viaBasic.verifier }, { authorization: basic });
  assert.equal(basicRes.statusCode, 200, basicRes.body);

  const wrong = await token({ grant_type: "refresh_token", refresh_token: basicRes.json().refresh_token }, { authorization: `Basic ${Buffer.from(`${clientId}:ocs_wrong`).toString("base64")}` });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error, "invalid_client");
  assert.match(String(wrong.headers["www-authenticate"]), /^Basic /);
  const noSecret = await token({ grant_type: "refresh_token", refresh_token: basicRes.json().refresh_token, client_id: clientId });
  assert.equal(noSecret.statusCode, 400, "没用 Authorization 头：回 400（RFC 6749 §5.2）");
  assert.equal(noSecret.json().error, "invalid_client");

  // 删了预注册客户端：用它连上的断开，已经批了还没换令牌的也换不出来了
  const pendingFlow = await authorizeAndApprove({ clientId });
  assert.equal((await app.inject({ method: "DELETE", url: `/api/agent/oauth/clients/${clientId}`, headers: session })).statusCode, 200);
  assert.equal((await mcp(basicRes.json().access_token)).res.statusCode, 401);
  const late = await token({ grant_type: "authorization_code", code: pendingFlow.code, client_id: clientId, client_secret: clientSecret, code_verifier: pendingFlow.verifier });
  assert.equal(late.statusCode, 400);

  const dcr = await registerClient();
  assert.equal((await app.inject({ method: "DELETE", url: `/api/agent/oauth/clients/${dcr}`, headers: session })).statusCode, 404, "只能删预注册的");
});

test("CIMD：默认不认；开了之后按对方的缓存头缓存；回调对不上且缓存旧了重取一次；ChatGPT 的真文档能用；文档对不上停在错误页", async () => {
  const url = "https://client.example/oauth/client.json";
  const { params } = authParams(url);
  const off = await authorize(params);
  assert.equal(off.statusCode, 400);
  assert.match(off.body, /没开 CIMD/);

  patchAppSettings({ agent: { enabled: true, publicBaseUrl: PUBLIC, oauthCimd: true } });
  let fetched = 0;
  let redirects = [CALLBACK];
  setCimdFetcher(async (u) => {
    fetched++;
    assert.equal(u, url);
    return { doc: { client_id: url, client_name: "CIMD 测试", redirect_uris: redirects }, cacheSeconds: 3600 };
  });
  const { tokens } = await fullFlow({ clientId: url });
  assert.equal((await mcp(tokens.access_token)).res.statusCode, 200);
  await authorizeAndApprove({ clientId: url });
  assert.equal(fetched, 1, "缓存期内不再取");
  const pending = pageData((await authorize(authParams(url).params)).body);
  const info = (await oauthState()).pending.find((p: { id: string }) => p.id === pending.id);
  assert.equal(info.clientHost, "client.example", "CIMD 客户端给出元数据地址的域名");

  // 对方换了回调地址：缓存旧（超过 5 分钟）了就重取一次
  redirects = ["https://client.example/new-callback"];
  db.update(oauthClients).set({ fetchedAt: nowS() - 600 }).run();
  const moved = await authorize({ ...authParams(url).params, redirect_uri: "https://client.example/new-callback" });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(fetched, 2);

  const chatgpt = "https://chatgpt.com/oauth/client.json";
  setCimdFetcher(async () => ({
    doc: {
      client_id: chatgpt,
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      token_endpoint_auth_method: "private_key_jwt",
      jwks_uri: "https://chatgpt.com/oauth/jwks.json",
      client_name: "ChatGPT",
    },
    cacheSeconds: 86400,
  }));
  const gpt = await authorize({ ...authParams(chatgpt).params, redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" });
  assert.equal(gpt.statusCode, 200, "ChatGPT 的文档写的是 private_key_jwt：照收，按公开客户端走");

  setCimdFetcher(async () => ({ doc: { client_id: "https://evil.example/meta.json", redirect_uris: [CALLBACK] }, cacheSeconds: 86400 }));
  const bad = await authorize(authParams("https://other.example/meta.json").params);
  assert.equal(bad.statusCode, 400);
});

test("CIMD 真去取的那条路：写 IP、单段主机名的地址不去连，直接拒", async () => {
  patchAppSettings({ agent: { enabled: true, publicBaseUrl: PUBLIC, oauthCimd: true } });
  setCimdFetcher(null);
  for (const clientId of ["https://127.0.0.1/x.json", "https://[::1]/x.json", "https://2130706433/x.json", "https://localhost/x.json"]) {
    const res = await authorize(authParams(clientId).params);
    assert.equal(res.statusCode, 400, clientId);
    assert.doesNotMatch(res.body, /ECONNREFUSED|ECONNRESET|ETIMEDOUT/, "不能把连接细节回给人（能拿来探内网端口）");
  }
});

test("授权页密码批准：默认关；开了之后密码不对拒（中文说明给页面）、并发撞库最多放进 5 个、拒过的请求不能拿来试、档位只认 read / daily；回调在别的公网域名上的不给", async () => {
  const clientId = await registerClient([CLAUDE_CALLBACK]);
  const params = authParams(clientId, { redirect_uri: CLAUDE_CALLBACK }).params;
  const page = await authorize(params);
  assert.ok(!page.body.includes('id="pw"'), "默认不出密码框");
  const d = pageData(page.body);
  const pw = (body: Record<string, string>, remoteAddress = "127.0.0.1") => app.inject({ method: "POST", url: "/oauth/authorize/password", headers: PUB, payload: body, remoteAddress });
  assert.equal((await pw({ id: d.id, k: d.k, password: PASSWORD, preset: "daily" })).statusCode, 403);

  patchAppSettings({ agent: { enabled: true, publicBaseUrl: PUBLIC, allowPasswordApproval: true } });
  const d2 = pageData((await authorize(params)).body);
  const wrong = await pw({ id: d2.id, k: d2.k, password: "nope", preset: "daily" });
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.json().error, "access_denied");
  assert.equal(wrong.json().message, "密码不对");

  const burst = await Promise.all(Array.from({ length: 10 }, () => pw({ id: d2.id, k: d2.k, password: "nope", preset: "daily" }, "203.0.113.50")));
  const verified = burst.filter((r) => r.statusCode === 403).length;
  assert.ok(verified <= 5, `并发的一批里最多比对 5 次，实际 ${verified}`);
  assert.ok(burst.some((r) => r.statusCode === 429));

  assert.equal((await pw({ id: d2.id, k: d2.k, password: PASSWORD, preset: "constructor" })).statusCode, 400, "原型上的名字不算档位");
  const ok = await pw({ id: d2.id, k: d2.k, password: PASSWORD, preset: "read" });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().status, "redirect");

  const d3 = pageData((await authorize(params)).body);
  await app.inject({ method: "POST", url: `/api/agent/oauth/requests/${d3.id}/deny`, headers: session });
  assert.equal((await pw({ id: d3.id, k: d3.k, password: "whatever", preset: "daily" })).statusCode, 404, "拒过的请求不能拿来试密码");

  // 动态注册谁都能做、回调随便填：授权码发到别的公网域名的，授权页上没有密码框，硬发也不收，只能用配对码
  const other = await registerClient();
  const otherPage = await authorize(authParams(other).params);
  assert.ok(!otherPage.body.includes('id="pw"'), "没有密码框");
  assert.match(otherPage.body, /id="pwnote"/);
  const d4 = pageData(otherPage.body);
  const refused = await pw({ id: d4.id, k: d4.k, password: PASSWORD, preset: "daily" });
  assert.equal(refused.statusCode, 403);
  assert.match(refused.json().message, /client\.example.*配对码/);
  assert.equal((await poll(d4)).status, "pending");
  const infos = (await oauthState()).pending as Array<{ id: string; passwordApproval: boolean }>;
  assert.equal(infos.find((r) => r.id === d4.id)?.passwordApproval, false);
});

test("授权请求限流：同一来源一小时 10 个、同时最多 3 个在等；全局最多 20 个在等；回环回调超限直接跳回 temporarily_unavailable", async () => {
  const clientId = await registerClient([CALLBACK, LOOPBACK]);
  for (let i = 0; i < 3; i++) assert.equal((await authorize(authParams(clientId).params)).statusCode, 200);
  const fourth = await authorize(authParams(clientId).params);
  assert.equal(fourth.statusCode, 400);
  assert.match(fourth.body, /好几个授权请求在等批准/);
  const cli = await authorize({ ...authParams(clientId).params, redirect_uri: LOOPBACK });
  assert.equal(cli.statusCode, 302);
  assert.equal(new URL(String(cli.headers.location)).searchParams.get("error"), "temporarily_unavailable");

  const denyAll = () => app.inject({ method: "POST", url: "/api/agent/oauth/requests/deny-all", headers: session });
  await denyAll();
  for (let i = 0; i < 7; i++) {
    assert.equal((await authorize(authParams(clientId).params)).statusCode, 200);
    await denyAll();
  }
  const over = await authorize(authParams(clientId).params);
  assert.match(over.body, /一小时内发起的授权请求太多/, "拒掉的也算在一小时的数里");

  let ok = 0;
  for (let ip = 1; ip <= 8; ip++) {
    for (let i = 0; i < 3; i++) if ((await authorize(authParams(clientId).params, `198.51.100.${ip}`)).statusCode === 200) ok++;
  }
  assert.equal(ok, 20, "全局最多 20 个在等");
});

/* ------------------------------- Telegram ------------------------------- */

function fakeBot() {
  const messages: Array<{ text: string; buttons?: InlineKeyboard }> = [];
  const answers: string[] = [];
  const edits: string[] = [];
  const bot: BotLike = {
    sendMessage: async (_c, text, opts) => {
      messages.push({ text, buttons: opts?.buttons });
      return { ok: true, result: { message_id: messages.length } };
    },
    editMessage: async (_c, _m, text) => {
      edits.push(text);
      return { ok: true };
    },
    answerCallback: async (_id, text) => {
      answers.push(text ?? "");
      return { ok: true };
    },
  };
  return { bot, messages, answers, edits };
}

const tgMessage = (fromId: number, text: string, updateId: number) => ({
  update_id: updateId,
  message: { message_id: updateId, date: 0, chat: { id: 900, type: "group" as const }, from: { id: fromId, is_bot: false, first_name: "u" }, text },
});
const tgPress = (fromId: number, data: string, updateId: number) => ({
  update_id: updateId,
  callback_query: { id: `q${updateId}`, from: { id: fromId, is_bot: false, first_name: "u" }, message: { message_id: 5, date: 0, chat: { id: 900, type: "group" as const } }, data },
});

test("Telegram：通知只带「拒绝」；开关关着发配对码也不给批；开了之后发配对码才出批准按钮，按钮只对这次解锁的请求有效", async () => {
  const tg = { ...(readAppSettings().telegram ?? {}), botToken: "123:abc", chatId: "900", allowedUsers: [7] };
  patchAppSettings({ telegram: { ...tg, allowOAuthApproval: false } });
  try {
    const clientId = await registerClient([CALLBACK], { client_name: "<b>坏</b>" });
    const d = pageData((await authorize(authParams(clientId).params)).body);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, "900");
    assert.ok(!sent[0].text.includes(d.code), "通知里没有配对码");
    assert.ok(sent[0].text.includes("&lt;b&gt;坏"), "客户端名转义");
    assert.deepEqual(
      sent[0].buttons.flat().map((b) => b.callback_data),
      [`oad:${d.id}`],
      "只有拒绝",
    );

    const off = fakeBot();
    await handleUpdate(off.bot, tgMessage(7, d.code, 1));
    assert.match(off.messages[0].text, /没开/);
    assert.equal((await poll(d)).status, "pending");

    patchAppSettings({ telegram: { ...tg, allowOAuthApproval: true } });
    const on = fakeBot();
    // 按钮数据是能伪造的：没发过配对码就按「批准」不算
    await handleUpdate(on.bot, tgPress(7, `oaa:${d.id}:daily`, 2));
    assert.match(on.answers[0], /配对码/);
    assert.equal((await poll(d)).status, "pending");

    await handleUpdate(on.bot, tgMessage(7, "2222-2222", 3));
    assert.match(on.messages.at(-1)!.text, /没找到/);
    await handleUpdate(on.bot, tgMessage(7, d.code.toLowerCase(), 4));
    const unlocked = on.messages.at(-1)!;
    const approveButton = unlocked.buttons!.flat().find((b) => b.callback_data === `oaa:${d.id}:read`);
    assert.ok(approveButton, "配对码对上了才有批准按钮");

    await handleUpdate(on.bot, tgPress(8, approveButton.callback_data, 5));
    assert.equal((await poll(d)).status, "pending", "白名单外的人按了没用");
    await handleUpdate(on.bot, tgPress(7, approveButton.callback_data, 6));
    assert.ok(on.answers.includes("已批准"), on.answers.join(","));
    assert.match(on.edits.at(-1) ?? "", /已批准（只读）/);
    const r = await poll(d);
    assert.equal(r.status, "redirect");
    assert.equal((await oauthState()).pending.length, 0);

    // 拒绝不用配对码
    const d2 = pageData((await authorize(authParams(clientId).params)).body);
    await handleUpdate(on.bot, tgPress(7, `oad:${d2.id}`, 7));
    assert.equal((await poll(d2)).status, "denied");
  } finally {
    patchAppSettings({ telegram: baseline.telegram ?? {} });
  }
});

test("Telegram 通知：授权页上能用密码批准的（claude.ai 这类回调），通知里说一声；回调在别的公网域名上的不说", async () => {
  patchAppSettings({
    telegram: { ...(readAppSettings().telegram ?? {}), botToken: "123:abc", chatId: "900", allowedUsers: [7] },
    agent: { enabled: true, publicBaseUrl: PUBLIC, publicServesUi: true, allowPasswordApproval: true },
  });
  try {
    const claude = await registerClient([CLAUDE_CALLBACK]);
    await authorize(authParams(claude, { redirect_uri: CLAUDE_CALLBACK }).params);
    const other = await registerClient();
    await authorize(authParams(other).params);
    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /直接在授权页上输管理员密码批准/);
    assert.doesNotMatch(sent[1].text, /授权页上输管理员密码/);
    assert.match(sent[1].text, /配对码/);
  } finally {
    patchAppSettings({ telegram: baseline.telegram ?? {} });
  }
});

test("Telegram 通知限量：一小时最多 10 条（有人刷授权请求时不刷屏），设置页里照样都看得到", async () => {
  patchAppSettings({ telegram: { ...(readAppSettings().telegram ?? {}), botToken: "123:abc", chatId: "900", allowedUsers: [7] } });
  try {
    const clientId = await registerClient();
    for (let ip = 1; ip <= 4; ip++) for (let i = 0; i < 3; i++) await authorize(authParams(clientId).params, `198.51.100.${ip}`);
    assert.equal(sent.length, 10);
    assert.equal((await oauthState()).pending.length, 12);
  } finally {
    patchAppSettings({ telegram: baseline.telegram ?? {} });
  }
});

/* ------------------------------- 公网守卫、设置 ------------------------------- */

test("公网域名只放行公网路径：页面、管理接口、路径变体、主机名的各种写法一律 404；本地域名照常", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server", headers: PUB })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/mcp", headers: { ...PUB, "content-type": "application/json" }, payload: "{}" })).statusCode, 401);
  for (const url of ["/", "/settings", "/api/task", "/api/agent/tokens", "/api/settings", "/mcp/", "/oauth/../api/task", "/%6Dcp", "/.well-known/openid-configuration", "/oauth/token", "/oauth/register"]) {
    assert.equal((await app.inject({ method: "GET", url, headers: { ...PUB, ...session } })).statusCode, 404, url);
  }
  assert.equal((await app.inject({ method: "POST", url: "/.well-known/oauth-authorization-server", headers: PUB })).statusCode, 404, "方法也按路径卡");
  const preflight = await app.inject({ method: "OPTIONS", url: "/oauth/token", headers: { ...PUB, origin: "http://localhost:6274", "access-control-request-method": "POST" } });
  assert.equal(preflight.statusCode, 204, "跨域预检放行");
  for (const host of ["mcp.example.com.", "MCP.Example.com", "mcp.example.com:443", "mcp.example.com.:8443"]) {
    assert.equal((await app.inject({ method: "GET", url: "/api/agent/tokens", headers: { host, ...session } })).statusCode, 404, host);
  }
  // X-Forwarded-Host 只能让它更严：公网 Host 加一个别的 XFH 绕不过去；本地 Host 带上公网的 XFH 也按公网算
  for (const headers of [{ ...PUB, "x-forwarded-host": "nas.lan" }, { ...PUB, "x-forwarded-host": "mcp.example.com, nas.lan" }, { host: "nas.lan", "x-forwarded-host": "mcp.example.com" }]) {
    assert.equal((await app.inject({ method: "GET", url: "/api/agent/tokens", headers: { ...headers, ...session } })).statusCode, 404, JSON.stringify(headers));
  }
  assert.equal((await app.inject({ method: "GET", url: "/", headers: { host: "nas.lan" } })).statusCode, 200, "本地域名：页面照常");
  assert.equal((await app.inject({ method: "GET", url: "/api/agent/tokens", headers: { host: "nas.lan", ...session } })).statusCode, 200, "本地域名：接口照常");
});

test("共用域名：公网域名上管理界面、管理接口照常（接口照样要登录）；/mcp、OAuth 照常；关掉共用守卫马上回来", async () => {
  patchAppSettings({ agent: { enabled: true, publicBaseUrl: PUBLIC, publicServesUi: true } });
  invalidatePublicHost();
  for (const url of ["/", "/settings", "/api/task", "/api/agent/tokens"]) {
    assert.equal((await app.inject({ method: "GET", url, headers: { ...PUB, ...session } })).statusCode, 200, url);
  }
  assert.equal((await app.inject({ method: "GET", url: "/api/agent/tokens", headers: PUB })).statusCode, 401, "管理接口照样要登录");
  const bare = await app.inject({ method: "POST", url: "/mcp", headers: { ...PUB, "content-type": "application/json" }, payload: "{}" });
  assert.equal(bare.statusCode, 401);
  assert.match(String(bare.headers["www-authenticate"]), /resource_metadata=/, "共用域名也还是公网域名：401 照样指到元数据");
  const { tokens } = await fullFlow();
  assert.equal((await mcp(tokens.access_token)).res.statusCode, 200);

  patchAppSettings({ agent: { enabled: true, publicBaseUrl: PUBLIC, publicServesUi: false } });
  invalidatePublicHost();
  for (const url of ["/", "/api/agent/tokens"]) {
    assert.equal((await app.inject({ method: "GET", url, headers: { ...PUB, ...session } })).statusCode, 404, url);
  }
});

test("共用域名的授权页：开了密码批准就把它放最前，配对码收进「在别的设备上批准」；没开还是配对码；页面自己的安全头不被通用的盖掉", async () => {
  patchAppSettings({ agent: { enabled: true, publicBaseUrl: PUBLIC, publicServesUi: true, allowPasswordApproval: true } });
  invalidatePublicHost();
  const clientId = await registerClient([CLAUDE_CALLBACK]);
  const { verifier, params } = authParams(clientId, { resource: RESOURCE, redirect_uri: CLAUDE_CALLBACK });
  const page = await authorize(params);
  assert.equal(page.statusCode, 200, page.body);
  const [pwbox, alt, code] = ['<div id="pwbox">', '<details id="alt">', 'id="code"'].map((m) => page.body.indexOf(m));
  assert.ok(pwbox > 0 && alt > pwbox && code > alt, `密码批准在前、配对码折叠在后：${[pwbox, alt, code]}`);
  assert.match(page.body, /测试客户端<\/b><span class="muted">（名字是它自己报的）/, "动态注册的名字标明是自己报的");
  assert.match(page.body, /批准后，授权会发给 <b>claude\.ai<\/b>/);
  assert.match(page.body, /pwbtn\.disabled = true/, "批准按钮先灰着，等页面上真有过交互");
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);

  const d = pageData(page.body);
  const ok = await app.inject({ method: "POST", url: "/oauth/authorize/password", headers: PUB, payload: { id: d.id, k: d.k, password: PASSWORD, preset: "daily" } });
  assert.equal(ok.statusCode, 200, ok.body);
  const code2 = new URL(ok.json().url as string).searchParams.get("code")!;
  const res = await token({ grant_type: "authorization_code", code: code2, redirect_uri: CLAUDE_CALLBACK, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().scope, "read run write");

  // 回调在别的公网域名上的：共用域名也只给配对码
  const other = await registerClient();
  const otherBody = (await authorize(authParams(other).params)).body;
  assert.ok(!otherBody.includes('id="pwbox"') && otherBody.includes('id="pwnote"'), "只有配对码，外加一句为什么");
  assert.ok(otherBody.indexOf('id="code"') < otherBody.indexOf('id="howto"'), "说明写的是「上面的配对码」，配对码真在上面");

  const again = authParams(clientId, { redirect_uri: CLAUDE_CALLBACK }).params;
  patchAppSettings({ agent: { enabled: true, publicBaseUrl: PUBLIC, publicServesUi: true, allowPasswordApproval: false } });
  const plain = (await authorize(again)).body;
  assert.ok(!plain.includes('id="pwbox"') && !plain.includes('id="alt"') && !plain.includes('id="pwnote"'), "没开密码批准：只有配对码");
  patchAppSettings({ agent: { enabled: true, publicBaseUrl: PUBLIC, publicServesUi: false, allowPasswordApproval: true } });
  const separate = (await authorize(again)).body;
  assert.ok(separate.indexOf('id="code"') < separate.indexOf('<details id="pwbox">'), "单独的子域名：配对码在前，密码批准折叠着");
});

test("保存设置马上生效：公网守卫缓存着的开关随保存清掉，不用等 5 秒", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/", headers: PUB })).statusCode, 404, "守卫先按「只放行智能体路径」缓存上");
  const put = await app.inject({ method: "PUT", url: "/api/settings", headers: { ...session, host: "nas.lan:3000" }, payload: { agent: { enabled: true, publicBaseUrl: PUBLIC, publicServesUi: true } } });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal((await app.inject({ method: "GET", url: "/", headers: PUB })).statusCode, 200, "没手动清缓存，保存完立刻按新设置走");
});

test("反代后面没设 TRUST_PROXY：看到经内网反代进来的请求就给设置页提示；公网上直接连过来自己带的头不算；设了就不提示", async () => {
  const saved = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
  try {
    const hit = (remoteAddress: string) =>
      app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server", headers: { ...PUB, "x-forwarded-for": "198.51.100.7" }, remoteAddress });
    assert.equal((await oauthState()).untrustedProxy, null);
    await hit("203.0.113.200");
    assert.equal((await oauthState()).untrustedProxy, null, "对端是公网地址：可能是有人直接连端口、自己写的头");
    await hit("172.18.0.2");
    assert.equal((await oauthState()).untrustedProxy?.peer, "172.18.0.2");
    process.env.TRUST_PROXY = "true";
    __test_resetUntrustedProxy();
    await hit("172.18.0.2");
    assert.equal((await oauthState()).untrustedProxy, null);
  } finally {
    if (saved === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = saved;
  }
});

test("设置：公网地址只收 https 的源，存规范写法；域名结尾带点的不收；和现在打开管理界面的域名一样时得打开共用", async () => {
  const put = (publicBaseUrl: string, host = "nas.example.com", publicServesUi?: boolean) =>
    app.inject({ method: "PUT", url: "/api/settings", headers: { ...session, host }, payload: { agent: { enabled: true, publicBaseUrl, publicServesUi } } });
  assert.equal((await put("http://mcp.example.com")).statusCode, 400);
  assert.equal((await put("https://mcp.example.com/sub")).statusCode, 400);
  assert.equal((await put("https://mcp.example.com.")).statusCode, 400);
  const same = await put("https://NAS.example.com:443");
  assert.equal(same.statusCode, 400, "只放行智能体路径的话，保存完管理界面自己就被挡在外面了");
  assert.match(same.json().message, /这个域名也用来打开管理界面/);
  const viaProxy = await app.inject({ method: "PUT", url: "/api/settings", headers: { ...session, host: "127.0.0.1:3000", "x-forwarded-host": "nas.example.com" }, payload: { agent: { enabled: true, publicBaseUrl: "https://nas.example.com" } } });
  assert.equal(viaProxy.statusCode, 400, "反代后面：按 X-Forwarded-Host 也认得出是同一个域名");
  assert.equal((await put("https://NAS.example.com:443", "nas.example.com", true)).statusCode, 200, "打开了共用就能存");
  assert.deepEqual([readAppSettings().agent?.publicBaseUrl, readAppSettings().agent?.publicServesUi], ["https://nas.example.com", true]);
  assert.equal((await put("https://nas.example.com", "nas.example.com", false)).statusCode, 400, "在这个域名上关掉共用：存完自己就进不来了");
  assert.equal((await put("https://nas.example.com", "nas.lan:3000", false)).statusCode, 200, "从局域网地址关掉可以");
  assert.equal((await put("https://nas.example.com", "nas.example.com", true)).statusCode, 404, "关掉之后马上生效：这个域名下管理接口已经打不开了");
  assert.equal((await put("https://MCP.Example.com:443/", "nas.lan:3000")).statusCode, 200);
  assert.equal(readAppSettings().agent?.publicBaseUrl, "https://mcp.example.com", "存规范写法：小写、去默认端口和结尾的 /");
});

test("公网地址改了：旧授权绑的还是旧地址，/mcp 不认、刷新不了，列表里标成失效", async () => {
  const { clientId, tokens } = await fullFlow();
  patchAppSettings({ agent: { enabled: true, publicBaseUrl: "https://mcp2.example.com" } });
  invalidatePublicHost();
  const lanMcp = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json, text/event-stream", "content-type": "application/json", host: "nas.lan" },
    payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(lanMcp.statusCode, 401);
  const refresh = await app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded", host: "mcp2.example.com" },
    payload: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }).toString(),
  });
  assert.equal(refresh.json().error, "invalid_grant");
  const grants = (await oauthState()).grants;
  assert.equal(grants.length, 1);
  assert.equal(grants[0].status, "stale");
});

test("访问令牌、刷新令牌过期：/mcp 不认；刷新令牌过期了刷新不了，授权也清掉", async () => {
  const { clientId, tokens } = await fullFlow();
  db.update(oauthGrants).set({ accessExpiresAt: nowS() - 1 }).run();
  assert.equal((await mcp(tokens.access_token)).res.statusCode, 401);
  db.update(oauthGrants).set({ refreshExpiresAt: nowS() - 1 }).run();
  const res = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(res.json().error, "invalid_grant");
  assert.equal(db.select().from(oauthGrants).all().length, 0);
});

test("改已连接客户端的工具组：只认会话；改完 /mcp 立刻按新的组列工具；null 是全部；断开了的回 404", async () => {
  const { tokens } = await fullFlow({ toolsets: ["sync"] });
  const grantId = listOAuthGrants(RESOURCE)[0].id;
  const before = toolNames((await mcp(tokens.access_token)).json);
  assert.ok(before.includes("sync_status") && !before.includes("organize_status"), before.join(","));

  const url = `/api/agent/oauth/grants/${grantId}`;
  const byToken = await app.inject({ method: "PATCH", url, headers: { authorization: `Bearer ${tokens.access_token}` }, payload: { toolsets: null } });
  assert.notEqual(byToken.statusCode, 200, "令牌不能给自己加工具");
  const empty = await app.inject({ method: "PATCH", url, headers: session, payload: { toolsets: [] } });
  assert.equal(empty.statusCode, 400);

  const patched = await app.inject({ method: "PATCH", url, headers: session, payload: { toolsets: ["sync", "organize"] } });
  assert.equal(patched.statusCode, 200, patched.body);
  const after = toolNames((await mcp(tokens.access_token)).json);
  assert.ok(after.includes("organize_status") && !after.includes("share_save"), after.join(","));
  const all = await app.inject({ method: "PATCH", url, headers: session, payload: { toolsets: null } });
  assert.deepEqual(all.json().toolsets, ["sync", "transfer", "organize", "follow", "strm"]);
  assert.deepEqual((await oauthState()).grants[0].toolsets, ["sync", "transfer", "organize", "follow", "strm"]);

  assert.equal((await app.inject({ method: "DELETE", url, headers: session })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url, headers: session, payload: { toolsets: null } })).statusCode, 404);
});

test("断开 / 全部断开；改密码勾了撤销：手建令牌、网页客户端的授权、还没走完的授权请求一起作废", async () => {
  const a = await fullFlow();
  const grantId = listOAuthGrants(RESOURCE)[0].id;
  assert.equal((await app.inject({ method: "DELETE", url: `/api/agent/oauth/grants/${grantId}`, headers: session })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/agent/oauth/grants/${grantId}`, headers: session })).statusCode, 404);
  assert.equal((await mcp(a.tokens.access_token)).res.statusCode, 401);

  const b = await fullFlow();
  const approvedNotExchanged = await authorizeAndApprove({ clientId: b.clientId });
  const all = await app.inject({ method: "DELETE", url: "/api/agent/oauth/grants", headers: session });
  assert.equal(all.json().deleted, 1);
  assert.equal((await mcp(b.tokens.access_token)).res.statusCode, 401);
  const late = await token({ grant_type: "authorization_code", code: approvedNotExchanged.code, client_id: b.clientId, code_verifier: approvedNotExchanged.verifier });
  assert.equal(late.json().error, "invalid_grant", "全部断开之前批了、还没换令牌的，也换不出来了");

  createApiToken({ name: "手建的", scopes: ["read"], toolsets: ["sync", "transfer"], expiresAt: null });
  const c = await fullFlow();
  const pendingPage = pageData((await authorize(authParams(c.clientId).params)).body);
  const res = await app.inject({ method: "POST", url: "/api/auth/password", headers: session, payload: { currentPassword: PASSWORD, newPassword: `${PASSWORD}-2`, revokeAgentTokens: true } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().revokedAgentTokens, 2);
  assert.equal(listApiTokens().length, 0);
  assert.equal((await mcp(c.tokens.access_token)).res.statusCode, 401);
  assert.equal((await poll(pendingPage)).status, "denied", "还在等批准的也拒掉");
  await writeAuthPassword(PASSWORD);
  session = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

test("管理接口只认会话：手建令牌 403，网页客户端的令牌 401——智能体批不了自己的授权请求", async () => {
  const { tokens } = await fullFlow();
  const manual = createApiToken({ name: "手建的", scopes: ["read", "run", "write", "danger"], toolsets: ["sync", "transfer"], expiresAt: null });
  assert.equal((await app.inject({ method: "GET", url: "/api/agent/oauth", headers: { host: "nas.lan", authorization: `Bearer ${manual.token}` } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/agent/oauth", headers: { host: "nas.lan", authorization: `Bearer ${tokens.access_token}` } })).statusCode, 401);
  const self = await withPublicFetch({}, () => app.inject({ method: "POST", url: "/api/agent/selfcheck", headers: session }));
  assert.equal(self.statusCode, 200);
});

test("连接自检：没填公网地址时只说这一句（不出网）", async () => {
  patchAppSettings({ agent: { enabled: true, publicBaseUrl: "" } });
  const res = await app.inject({ method: "POST", url: "/api/agent/selfcheck", headers: session });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().items.map((i: { name: string; ok: boolean }) => [i.name, i.ok]), [["公网地址", false]]);
});

/** 模拟的公网出口：自检请求经过「本机反代」时，反代往 X-Forwarded-For 里追加的就是它 */
const EGRESS = "203.0.113.10";

interface PublicFetchOptions {
  /** 反代怎么转：默认往 X-Forwarded-For 里追加来源；passthrough 原样转客户端带的；lose 请求被别的机器接走（标记带不回来） */
  proxy?: "append" | "passthrough" | "lose";
  /** 这个路径直接回它，不进 OpenStrm（模拟被 Access 挡住） */
  intercept?: (path: string) => Response | null;
  /** 这个路径连不上 */
  unreachable?: (path: string) => boolean;
  /** 公网地址的源，默认 PUBLIC */
  origin?: string;
}

/**
 * 连接自检是服务器自己去请求公网地址：测试里把发往公网地址的 fetch 接到 app.inject 上（Host 用公网域名），
 * 前面模拟一层本机反代（对端 127.0.0.1）；TRUST_PROXY 按 true 算，和应用的 trustProxy 一致
 */
async function withPublicFetch<T>(opts: PublicFetchOptions, fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const trustProxy = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "true";
  const origin = opts.origin ?? PUBLIC;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) throw new Error(`自检不该请求别的地址：${url.href}`);
    if (opts.unreachable?.(url.pathname)) throw new TypeError("fetch failed");
    const intercepted = opts.intercept?.(url.pathname);
    if (intercepted) return intercepted;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    if (opts.proxy === "lose") delete headers[SOURCE_PROBE_HEADER];
    if (opts.proxy !== "passthrough") headers["x-forwarded-for"] = headers["x-forwarded-for"] ? `${headers["x-forwarded-for"]}, ${EGRESS}` : EGRESS;
    const res = await app.inject({
      method: (init.method ?? "GET") as "GET" | "POST",
      url: url.pathname + url.search,
      headers: { ...headers, host: url.host },
      payload: typeof init.body === "string" ? init.body : undefined,
      remoteAddress: "127.0.0.1",
    });
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v !== undefined && k !== "content-length" && k !== "transfer-encoding") out.set(k, Array.isArray(v) ? v.join(", ") : String(v));
    }
    return new Response(res.body, { status: res.statusCode, headers: out });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (trustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = trustProxy;
  }
}

async function selfCheck(): Promise<AgentSelfCheckItem[]> {
  const res = await app.inject({ method: "POST", url: "/api/agent/selfcheck", headers: session });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().items as AgentSelfCheckItem[];
}

const verdicts = (items: AgentSelfCheckItem[]) => items.map((i) => [i.name, i.ok, i.warn === true]);
const source = (items: AgentSelfCheckItem[]) => items.find((i) => i.name === "来源地址（TRUST_PROXY）");

test("连接自检（只放行智能体路径）：元数据、/mcp、来源地址都通；管理界面和 /api 从公网地址 404（顺带提醒开关）", async () => {
  const items = await withPublicFetch({}, selfCheck);
  assert.deepEqual(verdicts(items), [
    ["受保护资源元数据", true, false],
    ["授权服务器元数据", true, false],
    ["MCP 地址", true, false],
    ["来源地址（TRUST_PROXY）", true, false],
    ["管理界面不在公网上", true, false],
    ["管理接口不在公网上", true, false],
  ]);
  assert.match(source(items)!.detail, new RegExp(`${EGRESS.replace(/\./g, "\\.")}.*配得对`));
  assert.match(items[4].detail, /这个域名也用来打开管理界面/);
});

test("连接自检（共用域名）：管理界面那两条换成一条加固建议，点名是哪个域名", async () => {
  patchAppSettings({ agent: { enabled: true, publicBaseUrl: PUBLIC, publicServesUi: true } });
  invalidatePublicHost();
  const items = await withPublicFetch({}, selfCheck);
  assert.deepEqual(verdicts(items), [
    ["受保护资源元数据", true, false],
    ["授权服务器元数据", true, false],
    ["MCP 地址", true, false],
    ["来源地址（TRUST_PROXY）", true, false],
    ["管理界面在公网上（共用域名）", true, false],
  ]);
  assert.match(items.at(-1)!.detail, /mcp\.example\.com 也能打开管理界面/);
  assert.match(items.at(-1)!.detail, /\/oauth\/token/, "加固建议里列出身份代理要放行的路径");
});

test("连接自检的来源地址：反代原样透传 X-Forwarded-For 报「能伪造」；请求没到这台机器报出来；两次自检同时跑各算各的", async () => {
  const passthrough = source(await withPublicFetch({ proxy: "passthrough" }, selfCheck));
  assert.equal(passthrough?.ok, false);
  assert.match(passthrough!.detail, /原样转了过来.*proxy_add_x_forwarded_for/);
  const lost = source(await withPublicFetch({ proxy: "lose" }, selfCheck));
  assert.equal(lost?.ok, false);
  assert.match(lost!.detail, /没到这台 OpenStrm/);
  const both = await withPublicFetch({}, () => Promise.all([selfCheck(), selfCheck()]));
  for (const items of both) assert.equal(source(items)?.ok, true);
});

test("连接自检：被 Cloudflare Access 挡住直接说是它，不再单出来源一项；/mcp 连不上也不出来源一项；公网地址带端口提醒 443", async () => {
  const access = () => new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/mcp.example.com" } });
  const blocked = await withPublicFetch({ intercept: (path) => (path === "/mcp" || path.startsWith("/.well-known/") ? access() : null) }, selfCheck);
  for (const name of ["受保护资源元数据", "授权服务器元数据", "MCP 地址"]) {
    const item = blocked.find((i) => i.name === name)!;
    assert.equal(item.ok, false, name);
    assert.match(item.detail, /Cloudflare Access.*Bypass/, name);
  }
  assert.equal(source(blocked), undefined, "/mcp 那一项已经说了原因");

  const down = await withPublicFetch({ unreachable: (path) => path === "/mcp" }, selfCheck);
  assert.match(down.find((i) => i.name === "MCP 地址")!.detail, /访问不到/);
  assert.equal(source(down), undefined);

  const withPort = "https://mcp.example.com:8443";
  patchAppSettings({ agent: { enabled: true, publicBaseUrl: withPort } });
  invalidatePublicHost();
  const ported = await withPublicFetch({ origin: withPort }, selfCheck);
  assert.deepEqual(verdicts(ported).slice(0, 5), [
    ["公网地址的端口", true, true],
    ["受保护资源元数据", true, false],
    ["授权服务器元数据", true, false],
    ["MCP 地址", true, false],
    ["来源地址（TRUST_PROXY）", true, false],
  ]);
  assert.match(ported[0].detail, /:8443.*443/);
});

test("清理：久没用的 DCR / CIMD 客户端清掉；有授权挂着、有授权请求在走的留着", async () => {
  const withGrant = (await fullFlow()).clientId;
  const withRequest = await registerClient();
  await authorize(authParams(withRequest).params);
  const idle = await registerClient();
  db.insert(oauthClients).values({ id: "https://old.example/client.json", kind: "cimd", name: "old", redirectUris: "[]", fetchedAt: nowS() - 40 * 86400 }).run();
  db.update(oauthClients).set({ createdAt: nowS() - 40 * 86400, lastUsedAt: null }).run();
  assert.equal(deleteStaleOAuthClients(nowS() - 30 * 86400), 2);
  const left = db.select().from(oauthClients).all().map((r) => r.id);
  assert.ok(left.includes(withGrant));
  assert.ok(left.includes(withRequest));
  assert.ok(!left.includes(idle));
});

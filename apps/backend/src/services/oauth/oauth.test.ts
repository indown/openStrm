/**
 * OAuth 里不经过 HTTP 就能钉住的规矩：回调地址收哪些、怎么比、参数怎么接；CIMD 地址和文档的校验、不去请求内网地址；
 * 给的档位怎么算；地址、主机名、配对码怎么规范化；连接自检的来源探针和 TRUST_PROXY 判断（按部署拓扑）；哪些回调能用授权页密码批准。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/oauth/oauth.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { trustProxyOption } from "../../lib/trust-proxy.js";
import { normalizePairingCode } from "../../db/repositories/oauth.js";
import { grantScopes, presetScopes } from "./authorize.js";
import { cacheSecondsFrom, cimdUrlProblem, isBlockedAddress, validateClientMetadata } from "./cimd.js";
import { normalizeHost, normalizeOrigin, sameResource } from "./config.js";
import { OAuthError } from "./errors.js";
import { isInsecureUri, isLoopbackUri, isTrustedRedirect, passwordApprovalAllowed, redirectUriMatches, redirectUriProblem, withParams } from "./redirect.js";
import { SOURCE_PROBE_HEADER, finishSourceProbe, judgeSource, noteSelfCheckProbe, startSourceProbe } from "./selfcheck.js";

test("回调地址：https、http（局域网）、桌面客户端的私有 scheme 都收；能执行脚本、读本地的 scheme 不收", () => {
  for (const ok of [
    "https://claude.ai/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "http://192.168.1.5:8080/oauth/clients/mcp:openstrm/callback",
    "http://127.0.0.1:33418/callback",
    "cursor://anysphere.cursor-retrieval/oauth/callback",
  ]) {
    assert.equal(redirectUriProblem(ok), null, ok);
  }
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "https://a.example/cb#frag", "https://user:pw@a.example/cb", "not a url", ""]) {
    const problem = redirectUriProblem(bad);
    assert.notEqual(problem, null, bad);
    assert.match(problem!.en, /^[\x20-\x7e]+$/, "回给客户端的说明只能是 ASCII");
  }
});

test("回调地址比对：完全一致；登记的是回环地址时端口可以不同（路径、查询串还得一样）", () => {
  const reg = ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:1234/cb", "http://localhost:9/cb?x=1"];
  assert.ok(redirectUriMatches(reg, "https://claude.ai/api/mcp/auth_callback"));
  assert.ok(!redirectUriMatches(reg, "https://claude.ai/api/mcp/auth_callback/"));
  assert.ok(redirectUriMatches(reg, "http://127.0.0.1:5555/cb"), "回环地址端口随便");
  assert.ok(!redirectUriMatches(reg, "http://127.0.0.1:5555/other"));
  assert.ok(redirectUriMatches(reg, "http://localhost:44/cb?x=1"));
  assert.ok(!redirectUriMatches(reg, "http://localhost:44/cb?x=2"));
  assert.ok(!redirectUriMatches(["http://192.168.1.5:8080/cb"], "http://192.168.1.5:8081/cb"), "局域网地址不是回环，端口得一样");
  assert.ok(!redirectUriMatches(reg, "https://127.0.0.1:5555/cb"), "放宽端口只对 http 的回环地址");
});

test("回调地址的提醒：公网上的 http 算明文；回环地址单独认；大写的 scheme 也认得出", () => {
  assert.equal(isInsecureUri("http://192.168.1.5/cb"), true);
  assert.equal(isInsecureUri("HTTP://evil.example/cb"), true, "不能靠大写绕过提醒");
  assert.equal(isInsecureUri("http://127.0.0.1:1/cb"), false);
  assert.equal(isInsecureUri("https://a.example/cb"), false);
  assert.equal(isLoopbackUri("http://[::1]:9/cb"), true);
  assert.equal(isLoopbackUri("http://localhost/cb"), true);
  assert.equal(isLoopbackUri("https://127.0.0.1/cb"), false);
});

test("往回调地址接参数：登记的查询串原样保留（%20 不改成 +、没值的参数不补 =）", () => {
  assert.equal(withParams("https://c.example/cb", { code: "a b", state: undefined, iss: "https://m.example" }), "https://c.example/cb?code=a%20b&iss=https%3A%2F%2Fm.example");
  assert.equal(withParams("https://c.example/cb?a=b%20c&flag", { code: "x" }), "https://c.example/cb?a=b%20c&flag&code=x");
  assert.equal(withParams("https://c.example/cb?", { code: "x" }), "https://c.example/cb?code=x");
  assert.equal(withParams("cursor://app/cb", { error: "access_denied" }), "cursor://app/cb?error=access_denied");
});

test("CIMD：内网、回环、链路本地、保留、内嵌 IPv4 的过渡地址一律不去请求（IPv4 映射的 IPv6 按里面那个算）", () => {
  for (const [addr, family] of [
    ["10.1.2.3", 4],
    ["127.0.0.1", 4],
    ["169.254.169.254", 4],
    ["172.20.0.5", 4],
    ["192.168.10.13", 4],
    ["100.64.1.1", 4],
    ["0.0.0.0", 4],
    ["198.18.0.5", 4],
    ["203.0.113.9", 4],
    ["::1", 6],
    ["fd00::1", 6],
    ["fe80::1", 6],
    ["::ffff:10.0.0.1", 6],
    ["::ffff:127.0.0.1", 6],
    ["::127.0.0.1", 6],
    ["2002:7f00:1::1", 6],
    ["64:ff9b:1::a00:1", 6],
    ["fec0::1", 6],
    ["2001::1", 6],
    ["2001:db8::1", 6],
    ["100::1", 6],
  ] as const) {
    assert.equal(isBlockedAddress(addr, family), true, addr);
  }
  for (const [addr, family] of [
    ["104.16.230.132", 4],
    ["8.8.8.8", 4],
    ["2606:4700::6810:e684", 6],
    ["2001:4860:4860::8888", 6],
    ["::ffff:8.8.8.8", 6],
  ] as const) {
    assert.equal(isBlockedAddress(addr, family), false, addr);
  }
});

test("CIMD 地址：https、有路径、默认端口、写域名；IP（各种写法）、单段主机名、. 和 .. 路径段一律不收", () => {
  assert.equal(cimdUrlProblem("https://chatgpt.com/oauth/client.json"), null);
  assert.equal(cimdUrlProblem("https://claude.ai/oauth/mcp-oauth-client-metadata"), null);
  for (const bad of [
    "http://chatgpt.com/oauth/client.json",
    "https://chatgpt.com/",
    "https://u:p@chatgpt.com/x",
    "https://chatgpt.com:8443/x.json",
    "https://127.0.0.1/x.json",
    "https://2130706433/x.json",
    "https://0x7f.0.0.1/x.json",
    "https://0177.0.0.1/x.json",
    "https://[::1]/x.json",
    "https://[::ffff:127.0.0.1]/x.json",
    "https://localhost/x.json",
    "https://intranet/x.json",
    "https://a.localhost/x.json",
    "https://a.example/x/../y.json",
    "https://a.example/./y.json",
    "https://a.example/x/%2e%2e/y.json",
  ]) {
    assert.notEqual(cimdUrlProblem(bad), null, bad);
  }
});

test("CIMD 文档：client_id 要和地址一致，回调地址合规、最多 10 个；共享密钥认证的不收，private_key_jwt（ChatGPT）照收", () => {
  const url = "https://client.example/meta.json";
  const doc = validateClientMetadata(url, { client_id: url, client_name: "示例", redirect_uris: ["https://client.example/cb"], logo_uri: "x".repeat(100) });
  assert.deepEqual(doc, { client_id: url, client_name: "示例", redirect_uris: ["https://client.example/cb"], scope: undefined }, "只留用得上的几样");

  // 2026-09-21 从 https://chatgpt.com/oauth/client.json 取到的原样
  const chatgpt = "https://chatgpt.com/oauth/client.json";
  const live = {
    client_id: chatgpt,
    client_uri: "https://chatgpt.com/",
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "ChatGPT",
    logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
    token_endpoint_auth_signing_alg: "RS256",
    jwks_uri: "https://chatgpt.com/oauth/jwks.json",
  };
  assert.equal(validateClientMetadata(chatgpt, live).client_name, "ChatGPT");

  const reject = (d: unknown) => assert.throws(() => validateClientMetadata(url, d), OAuthError);
  reject({ client_id: "https://evil.example/meta.json", redirect_uris: ["https://client.example/cb"] });
  reject({ client_id: url, redirect_uris: [] });
  reject({ client_id: url, redirect_uris: ["javascript:alert(1)"] });
  reject({ client_id: url, redirect_uris: Array.from({ length: 11 }, (_, i) => `https://client.example/cb${i}`) });
  reject({ client_id: url, redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "client_secret_basic" });
  reject({ client_id: url, redirect_uris: ["https://client.example/cb"], client_secret: "s" });
  reject(["not", "an", "object"]);
});

test("CIMD 缓存时长：按 Cache-Control，限在五分钟到一天", () => {
  assert.equal(cacheSecondsFrom(undefined), 86400);
  assert.equal(cacheSecondsFrom("public, max-age=3600"), 3600);
  assert.equal(cacheSecondsFrom("max-age=10"), 300);
  assert.equal(cacheSecondsFrom("max-age=999999"), 86400);
  assert.equal(cacheSecondsFrom("no-store"), 300);
});

test("给的档位 = 管理员选的 ∩ 客户端要的；客户端什么都没要就按管理员选的；「查看」总在", () => {
  assert.deepEqual(grantScopes("read run write offline_access", ["read", "run", "write"]), ["read", "run", "write"]);
  assert.deepEqual(grantScopes("read", ["read", "run", "write"]), ["read"], "客户端只要了查看，不多给");
  assert.deepEqual(grantScopes("", ["read", "run", "write"]), ["read", "run", "write"]);
  assert.deepEqual(grantScopes("openid profile", ["read", "run"]), ["read", "run"], "认不出的 scope 当没要");
  assert.deepEqual(grantScopes("write danger", ["run", "write", "danger"]), ["read", "write", "danger"]);
  assert.deepEqual(grantScopes("read run write danger", ["read", "run", "write"]), ["read", "run", "write"], "danger 要管理员勾了才给");
});

test("授权页 / Telegram 的档位只认 read 和 daily：原型上的名字（constructor 之类）不算", () => {
  assert.deepEqual(presetScopes("read"), ["read"]);
  assert.deepEqual(presetScopes("daily"), ["read", "run", "write"]);
  for (const bad of ["constructor", "toString", "__proto__", "hasOwnProperty", "full", ""]) assert.equal(presetScopes(bad), undefined, bad);
});

test("规范化：公网地址存成标准的源；主机名去端口、大小写、结尾的点；资源地址按规范写法比；配对码不分大小写和横线", () => {
  assert.equal(normalizeOrigin("https://MCP.Example.com:443/"), "https://mcp.example.com");
  assert.match(normalizeOrigin("https://媒体.example.com")!, /^https:\/\/xn--[a-z0-9-]+\.example\.com$/, "国际化域名转 punycode（HTTP 头里只能是 ASCII）");
  assert.equal(normalizeOrigin("http://mcp.example.com"), null);
  assert.equal(normalizeHost("MCP.example.com.:443"), "mcp.example.com");
  assert.equal(normalizeHost("[::1]:3000"), "[::1]");
  assert.equal(normalizeHost(""), null);
  assert.ok(sameResource("https://MCP.example.com:443/mcp/", "https://mcp.example.com/mcp"));
  assert.ok(!sameResource("https://mcp.example.com/other", "https://mcp.example.com/mcp"));
  assert.equal(normalizePairingCode("7f3k 9q2m"), "7F3K-9Q2M");
  assert.equal(normalizePairingCode("7F3K-9Q2M"), "7F3K-9Q2M");
  assert.equal(normalizePairingCode("0O1I-AAAA"), null, "不在字母表里的字符（0 O 1 I）");
  assert.equal(normalizePairingCode("7F3K-9Q2"), null);
});

/** 探针只看这几样：请求头、Fastify 认出的来源、直接连过来的那一端 */
const probeRequest = (headers: Record<string, string>, ip = "127.0.0.1", peer = "127.0.0.1") =>
  ({ headers, ip, socket: { remoteAddress: peer } }) as unknown as FastifyRequest;

test("连接自检的来源探针：只认自检登记过的标记；记下转发链、X-Real-IP、CF-Connecting-IP；先到的算数；取完就忘；一分钟没回来的清掉", () => {
  noteSelfCheckProbe(probeRequest({ [SOURCE_PROBE_HEADER]: "not-registered" }));
  assert.equal(finishSourceProbe("not-registered"), undefined, "别人带同名的头不记");

  const t0 = 1_000_000;
  const nonce = startSourceProbe(t0);
  noteSelfCheckProbe(
    probeRequest(
      { [SOURCE_PROBE_HEADER]: nonce, "x-forwarded-for": "192.0.2.1,  203.0.113.10 ,104.23.0.9", "x-real-ip": "203.0.113.10", "cf-connecting-ip": "203.0.113.10" },
      "104.23.0.9",
      "172.18.0.2",
    ),
  );
  noteSelfCheckProbe(probeRequest({ [SOURCE_PROBE_HEADER]: nonce }, "10.0.0.9", "10.0.0.9"));
  assert.deepEqual(
    finishSourceProbe(nonce),
    { ip: "104.23.0.9", peer: "172.18.0.2", xff: ["192.0.2.1", "203.0.113.10", "104.23.0.9"], realIp: "203.0.113.10", cfIp: "203.0.113.10" },
    "先到的算数，后来同标记的不覆盖",
  );
  assert.equal(finishSourceProbe(nonce), undefined, "取完就忘");

  const stale = startSourceProbe(t0);
  const fresh = startSourceProbe(t0 + 61_000);
  noteSelfCheckProbe(probeRequest({ [SOURCE_PROBE_HEADER]: stale }));
  assert.equal(finishSourceProbe(stale), undefined, "一分钟没回来的清掉，之后再来也不记");
  finishSourceProbe(fresh);
});

/**
 * 来源判断按部署拓扑一条条核：来源用真的 Fastify（trustProxy 取 TRUST_PROXY 的解析结果）算，探针记下，再判。
 * 自检的出口地址是 203.0.113.10，Cloudflare 的节点是 104.23.0.9；探针请求自己带着哨兵 192.0.2.1
 */
test("来源地址判断：按部署拓扑（反代追加 / 没追加 / 只带 X-Real-IP / Cloudflare 两层 / 信任过头 / 内网绕回 / 覆盖 XFF / 公网上的代理 / 地址列表漏了反代）", async () => {
  const cases: Array<{
    name: string;
    trust?: string;
    peer: string;
    xff?: string;
    realIp?: string;
    cfIp?: string;
    ok: boolean;
    warn?: boolean;
    detail: RegExp;
  }> = [
    { name: "反代追加、设了 true", trust: "true", peer: "172.18.0.2", xff: "192.0.2.1, 203.0.113.10", ok: true, detail: /203\.0\.113\.10.*配得对/ },
    { name: "反代追加、没设", peer: "172.18.0.2", xff: "192.0.2.1, 203.0.113.10", ok: false, detail: /没设 TRUST_PROXY.*TRUST_PROXY=true/ },
    { name: "IPv4 映射的对端", trust: "true", peer: "::ffff:172.18.0.2", xff: "192.0.2.1, 203.0.113.10", ok: true, detail: /配得对/ },
    { name: "反代原样透传、没设", peer: "172.18.0.2", xff: "192.0.2.1", ok: false, detail: /没把客户端地址加进 X-Forwarded-For.*172\.18\.0\.2/ },
    { name: "反代原样透传、设了 true（能伪造）", trust: "true", peer: "172.18.0.2", xff: "192.0.2.1", ok: false, detail: /原样转了过来.*能绕过去/ },
    { name: "只带 X-Real-IP、透传了 XFF", trust: "true", peer: "172.18.0.2", xff: "192.0.2.1", realIp: "203.0.113.10", ok: false, detail: /原样转了过来（它带的是 X-Real-IP/ },
    { name: "只带 X-Real-IP、XFF 被清掉", trust: "true", peer: "172.18.0.2", realIp: "203.0.113.10", ok: false, detail: /没把客户端地址加进 X-Forwarded-For（它带的是 X-Real-IP/ },
    { name: "Cloudflare → 反代，只信了反代", trust: "true", peer: "172.18.0.2", xff: "192.0.2.1, 203.0.113.10, 104.23.0.9", cfIp: "203.0.113.10", ok: false, detail: /104\.23\.0\.9.*中间一层代理（Cloudflare 的节点）.*TRUST_PROXY 写 2/ },
    { name: "Cloudflare → 反代，写 2", trust: "2", peer: "172.18.0.2", xff: "192.0.2.1, 203.0.113.10, 104.23.0.9", cfIp: "203.0.113.10", ok: true, detail: /配得对/ },
    { name: "只有一层却写 2（信任过头）", trust: "2", peer: "172.18.0.2", xff: "192.0.2.1, 203.0.113.10", ok: false, detail: /信任过头.*TRUST_PROXY=2.*只有一层反代/ },
    { name: "内网绕回来（NAT 回环）", trust: "true", peer: "172.18.0.2", xff: "192.0.2.1, 192.168.1.1", ok: true, warn: true, detail: /内网里绕回来.*192\.168\.1\.1/ },
    { name: "Cloudflare 之后被 $remote_addr 覆盖", trust: "true", peer: "172.18.0.2", xff: "104.23.0.9", cfIp: "203.0.113.10", ok: false, detail: /\$remote_addr/ },
    { name: "Cloudflare 直接连到端口、没设", peer: "104.23.0.9", xff: "192.0.2.1, 203.0.113.10", cfIp: "203.0.113.10", ok: false, detail: /它在公网上.*网段/ },
    { name: "地址列表里没有这个反代", trust: "10.9.9.9", peer: "172.18.0.2", xff: "192.0.2.1, 203.0.113.10", ok: false, detail: /TRUST_PROXY=10\.9\.9\.9，但没信任直接连过来的这一层（172\.18\.0\.2）.*TRUST_PROXY=true/ },
  ];
  const apps = new Map<string, FastifyInstance>();
  try {
    for (const c of cases) {
      const key = c.trust ?? "";
      let app = apps.get(key);
      if (!app) {
        app = Fastify({ trustProxy: trustProxyOption(c.trust) });
        app.addHook("onRequest", async (request) => noteSelfCheckProbe(request));
        app.post("/mcp", async () => ({}));
        await app.ready();
        apps.set(key, app);
      }
      const nonce = startSourceProbe();
      const headers: Record<string, string> = { [SOURCE_PROBE_HEADER]: nonce };
      if (c.xff) headers["x-forwarded-for"] = c.xff;
      if (c.realIp) headers["x-real-ip"] = c.realIp;
      if (c.cfIp) headers["cf-connecting-ip"] = c.cfIp;
      await app.inject({ method: "POST", url: "/mcp", headers, remoteAddress: c.peer });
      const seen = finishSourceProbe(nonce);
      assert.ok(seen, c.name);
      const verdict = judgeSource(seen, c.trust);
      assert.equal(verdict.ok, c.ok, `${c.name}：${verdict.detail}`);
      assert.equal(verdict.warn === true, c.warn === true, `${c.name}：${verdict.detail}`);
      assert.match(verdict.detail, c.detail, c.name);
    }
  } finally {
    for (const app of apps.values()) await app.close();
  }
});

test("密码批准只给授权码别人拿不到的回调：本机、局域网、桌面客户端、claude.ai / ChatGPT；手建的客户端都行；别的公网域名不行", () => {
  for (const uri of [
    "http://127.0.0.1:33418/callback",
    "http://localhost:6274/oauth/callback",
    "https://localhost/cb",
    "cursor://anysphere.cursor-retrieval/oauth/callback",
    "http://192.168.1.5:8080/oauth/clients/mcp:openstrm/callback",
    "http://[fd00::5]:8080/cb",
    "http://openwebui.lan:8080/cb",
    "http://nas:8080/cb",
    "https://claude.ai/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
  ]) {
    assert.equal(isTrustedRedirect(uri), true, uri);
    assert.equal(passwordApprovalAllowed("dcr", uri), true, uri);
  }
  for (const uri of [
    "https://claude-ai.attacker.example/api/mcp/auth_callback",
    "https://claude.ai.evil.example/cb",
    "http://claude.ai/api/mcp/auth_callback",
    "https://evil.example/cb",
    "http://203.0.113.5/cb",
    "not a url",
  ]) {
    assert.equal(isTrustedRedirect(uri), false, uri);
    assert.equal(passwordApprovalAllowed("dcr", uri), false, uri);
    assert.equal(passwordApprovalAllowed("cimd", uri), false, uri);
  }
  assert.equal(passwordApprovalAllowed("manual", "https://evil.example/cb"), true, "手建的客户端：回调是管理员自己登记的，换令牌还要密钥");
});

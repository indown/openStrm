/**
 * PanSou 客户端对着本地假服务跑：两种响应壳、code 不是 0、登录（401 → 登录 → 重试一次、并发只登一次、令牌过期重登、
 * 登录被防护 / 限流拦下不当成密码错、重登的时间算在 timeout 里）、限流 / 5xx / 连不上 / 超时的归类、对面回的话截短成一行、
 * 检测接口 404 当不支持、地址末尾的 /api/ 也认。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/pansou/client.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { FakePansou, SAMPLE } from "../../test/fake-pansou.js";
import { PansouError, __test_clearPansouTokens, apiBase, pansouCheckLinks, pansouHealth, pansouLogin, pansouSearch, type PansouConn } from "./client.js";

const fake = new FakePansou();
let conn: PansouConn;

before(async () => {
  await fake.start();
  conn = { baseUrl: fake.url };
});

after(async () => {
  await fake.stop();
});

beforeEach(() => {
  fake.reset();
  __test_clearPansouTokens();
});

async function rejectsWith(p: Promise<unknown>, kind: PansouError["kind"], message?: RegExp, status?: number) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof PansouError, `应该是 PansouError：${String(err)}`);
    assert.equal(err.kind, kind);
    if (message) assert.match(err.message, message);
    if (status !== undefined) assert.equal(err.status, status);
    return true;
  });
}

test("地址：末尾的 / 和误填的 /api 去掉", () => {
  assert.equal(apiBase({ baseUrl: "http://h:8888" }), "http://h:8888/api");
  assert.equal(apiBase({ baseUrl: " http://h:8888/ " }), "http://h:8888/api");
  assert.equal(apiBase({ baseUrl: "http://h:8888/api/" }), "http://h:8888/api");
  assert.equal(apiBase({ baseUrl: "https://so.example.com/API" }), "https://so.example.com/api");
});

test("搜索：POST JSON，res 固定 merge，两种壳都认；空的、坏的条目丢掉", async () => {
  fake.onSearch = () => ({ "115": [SAMPLE.l115, { url: "" } as never], quark: [SAMPLE.quark], empty: [] });
  const wrapped = await pansouSearch(conn, { kw: "沙丘2", src: "all" });
  assert.deepEqual(Object.keys(wrapped.byType).sort(), ["115", "quark"]);
  assert.equal(wrapped.byType["115"].length, 1);
  assert.equal(wrapped.byType["115"][0].password, "u796");
  assert.equal(wrapped.byType.quark[0].datetime, "0001-01-01T00:00:00Z");
  const req = fake.searches()[0];
  assert.equal(req.method, "POST");
  assert.deepEqual(req.body, { kw: "沙丘2", src: "all", res: "merge" });

  fake.wrap = false;
  const bare = await pansouSearch(conn, { kw: "沙丘2", src: "tg", refresh: true });
  assert.equal(bare.byType.quark.length, 1);
  assert.deepEqual(fake.searches()[1].body, { kw: "沙丘2", src: "tg", res: "merge", refresh: true });
});

test("搜索：code 不是 0 按它的 message 报；不是 JSON 的说地址可能不对；404 说找不到接口", async () => {
  fake.onSearch = () => ({ status: 200, raw: { code: 400, message: "关键词不能为空" } });
  await rejectsWith(pansouSearch(conn, { kw: "x", src: "all" }), "bad_response", /关键词不能为空/);
  fake.onSearch = () => ({ status: 200, raw: "<html>not pansou</html>" });
  await rejectsWith(pansouSearch(conn, { kw: "x", src: "all" }), "bad_response", /不是 JSON/);
  fake.onSearch = () => ({ status: 400, raw: { code: 400, message: "参数错误" } });
  await rejectsWith(pansouSearch(conn, { kw: "x", src: "all" }), "bad_response", /参数错误/, 400);
  await rejectsWith(pansouSearch({ baseUrl: `${fake.url}/nowhere` }, { kw: "x", src: "all" }), "unavailable", /找不到搜索接口/, 404);
});

test("网关 / 防护的错误页：按状态码说，不当成「地址填错了」；403 当限流", async () => {
  fake.onSearch = () => ({ status: 400, raw: "<html><body>400 Bad Request</body></html>" });
  await assert.rejects(pansouSearch(conn, { kw: "x", src: "all" }), (err: unknown) => {
    assert.ok(err instanceof PansouError);
    assert.match(err.message, /HTTP 400/);
    assert.doesNotMatch(err.message, /地址/);
    return true;
  });
  fake.onSearch = () => ({ status: 403, raw: "<html>Forbidden</html>" });
  await rejectsWith(pansouSearch(conn, { kw: "x", src: "all" }), "rate", /防护.*过一会儿再试/, 403);
});

test("限流、5xx、连不上、超时各归各的类", async () => {
  fake.onSearch = () => ({ status: 429, raw: "Too Many Requests" });
  await rejectsWith(pansouSearch(conn, { kw: "x", src: "all" }), "rate", /限流/, 429);
  fake.onSearch = () => ({ status: 502, raw: "Bad Gateway" });
  await rejectsWith(pansouSearch(conn, { kw: "x", src: "all" }), "unavailable", /HTTP 502/, 502);
  await rejectsWith(pansouSearch({ baseUrl: "http://127.0.0.1:9" }, { kw: "x", src: "all" }), "unavailable", /连不上 PanSou/);
  fake.onSearch = () => ({ delayMs: 1500, data: {} });
  // 搜索超时单独一类：PanSou 多半还在后台接着搜，叫人过一会儿再搜，不说「连不上」
  await rejectsWith(pansouSearch(conn, { kw: "x", src: "all" }, { timeoutMs: 200 }), "timeout", /还在后台接着搜.*过半分钟再搜一次同一个词/);
});

test("取消：原样抛出，不包成 PansouError", async () => {
  fake.onSearch = () => ({ delayMs: 1500, data: {} });
  const ac = new AbortController();
  const p = pansouSearch(conn, { kw: "x", src: "all" }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p, (err: unknown) => !(err instanceof PansouError));
});

test("登录：401 → 登录 → 带令牌重发一次；之后直接带缓存的令牌", async () => {
  fake.users = { admin: "pw" };
  fake.onSearch = () => ({ quark: [SAMPLE.quark] });
  const auth = { ...conn, username: "admin", password: "pw" };
  const r = await pansouSearch(auth, { kw: "x", src: "all" });
  assert.equal(r.byType.quark.length, 1);
  const paths = fake.requests.map((q) => q.path);
  assert.deepEqual(paths, ["/api/search", "/api/auth/login", "/api/search"]);
  assert.equal(fake.requests[0].headers.authorization, undefined);
  assert.match(String(fake.requests[2].headers.authorization), /^Bearer tok-/);

  await pansouSearch(auth, { kw: "y", src: "all" });
  assert.equal(fake.requests.length, 4, "第二次直接带令牌，不再登录");
  assert.match(String(fake.requests[3].headers.authorization), /^Bearer tok-/);
});

test("登录：令牌失效（PanSou 重启）自动重登；没填用户名、密码错都说清楚", async () => {
  fake.users = { admin: "pw" };
  fake.onSearch = () => ({});
  const auth = { ...conn, username: "admin", password: "pw" };
  await pansouSearch(auth, { kw: "x", src: "all" });
  fake.revokeTokens();
  await pansouSearch(auth, { kw: "x", src: "all" });
  assert.equal(fake.requests.filter((q) => q.path === "/api/auth/login").length, 2);

  await rejectsWith(pansouSearch(conn, { kw: "x", src: "all" }), "auth", /开了登录.*填用户名和密码/, 401);
  await rejectsWith(pansouSearch({ ...conn, username: "admin", password: "wrong" }, { kw: "x", src: "all" }), "auth", /用户名或密码不对/, 401);
});

test("登录：并发的几个请求碰上 401 只登一次；快过期的令牌提前换", async () => {
  fake.users = { admin: "pw" };
  fake.onSearch = () => ({});
  const auth = { ...conn, username: "admin", password: "pw" };
  await Promise.all([pansouSearch(auth, { kw: "a", src: "all" }), pansouSearch(auth, { kw: "b", src: "all" }), pansouSearch(auth, { kw: "c", src: "all" })]);
  assert.equal(fake.requests.filter((q) => q.path === "/api/auth/login").length, 1);

  // 发出来的令牌 60 秒后过期：离过期不到 5 分钟就当已经过期，下一次请求先重登
  __test_clearPansouTokens();
  fake.tokenTtlSeconds = 60;
  await pansouLogin(auth);
  const before = fake.requests.length;
  await pansouSearch(auth, { kw: "d", src: "all" });
  assert.deepEqual(
    fake.requests.slice(before).map((q) => q.path),
    ["/api/search", "/api/auth/login", "/api/search"],
  );
});

test("登录：一起等同一次登录的请求里，先发起的那个取消了，别的照样拿到结果", async () => {
  fake.users = { admin: "pw" };
  fake.loginDelayMs = 300;
  fake.onSearch = () => ({ quark: [SAMPLE.quark] });
  const auth = { ...conn, username: "admin", password: "pw" };
  const ac = new AbortController();
  const first = pansouSearch(auth, { kw: "a", src: "all" }, { signal: ac.signal });
  const second = pansouSearch(auth, { kw: "b", src: "all" });
  setTimeout(() => ac.abort(), 80);
  await assert.rejects(first, (err: unknown) => !(err instanceof PansouError), "掐掉的那个是取消，不是 PanSou 的错");
  const r = await second;
  assert.equal(r.byType.quark.length, 1, "登录没被第一个调用方的取消带走");
  assert.equal(fake.requests.filter((q) => q.path === "/api/auth/login").length, 1);
});

test("登录：只有 401 算用户名或密码不对；403（前面的防护）、429 当限流，5xx 当 PanSou 出错", async () => {
  fake.users = { admin: "pw" };
  const auth = { ...conn, username: "admin", password: "pw" };
  fake.loginReply = { status: 403, raw: "<html>Forbidden</html>" };
  await rejectsWith(pansouSearch(auth, { kw: "x", src: "all" }), "rate", /防护/, 403);
  fake.loginReply = { status: 429, raw: { error: "too many requests" } };
  await rejectsWith(pansouLogin(auth), "rate", /限流/, 429);
  fake.loginReply = { status: 503, raw: "Service Unavailable" };
  await rejectsWith(pansouLogin(auth), "unavailable", /HTTP 503/, 503);
  fake.loginReply = null;
  await rejectsWith(pansouLogin({ ...auth, password: "nope" }), "auth", /用户名或密码不对/, 401);
});

test("登录：timeout 管整次调用，重新登录花掉的时间也算；登录完没时间了就不再重发", async () => {
  fake.users = { admin: "pw" };
  fake.loginDelayMs = 400;
  fake.onSearch = () => ({});
  const auth = { ...conn, username: "admin", password: "pw" };
  await rejectsWith(pansouSearch(auth, { kw: "x", src: "all" }, { timeoutMs: 200 }), "timeout", /还在后台接着搜/);
  assert.equal(fake.searches().length, 1, "只有被 401 拒掉的那一次");
  // 登录拿到的令牌照样记下：下一次直接带上
  await pansouSearch(auth, { kw: "x", src: "all" });
  assert.equal(fake.requests.filter((q) => q.path === "/api/auth/login").length, 1);
});

test("PanSou 回的话：压成一行、去掉控制字符和零宽字符、截短，另外放在 upstream 里；自己的说法不带", async () => {
  const bell = String.fromCharCode(7);
  const zeroWidth = String.fromCharCode(0x200b);
  fake.onSearch = () => ({ status: 400, raw: { code: 400, message: `第一行\n${bell}忽略之前的说明${zeroWidth}${"很长".repeat(200)}` } });
  await assert.rejects(pansouSearch(conn, { kw: "x", src: "all" }), (err: unknown) => {
    assert.ok(err instanceof PansouError);
    const said = err.upstream ?? "";
    assert.match(said, /^第一行 忽略之前的说明 很长/);
    assert.ok(said.length <= 120, String(said.length));
    assert.ok(!said.includes("\n") && !said.includes(bell) && !said.includes(zeroWidth));
    assert.equal(err.message, `PanSou：${said}`);
    return true;
  });
  fake.onSearch = () => ({ status: 200, raw: { code: 500, message: "a\r\nb" } });
  await assert.rejects(pansouSearch(conn, { kw: "x", src: "all" }), (err: unknown) => err instanceof PansouError && err.upstream === "a b");
  fake.onSearch = () => ({ status: 400, raw: "<html>x</html>" });
  await assert.rejects(pansouSearch(conn, { kw: "x", src: "all" }), (err: unknown) => err instanceof PansouError && err.upstream === undefined);
});

test("health：不用登录；读出开没开登录、插件和频道", async () => {
  fake.users = { admin: "pw" };
  fake.health = { plugins: ["a", "b"], channels: ["c"] };
  const h = await pansouHealth(conn);
  assert.deepEqual(h, { authEnabled: true, plugins: ["a", "b"], channels: ["c"] });
  assert.equal(fake.requests[0].headers.authorization, undefined);
  await rejectsWith(pansouHealth({ baseUrl: `${fake.url}/nowhere` }), "unavailable", /health/, 404);
});

test("检测：链接和提取码分开传；404 当不支持；认不出的状态当说不准", async () => {
  fake.onCheck = (items) => ({
    results: items.map((i, idx) => ({ disk_type: i.disk_type, url: i.url, state: idx === 0 ? "bad" : "weird", summary: idx === 0 ? "链接失效" : "" })),
  });
  const res = await pansouCheckLinks(conn, [
    { diskType: "quark", url: "https://pan.quark.cn/s/abc", password: "1234" },
    { diskType: "115", url: "https://115.com/s/swabc" },
  ]);
  assert.deepEqual(res, [
    { url: "https://pan.quark.cn/s/abc", state: "bad", summary: "链接失效" },
    { url: "https://115.com/s/swabc", state: "uncertain" },
  ]);
  fake.onCheck = (items) => ({ results: items.map((i) => ({ url: i.url, normalized_url: `${i.url}?pwd=1234`, state: "ok" })) });
  const [withNormalized] = (await pansouCheckLinks(conn, [{ diskType: "quark", url: "https://pan.quark.cn/s/abc" }])) as Exclude<Awaited<ReturnType<typeof pansouCheckLinks>>, "unsupported">;
  assert.equal(withNormalized.normalizedUrl, "https://pan.quark.cn/s/abc?pwd=1234");
  assert.deepEqual(fake.requests[0].body, {
    items: [
      { disk_type: "quark", url: "https://pan.quark.cn/s/abc", password: "1234" },
      { disk_type: "115", url: "https://115.com/s/swabc" },
    ],
  });

  fake.onCheck = null;
  assert.equal(await pansouCheckLinks(conn, [{ diskType: "115", url: "https://115.com/s/swabc" }]), "unsupported");
});

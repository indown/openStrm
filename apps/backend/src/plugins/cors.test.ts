/**
 * 跨域按路径给：智能体用的几个路径对谁都开（浏览器里的 MCP 客户端要读 401 的 WWW-Authenticate）；
 * /api 不对外站开——不然随便一个网页都能借访客的浏览器试管理员密码；本机来源照开（开发用）。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/plugins/cors.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { corsDelegator, corsOptionsFor } from "./cors.js";

let app: FastifyInstance;

before(async () => {
  app = Fastify();
  await app.register(cors, { delegator: corsDelegator });
  app.post("/api/auth/login", async () => ({ token: "t" }));
  app.post("/mcp", async (_request, reply) => reply.code(401).header("www-authenticate", 'Bearer realm="OpenStrm"').send({ message: "unauthorized" }));
  app.post("/oauth/token", async () => ({ access_token: "a" }));
  await app.ready();
});

after(async () => {
  await app.close();
});

const EVIL = "https://evil.example";

test("路径和来源：智能体用的几个路径谁都开；/api 只对本机来源开", () => {
  for (const path of ["/mcp", "/oauth/token", "/oauth/register", "/oauth/revoke", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]) {
    assert.equal(corsOptionsFor(path, EVIL).origin, true, path);
  }
  for (const path of ["/api/auth/login", "/api/settings", "/oauth/authorize", "/oauth/authorize/status", "/oauth/authorize/password", "/", "/mcp/"]) {
    assert.equal(corsOptionsFor(path, EVIL).origin, false, path);
  }
  for (const origin of ["http://localhost:3222", "http://127.0.0.1:3000", "http://[::1]:5173", "https://localhost"]) {
    assert.equal(corsOptionsFor("/api/auth/login", origin).origin, true, origin);
  }
  assert.equal(corsOptionsFor("/api/auth/login", "http://localhost.evil.example").origin, false, "长得像 localhost 的不算");
  assert.equal(corsOptionsFor("/api/auth/login", undefined).origin, false);
});

test("别的网站跨域调登录：预检不放行（浏览器就不会发 JSON 登录请求），直接发也拿不到跨域许可", async () => {
  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/api/auth/login",
    headers: { origin: EVIL, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });
  assert.notEqual(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  const post = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: EVIL, "content-type": "application/json" }, payload: "{}" });
  assert.equal(post.headers["access-control-allow-origin"], undefined);
});

test("/mcp、/oauth/token：任何来源的预检都放行，401 的 WWW-Authenticate 明着放出来", async () => {
  for (const url of ["/mcp", "/oauth/token"]) {
    const preflight = await app.inject({ method: "OPTIONS", url, headers: { origin: EVIL, "access-control-request-method": "POST" } });
    assert.equal(preflight.statusCode, 204, url);
    assert.equal(preflight.headers["access-control-allow-origin"], EVIL, url);
  }
  const res = await app.inject({ method: "POST", url: "/mcp", headers: { origin: EVIL, "content-type": "application/json" }, payload: "{}" });
  assert.equal(res.headers["access-control-allow-origin"], EVIL);
  assert.match(String(res.headers["access-control-expose-headers"]), /WWW-Authenticate/i);
  assert.equal(res.headers["access-control-allow-credentials"], undefined, "不开 credentials");
});

test("本机来源（前端单独起开发服务器）调 /api 照常", async () => {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "http://localhost:3222", "content-type": "application/json" }, payload: "{}" });
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:3222");
});

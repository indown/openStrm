/**
 * 静态站点托管：页面文件映射、缓存头、404 兜底、目录穿越、/api 未知路由的 JSON 404。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/plugins/static-site.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { registerErrorHandling } from "./error-handler.js";
import staticSitePlugin from "./static-site.js";

let app: FastifyInstance;
let root: string;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstrm-static-"));
  fs.mkdirSync(path.join(root, "_next", "static"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), "<h1>index</h1>");
  fs.writeFileSync(path.join(root, "home.html"), "<h1>home</h1>");
  fs.writeFileSync(path.join(root, "404.html"), "<h1>nope</h1>");
  fs.writeFileSync(path.join(root, "logo.png"), "png");
  fs.writeFileSync(path.join(root, "_next", "static", "chunk.js"), "console.log(1)");

  app = Fastify();
  registerErrorHandling(app);
  app.get("/api/ping", async () => ({ pong: true }));
  await app.register(staticSitePlugin, { root });
  await app.ready();
});

after(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("/ → index.html，不长缓存", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /index/);
  assert.equal(res.headers["cache-control"], "no-cache");
});

test("/home → home.html：Next 导出的页面文件按路径名匹配", async () => {
  const res = await app.inject({ method: "GET", url: "/home" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /home/);
});

test("带查询串的页面同样命中", async () => {
  const res = await app.inject({ method: "GET", url: "/home?taskId=1" });
  assert.equal(res.statusCode, 200);
});

test("_next/static 下的文件永久缓存", async () => {
  const res = await app.inject({ method: "GET", url: "/_next/static/chunk.js" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["cache-control"]), /immutable/);
  assert.match(String(res.headers["content-type"]), /javascript/);
});

test("找不到的页面 → 404 + 404.html", async () => {
  const res = await app.inject({ method: "GET", url: "/does-not-exist" });
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /nope/);
});

test("目录穿越解析到 root 之外 → 404，不泄露任何文件", async () => {
  const res = await app.inject({ method: "GET", url: "/..%2f..%2f..%2fetc%2fpasswd" });
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /nope/);
});

test("API 路由不受影响，/api 下的未知路由仍是 JSON 404", async () => {
  const ok = await app.inject({ method: "GET", url: "/api/ping" });
  assert.deepEqual(ok.json(), { pong: true });
  const missing = await app.inject({ method: "GET", url: "/api/nope" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "NOT_FOUND");
});

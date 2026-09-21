/**
 * 通用安全头：页面（HTML）才加防嵌入（默认只许同源，FRAME_ANCESTORS 放开或收紧、写错的项跳过）；
 * 所有响应都有 nosniff、Referrer-Policy；路由自己设过的不覆盖（授权页那种更严的）；静态托管出的页面和 404 页也带上。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/plugins/security-headers.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { registerErrorHandling } from "./error-handler.js";
import { frameHeaders, securityHeadersPlugin } from "./security-headers.js";
import staticSitePlugin from "./static-site.js";

let root: string;
const apps: FastifyInstance[] = [];

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstrm-headers-"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>index</h1>");
  fs.writeFileSync(path.join(root, "404.html"), "<h1>nope</h1>");
  fs.writeFileSync(path.join(root, "logo.png"), "png");
});

after(async () => {
  for (const app of apps) await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** 和 index.ts 一样的顺序：错误处理 → 安全头 → 路由 → 静态托管 */
async function build(frameAncestors?: string): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandling(app);
  await app.register(securityHeadersPlugin, { frameAncestors });
  app.get("/api/ping", async () => ({ pong: true }));
  // 像授权页那样自己带更严的头
  app.get("/strict", async (_request, reply) =>
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("x-frame-options", "DENY")
      .header("referrer-policy", "no-referrer")
      .header("content-security-policy", "frame-ancestors 'none'")
      .send("<p>strict</p>"),
  );
  await app.register(staticSitePlugin, { root });
  await app.ready();
  apps.push(app);
  return app;
}

test("FRAME_ANCESTORS：没设只许同源；* 不限制；只写 'none' 谁都不许；写了地址就是 'self' 加上它们（空格、逗号都能分）", () => {
  const sameOrigin = { xFrameOptions: "SAMEORIGIN", csp: "frame-ancestors 'self'" };
  assert.deepEqual(frameHeaders(undefined), sameOrigin);
  assert.deepEqual(frameHeaders("  "), sameOrigin);
  assert.deepEqual(frameHeaders("*"), {});
  assert.deepEqual(frameHeaders("'none'"), { xFrameOptions: "DENY", csp: "frame-ancestors 'none'" });
  assert.deepEqual(frameHeaders("https://home.example.com, https://dash.example.com  http://192.168.1.5:7575 *.example.org https:"), {
    csp: "frame-ancestors 'self' https://home.example.com https://dash.example.com http://192.168.1.5:7575 *.example.org https:",
  });
});

test("FRAME_ANCESTORS 写错的项：记警告、跳过，不会让页面回 500；中文域名转 punycode；分号插不进新指令；'none' 混着写按 'none'", () => {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  assert.deepEqual(frameHeaders("https://媒体.example.com", warn), { csp: "frame-ancestors 'self' https://xn--tqqy7y.example.com" });
  const injected = frameHeaders("https://a.example;script-src", warn);
  assert.deepEqual(injected, { xFrameOptions: "SAMEORIGIN", csp: "frame-ancestors 'self'" }, "带分号的整项不认");
  assert.deepEqual(frameHeaders("javascript:alert(1) ftp://x.example garbage!!", warn), { xFrameOptions: "SAMEORIGIN", csp: "frame-ancestors 'self'" });
  assert.deepEqual(frameHeaders("'none' https://a.example", warn), { xFrameOptions: "DENY", csp: "frame-ancestors 'none'" });
  assert.equal(warnings.filter((m) => m.includes("跳过")).length, 4, warnings.join("\n"));
  assert.ok(warnings.some((m) => m.includes("'none' 只能单独写")));
});

test("默认：页面（含 404 页）只许同源嵌入；接口、图片不加防嵌入；nosniff、Referrer-Policy 都有", async () => {
  const app = await build();
  for (const url of ["/", "/does-not-exist"]) {
    const res = await app.inject({ method: "GET", url });
    assert.match(String(res.headers["content-type"]), /^text\/html/, url);
    assert.equal(res.headers["x-frame-options"], "SAMEORIGIN", url);
    assert.equal(res.headers["content-security-policy"], "frame-ancestors 'self'", url);
    assert.equal(res.headers["x-content-type-options"], "nosniff", url);
    assert.equal(res.headers["referrer-policy"], "strict-origin-when-cross-origin", url);
  }
  for (const url of ["/api/ping", "/logo.png", "/api/nope"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.headers["x-frame-options"], undefined, url);
    assert.equal(res.headers["content-security-policy"], undefined, url);
    assert.equal(res.headers["x-content-type-options"], "nosniff", url);
    assert.equal(res.headers["referrer-policy"], "strict-origin-when-cross-origin", url);
  }
});

test("路由自己设过的不覆盖：授权页那种更严的头原样保留", async () => {
  const res = await (await build()).inject({ method: "GET", url: "/strict" });
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(res.headers["content-security-policy"], "frame-ancestors 'none'");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
});

test("FRAME_ANCESTORS 写中文域名：页面照常 200（以前每个 HTML 响应都抛 ERR_INVALID_CHAR 回 500）", async () => {
  const res = await (await build("https://媒体.example.com")).inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-security-policy"], "frame-ancestors 'self' https://xn--tqqy7y.example.com");
});

test("FRAME_ANCESTORS 放开：写了地址只给 CSP（X-Frame-Options 写不了列表）；写 * 两个都不给", async () => {
  const listed = await (await build("https://home.example.com")).inject({ method: "GET", url: "/" });
  assert.equal(listed.headers["x-frame-options"], undefined);
  assert.equal(listed.headers["content-security-policy"], "frame-ancestors 'self' https://home.example.com");
  const any = await (await build("*")).inject({ method: "GET", url: "/" });
  assert.equal(any.headers["x-frame-options"], undefined);
  assert.equal(any.headers["content-security-policy"], undefined);
  assert.equal(any.headers["x-content-type-options"], "nosniff");
});

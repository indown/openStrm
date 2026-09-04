/**
 * 钉住错误壳：HttpError 原样透出 status + { message, ...extra }；自己永远不回 502 / 504
 * （Cloudflare 会把源站的这两个码换成它自己的错误页，message 到不了浏览器）；业务 5xx 记一条 warn 带原话。
 *
 *   pnpm test:file src/plugins/error-handler.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import pino from "pino";
import Fastify from "fastify";
import { HttpError, upstreamError } from "../lib/http-error.js";
import { registerErrorHandling } from "./error-handler.js";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      for (const l of chunk.toString().split("\n")) if (l.trim()) lines.push(JSON.parse(l));
      cb();
    },
  });
  return { lines, logger: pino({}, dest) };
}

async function build() {
  const { lines, logger } = capture();
  const app = Fastify({ loggerInstance: logger });
  registerErrorHandling(app);
  app.get("/upstream", async () => {
    throw upstreamError("115 接口返回 405: 访问被阻断", { upstreamStatus: 405, data: { big: true } });
  });
  app.get("/legacy-502", async () => {
    throw new HttpError(502, "bad gateway");
  });
  app.get("/legacy-504", async () => {
    throw new HttpError(504, "timeout");
  });
  app.get("/not-found", async () => {
    throw new HttpError(404, "没有这个", { code: "NOPE" });
  });
  app.get("/boom", async () => {
    throw new Error("kaboom");
  });
  return { app, lines };
}

test("上游错误：500 + { message, ...extra }，记一条 warn 带原话，data 不进日志", async () => {
  const { app, lines } = await build();
  const res = await app.inject({ method: "GET", url: "/upstream" });
  await app.close();
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { message: "115 接口返回 405: 访问被阻断", upstreamStatus: 405, data: { big: true } });
  const warn = lines.find((l) => l.level === 40 && l.msg === "115 接口返回 405: 访问被阻断");
  assert.ok(warn, "5xx 要记一条 warn");
  assert.equal(warn.status, 500);
  assert.equal(warn.upstreamStatus, 405);
  assert.equal("data" in warn, false);
});

test("HttpError 写了 502 / 504 也不会原样出去：对外改成 500，message 不变", async () => {
  const { app } = await build();
  for (const [url, message] of [
    ["/legacy-502", "bad gateway"],
    ["/legacy-504", "timeout"],
  ]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().message, message);
  }
  await app.close();
});

test("4xx 照旧透出、不记日志；没预料到的异常 500 记 error", async () => {
  const { app, lines } = await build();
  const nf = await app.inject({ method: "GET", url: "/not-found" });
  assert.equal(nf.statusCode, 404);
  assert.deepEqual(nf.json(), { message: "没有这个", code: "NOPE" });
  assert.equal(lines.some((l) => l.msg === "没有这个"), false);
  const boom = await app.inject({ method: "GET", url: "/boom" });
  await app.close();
  assert.equal(boom.statusCode, 500);
  assert.equal(boom.json().message, "kaboom");
  assert.ok(lines.some((l) => l.level === 50 && l.msg === "unhandled error"));
});

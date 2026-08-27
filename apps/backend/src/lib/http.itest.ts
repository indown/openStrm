/**
 * 错误壳与校验的闭环：所有失败响应都长一个样，前端只认 message。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/lib/http.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "./http-error.js";
import { parse } from "./validate.js";
import { registerErrorHandling } from "../plugins/error-handler.js";

let app: FastifyInstance;

before(async () => {
  app = Fastify();
  registerErrorHandling(app);
  app.post("/echo", async (request) => parse(z.object({ name: z.string().min(1), n: z.number().optional() }), request.body));
  app.get("/teapot", async () => {
    throw new HttpError(418, "short and stout", { code: "TEAPOT", hint: "x" });
  });
  app.get("/boom", async () => {
    throw new Error("kaboom");
  });
  await app.ready();
});

after(() => app.close());

test("校验失败 → 400，message 指向字段，issues 放在 details", async () => {
  const res = await app.inject({ method: "POST", url: "/echo", payload: { name: "", n: "x" } });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.match(body.message, /^name: /);
  assert.equal(body.code, "VALIDATION");
  assert.ok(Array.isArray(body.details) && body.details.length >= 2, "两个字段都该报出来");
});

test("没有 body 时按空对象校验，必填字段照样报缺失", async () => {
  const res = await app.inject({ method: "POST", url: "/echo" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /^name: /);
});

test("校验通过时拿到的是解析后的值", async () => {
  const res = await app.inject({ method: "POST", url: "/echo", payload: { name: "ok", extra: 1 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { name: "ok" }, "严格 object 会剥掉未声明的键");
});

test("HttpError 原样透出状态码、message 和附加字段", async () => {
  const res = await app.inject({ method: "GET", url: "/teapot" });
  assert.equal(res.statusCode, 418);
  assert.deepEqual(res.json(), { message: "short and stout", code: "TEAPOT", hint: "x" });
});

test("没预料到的异常 → 500，message 仍然给出去", async () => {
  const res = await app.inject({ method: "GET", url: "/boom" });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().message, "kaboom");
});

test("未知路由 → 404 同一个壳", async () => {
  const res = await app.inject({ method: "GET", url: "/nope" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, "NOT_FOUND");
  assert.match(res.json().message, /GET \/nope/);
});

test("坏 JSON → Fastify 的 400 也走同一个壳", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/json" },
    payload: "{not json",
  });
  assert.equal(res.statusCode, 400);
  assert.ok(typeof res.json().message === "string" && res.json().message.length > 0);
  assert.equal(res.json().error, undefined, "不该再出现 Fastify 默认的 error 字段");
});

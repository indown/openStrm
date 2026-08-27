/**
 * 钉住：AxiosError 进日志时不带 config/request/response——那里面是 115 的 Cookie 和
 * Telegram 的 bot token；普通 Error 照旧带 stack。
 *
 *   pnpm test:file src/lib/logger.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import pino from "pino";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import Fastify from "fastify";
import { serializeError } from "./logger.js";

function capture() {
  const lines: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: pino({ serializers: { err: serializeError } }, dest) };
}

const config = {
  method: "post",
  url: "/bot123456:SECRET-TOKEN/sendMessage?chat_id=1",
  baseURL: "https://api.telegram.org",
  headers: { Cookie: "UID=1;SEID=very-secret-cookie" },
} as unknown as InternalAxiosRequestConfig;

test("AxiosError 只留 message/code/status/method/url，url 去掉 token 和查询串", () => {
  const { lines, logger } = capture();
  const err = new AxiosError("Request failed with status code 500", "ERR_BAD_RESPONSE", config, {}, {
    status: 500,
    statusText: "Internal Server Error",
    headers: {},
    config,
    data: { ok: false, description: "leaked?" },
  });
  logger.error({ err }, "telegram sendMessage error");

  const line = lines.join("");
  assert.doesNotMatch(line, /SECRET-TOKEN/, "bot token 不能进日志");
  assert.doesNotMatch(line, /very-secret-cookie/, "Cookie 不能进日志");
  assert.doesNotMatch(line, /chat_id/, "查询串不要");
  assert.doesNotMatch(line, /leaked\?/, "响应体也不要");

  const { err: out } = JSON.parse(line);
  assert.deepEqual(out, {
    type: "AxiosError",
    message: "Request failed with status code 500",
    code: "ERR_BAD_RESPONSE",
    status: 500,
    method: "POST",
    url: "https://api.telegram.org/bot[redacted]/sendMessage",
  });
});

test("没有 response 的网络错误同样精简，url 解析不了就省略", () => {
  const { lines, logger } = capture();
  const err = new AxiosError("connect ECONNREFUSED", "ECONNREFUSED", {
    ...config,
    url: "not a url",
    baseURL: undefined,
  } as InternalAxiosRequestConfig);
  logger.error({ err }, "115 request failed");

  const { err: out } = JSON.parse(lines.join(""));
  assert.equal(out.code, "ECONNREFUSED");
  assert.equal(out.status, undefined);
  assert.equal(out.url, undefined);
  assert.doesNotMatch(lines.join(""), /very-secret-cookie/);
});

test("普通 Error 走 pino 默认序列化，stack 还在", () => {
  const { lines, logger } = capture();
  logger.error({ err: new Error("plain") }, "x");
  const { err: out } = JSON.parse(lines.join(""));
  assert.equal(out.type, "Error");
  assert.equal(out.message, "plain");
  assert.match(out.stack, /plain/);
});

test("Fastify 用这个实例时，request.log 和错误处理器里的 err 也经过同一个 serializer", async () => {
  const { lines, logger } = capture();
  const app = Fastify({ loggerInstance: logger });
  app.get("/", async () => {
    throw new AxiosError("boom", "ECONNRESET", config);
  });
  app.setErrorHandler((err, request, reply) => {
    request.log.error({ err }, "handled");
    reply.code(502).send({ message: "bad gateway" });
  });
  await app.inject({ method: "GET", url: "/" });
  await app.close();

  const handled = lines.map((l) => JSON.parse(l)).find((j) => j.msg === "handled");
  assert.ok(handled, "应当记了一条 handled");
  assert.equal(handled.err.type, "AxiosError");
  assert.equal(handled.err.url, "https://api.telegram.org/bot[redacted]/sendMessage");
  assert.doesNotMatch(lines.join(""), /SECRET-TOKEN|very-secret-cookie/);
});

/**
 *   pnpm test:file src/services/tmdb.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tmdbRetryAfterMs, tmdbRetryable } from "./tmdb.js";

/** 造一个 axios 形状的错误：isAxiosError 是 axios.isAxiosError 唯一认的标记 */
function axiosError(status?: number, headers: Record<string, unknown> = {}): Error {
  const err = new Error(status ? `Request failed with status code ${status}` : "connect ETIMEDOUT") as Error & {
    isAxiosError: boolean;
    response?: { status: number; headers: Record<string, unknown> };
  };
  err.isAxiosError = true;
  if (status !== undefined) err.response = { status, headers };
  return err;
}

test("值得重试的：429 / 5xx / 压根没拿到响应", () => {
  assert.equal(tmdbRetryable(axiosError(429)), true);
  assert.equal(tmdbRetryable(axiosError(500)), true);
  assert.equal(tmdbRetryable(axiosError(503)), true);
  assert.equal(tmdbRetryable(axiosError()), true, "超时 / 断网没有 response");
});

test("换多少次都一样的：401 / 404，以及不是 axios 的错", () => {
  assert.equal(tmdbRetryable(axiosError(401)), false);
  assert.equal(tmdbRetryable(axiosError(404)), false);
  assert.equal(tmdbRetryable(axiosError(400)), false);
  assert.equal(tmdbRetryable(new Error("自己代码里的 bug")), false);
  assert.equal(tmdbRetryable(null), false);
});

test("Retry-After：秒数照听，长的截断而不是丢掉", () => {
  assert.equal(tmdbRetryAfterMs(axiosError(429, { "retry-after": "5" })), 5000);
  assert.equal(tmdbRetryAfterMs(axiosError(429, { "retry-after": "0.5" })), 500);
  assert.equal(
    tmdbRetryAfterMs(axiosError(429, { "retry-after": "600" })),
    120_000,
    "十分钟截到两分钟，不能当没看见——丢掉的话调用方一两秒就重试，正撞在冷却期里",
  );
});

test("Retry-After：HTTP-date 也认（它自带逗号，不能当重复头去切）", () => {
  const at = new Date(Date.now() + 30_000).toUTCString();
  const ms = tmdbRetryAfterMs(axiosError(429, { "retry-after": at }));
  assert.ok(ms !== null && ms > 25_000 && ms <= 31_000, `该解析成 30s 上下，实际 ${ms}`);
  // 过去的时间点 = 现在就能重试
  assert.equal(tmdbRetryAfterMs(axiosError(429, { "retry-after": new Date(Date.now() - 1000).toUTCString() })), null);
});

test("Retry-After：重复头被拼成逗号列表时取第一个；数组形态也认", () => {
  assert.equal(tmdbRetryAfterMs(axiosError(429, { "retry-after": "10, 10" })), 10_000);
  assert.equal(tmdbRetryAfterMs(axiosError(429, { "retry-after": ["7", "9"] })), 7000);
});

test("Retry-After：没有 / 读不懂 / 非正数都交回给调用方自己的退避", () => {
  assert.equal(tmdbRetryAfterMs(axiosError(429)), null);
  assert.equal(tmdbRetryAfterMs(axiosError(429, { "retry-after": "" })), null);
  assert.equal(tmdbRetryAfterMs(axiosError(429, { "retry-after": "一会儿" })), null);
  assert.equal(tmdbRetryAfterMs(axiosError(429, { "retry-after": "0" })), null);
  assert.equal(tmdbRetryAfterMs(axiosError(429, { "retry-after": "-5" })), null);
  assert.equal(tmdbRetryAfterMs(new Error("不是 axios")), null);
});

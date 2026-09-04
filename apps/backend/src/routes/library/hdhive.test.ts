/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/library/hdhive.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { hdhiveError } from "./hdhive.js";

const failure = (status: number | undefined, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { status, ...extra });

test("上游 401/403 变成 500，原状态码放进 upstreamStatus——别让前端把它当会话失效", () => {
  for (const s of [401, 403]) {
    const e = hdhiveError(failure(s, "invalid api key"), "搜索失败");
    assert.equal(e.status, 500);
    assert.equal(e.extra.upstreamStatus, s);
    assert.match(e.message, /HDHive 拒绝了当前的 API Key/);
    assert.match(e.message, /invalid api key/);
  }
});

test("其它上游状态码原样透传，限流带 retry_after_seconds", () => {
  const e = hdhiveError(failure(429, "too many", { retryAfterSeconds: 30, code: "RATE_LIMITED" }), "x");
  assert.equal(e.status, 429);
  assert.equal(e.extra.retry_after_seconds, 30);
  assert.equal(e.extra.code, "RATE_LIMITED");
  assert.equal(e.extra.upstreamStatus, 429);
});

test("HDHive 自己的 5xx 也不透传：一律 500，原状态码放 upstreamStatus（源站回 502 会被 Cloudflare 换成它的错误页）", () => {
  for (const s of [500, 502, 503, 504]) {
    const e = hdhiveError(failure(s, "upstream down"), "x");
    assert.equal(e.status, 500);
    assert.equal(e.extra.upstreamStatus, s);
    assert.equal(e.message, "upstream down");
  }
});

test("没有状态码（网络错误）→ 500，用兜底文案", () => {
  const e = hdhiveError(new Error(""), "HDHive 不可用", { hint: 1 });
  assert.equal(e.status, 500);
  assert.equal(e.message, "HDHive 不可用");
  assert.deepEqual(e.extra.data, { hint: 1 });
});

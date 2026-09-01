/**
 * isAbortError 要认得中止的三种样子：signal.throwIfAborted() 的 DOMException、
 * timers/promises 的 AbortError、axios 的 CanceledError；普通错误、PermanentError、超时不算。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/lib/errors.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AxiosError, CanceledError } from "axios";
import { isAbortError, PermanentError } from "./errors.js";

test("throwIfAborted 的 DOMException、timers/promises 的 AbortError、axios 的 CanceledError 都算中止", async () => {
  const ac = new AbortController();
  ac.abort();
  assert.equal(isAbortError(ac.signal.reason), true, "DOMException AbortError");
  const fromSleep = await sleep(1000, undefined, { signal: ac.signal }).then(() => null, (e: unknown) => e);
  assert.equal(isAbortError(fromSleep), true, "timers/promises 的 AbortError");
  assert.equal(isAbortError(new CanceledError("canceled")), true, "axios CanceledError");
});

test("普通错误、PermanentError、axios 超时不算中止", () => {
  assert.equal(isAbortError(new Error("boom")), false);
  assert.equal(isAbortError(new PermanentError("not found")), false);
  assert.equal(isAbortError(new AxiosError("timeout of 30000ms exceeded", "ECONNABORTED")), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError("AbortError"), false);
});

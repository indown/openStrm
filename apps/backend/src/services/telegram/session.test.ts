/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/telegram/session.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { __test_clearPending, createPending, takePending } from "./session.js";

test("token 只能取走一次，且带回发起人和会话", () => {
  __test_clearPending();
  const token = createPending(-100, 42, { kind: "offline", urls: ["magnet:?xt=urn:btih:a"] });
  assert.match(token, /^[\w-]{8}$/);
  const p = takePending(token);
  assert.equal(p?.chatId, "-100");
  assert.equal(p?.userId, 42);
  assert.equal(p?.action.kind, "offline");
  assert.equal(takePending(token), null, "第二次取不到");
  assert.equal(takePending("nope"), null);
});

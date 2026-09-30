/**
 *   pnpm test:file src/services/notify.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { notify, registerNotifySink, type NotifyEvent } from "./notify.js";

const event: NotifyEvent = { type: "update-available", version: "2.0.0", current: "1.0.0", url: "https://example.invalid" };

test("没登记渠道：什么也不发，回 false", async () => {
  assert.equal(await notify(event), false);
});

test("登记的渠道都收到；任一渠道发出去就算发了；注销后不再收", async () => {
  const got: string[] = [];
  const offA = registerNotifySink(async (ev) => {
    got.push(`a:${ev.type}`);
    return false;
  });
  const offB = registerNotifySink(async (ev) => {
    got.push(`b:${ev.type}`);
    return true;
  });
  try {
    assert.equal(await notify(event), true);
    assert.deepEqual(got, ["a:update-available", "b:update-available"]);
    offB();
    got.length = 0;
    assert.equal(await notify(event), false, "剩下的渠道说没发");
    assert.deepEqual(got, ["a:update-available"]);
  } finally {
    offA();
    offB();
  }
});

test("渠道抛错只记日志：别的渠道照发，调用方拿到的还是发没发", async () => {
  const off1 = registerNotifySink(async () => {
    throw new Error("渠道炸了");
  });
  const off2 = registerNotifySink(async () => true);
  try {
    assert.equal(await notify(event), true);
  } finally {
    off1();
    off2();
  }
});

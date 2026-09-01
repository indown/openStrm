/**
 * 启动阶段的等待：任务在 starting（拉远端目录树）时 waitForTaskStart 挂住，releaseTaskStart 时以启动结果落定；
 * 没在启动立刻返回；客户端断开（signal）也返回并把等待者摘掉。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/task/registry.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Subject, Subscription } from "rxjs";
import {
  getRunningTask,
  registerRunningTask,
  releaseTaskStart,
  reserveTaskStart,
  unregisterRunningTask,
  waitForTaskStart,
} from "./registry.js";

/** 30ms 内没落定就当还挂着 */
const settledOrPending = (p: Promise<unknown>) =>
  Promise.race([p.then(() => "settled" as const), new Promise<"pending">((r) => setTimeout(() => r("pending"), 30))]);

test("没在启动的任务：立刻返回 undefined", async () => {
  assert.equal(await waitForTaskStart("idle"), undefined);
});

test("启动中：挂住直到 releaseTaskStart，拿到启动结果；注册进 running 的能查到", async () => {
  assert.equal(reserveTaskStart("t1"), true);
  const wait = waitForTaskStart("t1");
  assert.equal(await settledOrPending(wait), "pending", "拉目录树期间应一直等");
  registerRunningTask("t1", { subject: new Subject(), subscription: new Subscription(), logs: [] });
  releaseTaskStart("t1", { status: 200, message: "3 files to download" });
  assert.deepEqual(await wait, { status: 200, message: "3 files to download" });
  assert.ok(getRunningTask("t1"), "起来了的任务 release 之后 running 里有");
  unregisterRunningTask("t1");
});

test("起不来：release 带失败结果，所有等待者拿到同一份，running 里没有它", async () => {
  reserveTaskStart("t2");
  const a = waitForTaskStart("t2");
  const b = waitForTaskStart("t2");
  releaseTaskStart("t2", { status: 500, message: "账号不存在：ghost" });
  assert.deepEqual(await a, { status: 500, message: "账号不存在：ghost" });
  assert.deepEqual(await b, { status: 500, message: "账号不存在：ghost" });
  assert.equal(getRunningTask("t2"), undefined);
  assert.equal(await waitForTaskStart("t2"), undefined, "启动阶段已结束，再等直接返回");
});

test("客户端断开：signal 中止后立刻返回 undefined，之后 release 没人再等", async () => {
  reserveTaskStart("t3");
  const ac = new AbortController();
  const wait = waitForTaskStart("t3", ac.signal);
  ac.abort();
  assert.equal(await wait, undefined);
  releaseTaskStart("t3", { status: 500, message: "x" });
  const already = new AbortController();
  already.abort();
  reserveTaskStart("t4");
  assert.equal(await waitForTaskStart("t4", already.signal), undefined, "已中止的 signal 不挂");
  releaseTaskStart("t4");
});

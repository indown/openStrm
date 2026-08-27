/**
 *   pnpm test:file src/services/login-throttle.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoginThrottle } from "./login-throttle.js";

function make() {
  let t = 1_000_000;
  const throttle = createLoginThrottle({ maxFailures: 3, baseLockMs: 10_000, maxLockMs: 35_000, now: () => t });
  return { throttle, advance: (ms: number) => { t += ms; } };
}

test("阈值以下不锁", () => {
  const { throttle } = make();
  throttle.recordFailure("ip");
  throttle.recordFailure("ip");
  assert.equal(throttle.blockedFor("ip"), 0);
});

test("攒够次数锁定，锁定期内报剩余秒数，到点自动解锁", () => {
  const { throttle, advance } = make();
  for (let i = 0; i < 3; i++) throttle.recordFailure("ip");
  assert.equal(throttle.blockedFor("ip"), 10);
  advance(4_000);
  assert.equal(throttle.blockedFor("ip"), 6);
  advance(6_000);
  assert.equal(throttle.blockedFor("ip"), 0);
});

test("每锁一次时长翻倍，封顶", () => {
  const { throttle, advance } = make();
  const lock = () => { for (let i = 0; i < 3; i++) throttle.recordFailure("ip"); };
  lock(); assert.equal(throttle.blockedFor("ip"), 10); advance(10_000);
  lock(); assert.equal(throttle.blockedFor("ip"), 20); advance(20_000);
  lock(); assert.equal(throttle.blockedFor("ip"), 35, "10 → 20 → 40 被 35 封顶");
});

test("登录成功清零，包括翻倍计数", () => {
  const { throttle, advance } = make();
  for (let i = 0; i < 3; i++) throttle.recordFailure("ip");
  advance(10_000);
  throttle.recordSuccess("ip");
  for (let i = 0; i < 3; i++) throttle.recordFailure("ip");
  assert.equal(throttle.blockedFor("ip"), 10, "成功之后再锁应回到基础时长");
});

test("不同来源互不影响", () => {
  const { throttle } = make();
  for (let i = 0; i < 3; i++) throttle.recordFailure("a");
  assert.equal(throttle.blockedFor("a"), 10);
  assert.equal(throttle.blockedFor("b"), 0);
});

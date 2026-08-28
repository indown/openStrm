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

test("失败过一两次就停手的来源，闲置超过 maxLockMs 后桶被清掉——表不会无限增长", () => {
  const { throttle, advance } = make();
  // 1000 个来源各失败一次（以前的清理规则只清 failures 为 0 的桶，这些永远留着）
  for (let i = 0; i < 1000; i++) throttle.recordFailure(`ip-${i}`);
  advance(35_001);
  throttle.recordFailure("late"); // 表满了会触发清理

  // 没有公开 size，用行为验证：ip-0 的桶要是还在（failures=1），再失败两次就凑够 3 次被锁
  throttle.recordFailure("ip-0");
  throttle.recordFailure("ip-0");
  assert.equal(throttle.blockedFor("ip-0"), 0, "旧桶应已清掉，计数从 0 重新开始");

  // 还没闲置够的桶要保留
  throttle.recordFailure("recent");
  advance(1_000);
  for (let i = 0; i < 1000; i++) throttle.recordFailure(`other-${i}`);
  throttle.recordFailure("recent");
  throttle.recordFailure("recent");
  assert.equal(throttle.blockedFor("recent"), 10, "1 秒前失败过的桶不该被清");
});

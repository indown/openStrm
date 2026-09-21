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

test("begin 先占位子：同时打进来的一批比对，最多放进 maxFailures 个，全失败就锁", () => {
  const { throttle } = make();
  const admitted = [0, 1, 2, 3, 4].map(() => throttle.begin("ip"));
  assert.deepEqual(admitted, [0, 0, 0, 1, 1], "第 4、5 个要等前面的出结果");
  for (let i = 0; i < 3; i++) throttle.end("ip", false);
  assert.equal(throttle.blockedFor("ip"), 10, "放进来的 3 个都失败，锁上");
  assert.equal(throttle.begin("ip"), 10, "锁着时 begin 直接报剩余秒数");
});

test("end：成功清零；中途出错只还位子，不算失败", () => {
  const { throttle } = make();
  throttle.begin("ip");
  throttle.end("ip");
  for (let i = 0; i < 3; i++) assert.equal(throttle.begin("ip"), 0, "出错还回来的位子能再用");
  throttle.end("ip", false);
  throttle.end("ip", false);
  throttle.end("ip", true);
  assert.equal(throttle.blockedFor("ip"), 0);
  assert.equal(throttle.begin("ip"), 0, "成功后从头算");
});

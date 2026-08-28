/**
 *   pnpm test:file src/lib/async.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLimit } from "./async.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("同时在跑的不超过 limit，结果按输入顺序", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick(n * 5);
    inFlight--;
    return n * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
});

test("空输入直接返回；limit 大于条数也只起条数个 worker", async () => {
  assert.deepEqual(await mapLimit([], 8, async () => 1), []);
  let calls = 0;
  await mapLimit([1, 2], 8, async () => { calls++; });
  assert.equal(calls, 2);
});

test("某一项抛出就整体 reject", async () => {
  await assert.rejects(
    mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
    }),
    /boom/,
  );
});

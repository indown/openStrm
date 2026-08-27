/**
 *   pnpm test:file src/services/task/log-batch.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { LogBatcher } from "./log-batch.js";

test("攒够 maxLines 行立刻落一次，不满的等 maxDelayMs", async () => {
  const batches: string[][] = [];
  const b = new LogBatcher((lines) => batches.push(lines), { maxLines: 3, maxDelayMs: 30 });
  b.push("1");
  b.push("2");
  assert.deepEqual(batches, [], "没攒够也没到时间，不该写");
  b.push("3");
  assert.deepEqual(batches, [["1", "2", "3"]]);

  b.push("4");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(batches, [["1", "2", "3"], ["4"]], "到时间了要把零头写掉");
});

test("flush 立刻写掉零头并取消计时器；空的 flush 不写", async () => {
  const batches: string[][] = [];
  const b = new LogBatcher((lines) => batches.push(lines), { maxLines: 100, maxDelayMs: 30 });
  b.push("a");
  b.flush();
  assert.deepEqual(batches, [["a"]]);
  b.flush();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(batches, [["a"]], "flush 过之后计时器不该再触发一次空写");
});

test("顺序保持：每批内部和批与批之间都按 push 顺序", () => {
  const seen: string[] = [];
  const b = new LogBatcher((lines) => seen.push(...lines), { maxLines: 2, maxDelayMs: 1000 });
  for (let i = 0; i < 7; i++) b.push(String(i));
  b.flush();
  assert.deepEqual(seen, ["0", "1", "2", "3", "4", "5", "6"]);
});

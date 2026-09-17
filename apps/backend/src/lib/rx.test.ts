/**
 *   pnpm test:file src/lib/rx.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { lastValueFrom, take, toArray } from "rxjs";
import { forEachLimit, unrefTimer } from "./rx.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("unrefTimer：不给周期就发一张牌即结束；给了就按周期一直发", async () => {
  const once = await lastValueFrom(unrefTimer(5).pipe(toArray()));
  assert.deepEqual(once, [0]);
  const many = await lastValueFrom(unrefTimer(5, 5).pipe(take(3), toArray()));
  assert.deepEqual(many, [0, 1, 2]);
});

test("unrefTimer：退订之后不再发牌", async () => {
  let n = 0;
  const sub = unrefTimer(5, 5).subscribe(() => n++);
  await wait(30);
  sub.unsubscribe();
  const seen = n;
  assert.ok(seen >= 2, `该发了几张，实际 ${seen}`);
  await wait(30);
  assert.equal(n, seen);
});

test("unrefTimer：next 里被同步退订（take）之后不再自我续命", async () => {
  const real = globalThis.setTimeout;
  let armed = 0;
  // @ts-expect-error 测试里换掉计时器，数它被排了几次
  globalThis.setTimeout = (fn: () => void, ms?: number) => {
    armed++;
    return real(fn, ms);
  };
  try {
    await lastValueFrom(unrefTimer(5, 5).pipe(take(3), toArray()));
    const afterDone = armed;
    // 等的时候走原版计时器，不然把自己也数进去了
    await new Promise((r) => real(r, 100));
    assert.equal(armed, afterDone, `退订之后还在排定时器（多排了 ${armed - afterDone} 次）`);
  } finally {
    globalThis.setTimeout = real;
  }
});

test("forEachLimit：同时在跑的不超过 limit，每做完一个报一次数", async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  let inFlight = 0;
  let peak = 0;
  const ticks: Array<[number, number]> = [];
  await forEachLimit(
    items,
    3,
    async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await wait(10);
      inFlight--;
    },
    { onDone: (done, total) => ticks.push([done, total]) },
  );
  assert.equal(peak, 3);
  assert.equal(ticks.length, items.length);
  assert.deepEqual(ticks.at(-1), [8, 8]);
});

test("forEachLimit：signal 一掐就不再派新的，抛 AbortError", async () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const started: number[] = [];
  const abort = new AbortController();
  const run = forEachLimit(
    items,
    2,
    async (i) => {
      started.push(i);
      await wait(10);
      // 派出去第 4 个的时候掐掉，后面的都不该再开工
      if (started.length >= 4) abort.abort();
    },
    { signal: abort.signal },
  );
  await assert.rejects(run, (err: Error) => err.name === "AbortError");
  const startedWhenAborted = started.length;
  await wait(50);
  assert.equal(started.length, startedWhenAborted, "掐掉之后不该再有新的开工");
  assert.ok(startedWhenAborted < items.length, `50 个里只开工了 ${startedWhenAborted} 个`);
});

test("forEachLimit：空输入也认取消，别让掐掉的一轮以「顺利跑完」收场", async () => {
  await forEachLimit([], 4, async () => assert.fail("不该被调到"));
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    forEachLimit([], 4, async () => assert.fail("不该被调到"), { signal: abort.signal }),
    (err: Error) => err.name === "AbortError",
  );
});

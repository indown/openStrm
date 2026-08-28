/**
 * enqueueForAccount 的槽位必须在订阅方退订后也释放。
 *
 * request115 用 firstValueFrom 拿到第一个值就退订；teardown 把内层订阅退掉之后，
 * 内层紧接着的 complete 送不到订阅者，靠它 resolve 的限流器任务就永远不结束——
 * 一个账号默认 2 个槽，前两次请求正常，第三次起全部排队挂死（rc.9 的回归）。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/download/enqueue.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { firstValueFrom, Observable } from "rxjs";
import { clearRateLimiters, enqueueForAccount } from "./rate-limited.js";

const timeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}：${ms}ms 内没有完成`)), ms))]);

/** 模拟 request115 的内层：next 之后同步 complete */
const job = (value: number) =>
  new Observable<number>((observer) => {
    setTimeout(() => {
      observer.next(value);
      observer.complete();
    }, 5);
  });

test("firstValueFrom 只取第一个值就退订：槽位照样释放，后面的任务不会排队挂死", async () => {
  clearRateLimiters();
  const key = "enqueue-test:normal";
  const results: number[] = [];
  // 并发 1：只要有一个槽位泄漏，第二个任务就永远轮不到
  for (let i = 1; i <= 3; i++) {
    results.push(await timeout(firstValueFrom(enqueueForAccount(key, () => job(i), 1)), 2000, `第 ${i} 个任务`));
  }
  assert.deepEqual(results, [1, 2, 3]);
});

test("订阅方在任务开始后取消：内层被退订，槽位也释放", async () => {
  clearRateLimiters();
  const key = "enqueue-test:cancel";
  let torn = false;
  const hanging = () =>
    new Observable<number>(() => {
      return () => {
        torn = true;
      };
    });
  const sub = enqueueForAccount(key, hanging, 1).subscribe();
  await new Promise((r) => setTimeout(r, 20));
  sub.unsubscribe();
  assert.equal(torn, true, "取消要传到内层");
  assert.equal(await timeout(firstValueFrom(enqueueForAccount(key, () => job(9), 1)), 2000, "取消后的下一个任务"), 9);
});

test("还没排到就被取消的任务：轮到时直接放过，不执行", async () => {
  clearRateLimiters();
  const key = "enqueue-test:queued";
  let ran = 0;
  const slow = () =>
    new Observable<number>((observer) => {
      ran++;
      const t = setTimeout(() => {
        observer.next(1);
        observer.complete();
      }, 100);
      return () => clearTimeout(t);
    });
  const first = firstValueFrom(enqueueForAccount(key, slow, 1));
  const queued = enqueueForAccount(key, slow, 1).subscribe();
  queued.unsubscribe(); // 还在队列里就取消
  await timeout(first, 2000, "第一个任务");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran, 1, "排队时被取消的任务不该执行");
});

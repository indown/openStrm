/**
 * 账号限流器：槽位一定还得回来，三个设置值按账号、按通道生效。
 *
 * 槽位那几条的来历：request115 用 firstValueFrom 拿到第一个值就退订；teardown 把内层订阅退掉之后，
 * 内层紧接着的 complete 送不到订阅者，靠它 resolve 的限流器任务就永远不结束——
 * 一个账号默认 2 个槽，前两次请求正常，第三次起全部排队挂死（rc.9 的回归）。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/throttle.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { firstValueFrom, Observable } from "rxjs";
import { patchAppSettings } from "../db/repositories/settings.js";
import {
  applyThrottleSettings,
  enqueueForAccount,
  normalizeThrottle,
  paceIntervalMs,
  resetThrottle,
  scheduleForAccount,
} from "./throttle.js";

const ACCOUNT = "throttle-test";

const timeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}：${ms}ms 内没有完成`)), ms))]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 换一组限流设置，并丢掉按旧值建好的限流器 */
function useThrottle(requestsPerSecond: number, requestConcurrency: number, downloadConcurrency: number): void {
  patchAppSettings({ throttle: { requestsPerSecond, requestConcurrency, downloadConcurrency } });
  resetThrottle();
}

// 并发 1：只要有一个槽位泄漏，下一个任务就永远轮不到。每秒请求数放到最大，别让节奏掺进来
beforeEach(() => useThrottle(100, 1, 1));

/** 模拟 request115 的内层：next 之后同步 complete */
const job = (value: number) =>
  new Observable<number>((observer) => {
    setTimeout(() => {
      observer.next(value);
      observer.complete();
    }, 5);
  });

test("firstValueFrom 只取第一个值就退订：槽位照样释放，后面的任务不会排队挂死", async () => {
  const results: number[] = [];
  for (let i = 1; i <= 3; i++) {
    results.push(await timeout(firstValueFrom(enqueueForAccount(ACCOUNT, "download", () => job(i))), 2000, `第 ${i} 个任务`));
  }
  assert.deepEqual(results, [1, 2, 3]);
});

test("订阅方在任务开始后取消：内层被退订，槽位也释放", async () => {
  let torn = false;
  // 等内层真的开始了再取消：固定睡 20ms 在全量跑、机器忙的时候不够，任务还在排队就被取消，测的就成了另一条路
  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  const hanging = () =>
    new Observable<number>(() => {
      started();
      return () => {
        torn = true;
      };
    });
  const sub = enqueueForAccount(ACCOUNT, "download", hanging).subscribe();
  await timeout(startedP, 2000, "任务开始");
  sub.unsubscribe();
  assert.equal(torn, true, "取消要传到内层");
  assert.equal(await timeout(firstValueFrom(enqueueForAccount(ACCOUNT, "download", () => job(9))), 2000, "取消后的下一个任务"), 9);
});

test("还没排到就被取消的任务：轮到时直接放过，不执行", async () => {
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
  const first = firstValueFrom(enqueueForAccount(ACCOUNT, "download", slow));
  const queued = enqueueForAccount(ACCOUNT, "download", slow).subscribe();
  queued.unsubscribe(); // 还在队列里就取消
  await timeout(first, 2000, "第一个任务");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran, 1, "排队时被取消的任务不该执行");
});

test("scheduleForAccount：并发数生效，失败的任务也归还槽位", async () => {
  let running = 0;
  let peak = 0;
  const job = async (fail: boolean) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    if (fail) throw new Error("boom");
    return 1;
  };
  const results = await timeout(
    Promise.allSettled([
      scheduleForAccount(ACCOUNT, "normal", () => job(true)),
      scheduleForAccount(ACCOUNT, "normal", () => job(false)),
      scheduleForAccount(ACCOUNT, "normal", () => job(false)),
    ]),
    3000,
    "三个任务",
  );
  assert.equal(peak, 1, "并发 1 不能同时跑两个");
  assert.deepEqual(results.map((r) => r.status), ["rejected", "fulfilled", "fulfilled"]);
});

test("scheduleForAccount：轮到时 signal 已中止的任务不执行，直接拒绝", async () => {
  const ac = new AbortController();
  let ran = 0;
  const first = scheduleForAccount(ACCOUNT, "normal", () => new Promise<number>((r) => setTimeout(() => r(1), 30)));
  const queued = scheduleForAccount(ACCOUNT, "normal", async () => { ran++; return 2; }, ac.signal).then(
    () => "resolved",
    (err: Error) => err.name,
  );
  ac.abort(); // 还在队列里就中止
  assert.equal(await timeout(first, 2000, "第一个任务"), 1);
  assert.equal(await timeout(queued, 2000, "排队的任务"), "AbortError");
  assert.equal(ran, 0, "已中止的不该执行");
});

test("通道各有各的并发：接口并发和文件下载并发分开算，同一账号的监控通道不被普通请求占满", async () => {
  useThrottle(100, 1, 3);
  let running = 0;
  let peak = 0;
  const hold = async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 40));
    running--;
  };
  await timeout(Promise.all(Array.from({ length: 6 }, () => scheduleForAccount(ACCOUNT, "download", hold))), 3000, "六个下载");
  assert.equal(peak, 3, "download 通道按文件下载并发走");

  // normal 的唯一一个槽被占着时，life 通道照样发得出去
  let release!: () => void;
  const blocked = scheduleForAccount(ACCOUNT, "normal", () => new Promise<void>((r) => (release = r)));
  await timeout(scheduleForAccount(ACCOUNT, "life", async () => {}), 2000, "监控通道的请求");
  release();
  await blocked;
});

test("账号名里带冒号的两个账号各走各的节奏", async () => {
  // 每秒 1 个：共用一个节奏的话，第二个要等一秒
  useThrottle(1, 1, 1);
  const t0 = Date.now();
  await timeout(
    Promise.all([scheduleForAccount("a:1", "normal", async () => {}), scheduleForAccount("a:2", "normal", async () => {})]),
    3000,
    "两个账号各一个请求",
  );
  assert.ok(Date.now() - t0 < 500, `不该互相等，实际用了 ${Date.now() - t0}ms`);
});

test("匀速：请求一个一个按间隔发，闲了一阵之后来一批也不会一起出去", async () => {
  useThrottle(10, 5, 1); // 100ms 一个；并发放开，排队的只剩节奏
  const stamps: number[] = [];
  const fire = () => scheduleForAccount(ACCOUNT, "normal", async () => { stamps.push(Date.now()); });
  await fire();
  await sleep(250); // 闲两个多间隔：没用掉的不能攒着一起发
  stamps.length = 0;
  await timeout(Promise.all([fire(), fire(), fire(), fire()]), 3000, "四个请求");
  stamps.sort((a, b) => a - b);
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  // 定时器会晚不会早，前一个晚了后一个的间隔就短一点：留一半的余量
  assert.ok(gaps.every((g) => g >= 50), `相邻两个应隔 100ms 左右，实际 ${gaps.join(", ")}`);
  assert.ok(stamps[3] - stamps[0] >= 240, `四个应摊在 300ms 上，实际 ${stamps[3] - stamps[0]}ms`);
});

test("每秒几个 → 间隔：可以慢到几秒一个", () => {
  assert.equal(paceIntervalMs(2), 500);
  assert.equal(paceIntervalMs(3), 333);
  assert.equal(paceIntervalMs(0.5), 2000);
  assert.equal(paceIntervalMs(0.1), 10_000);
  assert.equal(paceIntervalMs(100), 10);
});

test("改了每秒请求数原地生效：队列里的活接着按新间隔发，没有卡死", async () => {
  useThrottle(5, 1, 1); // 200ms 一个
  let done = 0;
  const all = Promise.all(Array.from({ length: 10 }, () => scheduleForAccount(ACCOUNT, "normal", async () => { done++; })));
  await sleep(50);
  patchAppSettings({ throttle: { requestsPerSecond: 100, requestConcurrency: 1, downloadConcurrency: 1 } });
  await applyThrottleSettings();
  const t0 = Date.now();
  // 按旧间隔剩下的还要 1.8 秒；改完只有已经排好时刻的那一两个还按旧间隔走
  await timeout(all, 1200, "剩下的请求");
  assert.equal(done, 10);
  assert.ok(Date.now() - t0 < 900, `应该很快发完，实际 ${Date.now() - t0}ms`);
});

test("改了并发原地生效：排着的活马上多开几个，在跑的不受影响", async () => {
  let running = 0;
  let peak = 0;
  const hold = async () => {
    running++;
    peak = Math.max(peak, running);
    await sleep(60);
    running--;
  };
  const all = Promise.all(Array.from({ length: 6 }, () => scheduleForAccount(ACCOUNT, "download", hold)));
  await sleep(20);
  assert.equal(peak, 1);
  patchAppSettings({ throttle: { requestsPerSecond: 100, requestConcurrency: 1, downloadConcurrency: 3 } });
  await applyThrottleSettings();
  await timeout(all, 3000, "六个下载");
  assert.equal(peak, 3);
});

test("文件下载不占接口的节奏：接口两秒一个时，下载照样按并发数同时开始", async () => {
  useThrottle(0.5, 1, 4);
  await scheduleForAccount(ACCOUNT, "normal", async () => {}); // 接口上刚发过一个，下一个要等两秒
  let running = 0;
  let peak = 0;
  const hold = async () => {
    running++;
    peak = Math.max(peak, running);
    await sleep(30);
    running--;
  };
  const t0 = Date.now();
  await timeout(Promise.all(Array.from({ length: 4 }, () => scheduleForAccount(ACCOUNT, "download", hold))), 1000, "四个下载");
  assert.equal(peak, 4);
  assert.ok(Date.now() - t0 < 500, `下载不该等接口的间隔，实际 ${Date.now() - t0}ms`);
});

test("设置里的值：没填补默认，越界夹回上下限，并发取整、每秒请求数留着小数", () => {
  assert.deepEqual(normalizeThrottle(undefined), { requestsPerSecond: 2, requestConcurrency: 2, downloadConcurrency: 5 });
  assert.deepEqual(normalizeThrottle({ requestsPerSecond: 7 }), { requestsPerSecond: 7, requestConcurrency: 2, downloadConcurrency: 5 });
  assert.deepEqual(normalizeThrottle({ requestsPerSecond: 0.5 }), { requestsPerSecond: 0.5, requestConcurrency: 2, downloadConcurrency: 5 });
  // 并发 0.5 原样交给限流器会让这个账号的请求永远排队
  assert.deepEqual(
    normalizeThrottle({ requestsPerSecond: 0, requestConcurrency: 0.5, downloadConcurrency: 1.9 }),
    { requestsPerSecond: 0.1, requestConcurrency: 1, downloadConcurrency: 1 },
  );
  assert.deepEqual(
    normalizeThrottle({ requestsPerSecond: 1e9, requestConcurrency: 999, downloadConcurrency: -3 }),
    { requestsPerSecond: 100, requestConcurrency: 50, downloadConcurrency: 1 },
  );
  // 存进来的不是数字（手改过库）
  assert.deepEqual(
    normalizeThrottle({ requestsPerSecond: "3", requestConcurrency: null, downloadConcurrency: NaN } as never),
    { requestsPerSecond: 2, requestConcurrency: 2, downloadConcurrency: 5 },
  );
});

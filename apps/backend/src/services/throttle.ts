/**
 * 网盘请求限流：每个账号一把每秒配额，账号的每条通道一把并发上限，通道都链在配额上。
 *
 *   normal    普通接口请求（列目录、取直链、转存、整理……）
 *   life      网盘监控的轮询
 *   offline   云下载的列表 / 添加：界面上刷列表不该和取直链抢同一个槽位
 *   download  文件下载
 *
 * 调用方只说账号和通道，每秒几个、并发多少都在这里按设置定——以前四个调用点各读一遍设置、各带一个兜底值。
 * 这个文件不 import 网盘那一侧的任何东西：三家的客户端都要用它，反过来 import 就成环。
 */
import Bottleneck from "bottleneck";
import { Observable, type Subscription } from "rxjs";
import type { AppSettings } from "@openstrm/shared";
import { THROTTLE_DEFAULTS, THROTTLE_LIMITS } from "../db/defaults.js";
import { readAppSetting } from "../db/repositories/settings.js";

export type ThrottleChannel = "normal" | "life" | "offline" | "download";

/** 补齐、夹过上下限之后实际用的三个值 */
export interface ThrottleValues {
  requestsPerSecond: number;
  requestConcurrency: number;
  downloadConcurrency: number;
}

function within(value: unknown, fallback: number, { min, max }: { min: number; max: number }): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * 设置里存的 → 实际用的：没填的补默认，越界的夹回上下限，取整。
 * 库里的值不一定经过校验（老数据、直接调接口写的）：并发 0.5 原样交给限流器的话，这个账号的请求会全部永远排队。
 */
export function normalizeThrottle(raw: AppSettings["download"]): ThrottleValues {
  return {
    requestsPerSecond: Math.floor(within(raw?.linkMaxPerSecond, THROTTLE_DEFAULTS.requestsPerSecond, THROTTLE_LIMITS.requestsPerSecond)),
    requestConcurrency: Math.floor(within(raw?.linkMaxConcurrent, THROTTLE_DEFAULTS.requestConcurrency, THROTTLE_LIMITS.requestConcurrency)),
    downloadConcurrency: Math.floor(within(raw?.downloadMaxConcurrent, THROTTLE_DEFAULTS.downloadConcurrency, THROTTLE_LIMITS.downloadConcurrency)),
  };
}

export function throttleSettings(): ThrottleValues {
  return normalizeThrottle(readAppSetting("download"));
}

interface AccountLimiters {
  /** 每秒配额：这个账号所有通道共用 */
  pace: Bottleneck;
  channels: Map<ThrottleChannel, Bottleneck>;
}

/** 按账号名分。以前的键是「账号名:通道」再按冒号切回账号名，名字里带冒号的两个账号会共用一个配额 */
const accounts = new Map<string, AccountLimiters>();

function limitersOf(account: string): AccountLimiters {
  let entry = accounts.get(account);
  if (!entry) {
    const reservoir = throttleSettings().requestsPerSecond;
    entry = {
      pace: new Bottleneck({ reservoir, reservoirRefreshAmount: reservoir, reservoirRefreshInterval: 1000 }),
      channels: new Map(),
    };
    accounts.set(account, entry);
  }
  return entry;
}

/** 并发数只在第一次建的时候生效，改了设置要 resetThrottle 才按新值重建 */
function channelLimiter(account: string, channel: ThrottleChannel): Bottleneck {
  const entry = limitersOf(account);
  let limiter = entry.channels.get(channel);
  if (!limiter) {
    const { requestConcurrency, downloadConcurrency } = throttleSettings();
    limiter = new Bottleneck({ maxConcurrent: channel === "download" ? downloadConcurrency : requestConcurrency });
    limiter.chain(entry.pace);
    entry.channels.set(channel, limiter);
  }
  return limiter;
}

/**
 * 丢掉现有限流器，之后的请求按当前设置新建。
 *
 * 旧的让它排空：stop() 默认会把排队中的任务全部拒绝掉，正在跑的全量任务就此卡成永远 processing。
 * 顺序也有讲究：通道限流器链在每秒配额上，任务（包括 stop 自己放进去的收尾哨兵）
 * 是异步提交给父级的——父级先停，子级的收尾就会被父级拒掉。所以先等子级全部收完，再停父级。
 */
export function resetThrottle(): void {
  const old = [...accounts.values()];
  accounts.clear();
  const children = old.flatMap((a) => [...a.channels.values()]);
  void Promise.allSettled(children.map((l) => l.stop({ dropWaitingJobs: false }))).then(() =>
    Promise.allSettled(old.map((a) => a.pace.stop({ dropWaitingJobs: false }))),
  );
}

/**
 * 这个账号的每秒配额上有没有别人在排队 / 在跑：后台慢活（影库抄目录）发请求前看一眼，忙就先让，
 * 同步、302 取直链这些人在等的请求不用排在它后面
 */
export function accountBusy(account: string): boolean {
  const pace = accounts.get(account)?.pace;
  if (!pace) return false;
  const c = pace.counts();
  return c.QUEUED + c.RUNNING + c.EXECUTING > 0;
}

/**
 * 单次请求排进账号的限流通道（取直链、网盘接口）。Bottleneck 本来就是 Promise 接口：
 * 槽位随 Promise 落定归还，没有订阅 / 退订那一层。signal 已中止的任务轮到时直接拒绝，不再发请求。
 */
export function scheduleForAccount<T>(
  account: string,
  channel: ThrottleChannel,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return channelLimiter(account, channel).schedule(async () => {
    signal?.throwIfAborted();
    return fn();
  });
}

/**
 * 会发进度的流排进账号的限流通道（下载用；单次请求用 scheduleForAccount）。
 * 限流器在订阅时才取：resetThrottle 之后再订阅的拿到新建的，而不是已经 stop 的旧限流器。
 */
export function enqueueForAccount<T>(account: string, channel: ThrottleChannel, fn: () => Observable<T>): Observable<T> {
  return new Observable<T>((observer) => {
    const limiter = channelLimiter(account, channel);
    let cancelled = false;
    let inner: Subscription | null = null;
    /** 任务已开始时，调它就是把限流器的槽位还回去 */
    let release: (() => void) | null = null;
    limiter
      .schedule(
        () =>
          new Promise<void>((resolve) => {
            // 排到队头时订阅方早已退订（任务取消）：直接放过，别再发请求、写盘
            if (cancelled) return resolve();
            release = resolve;
            inner = fn().subscribe({
              next: (v) => observer.next(v),
              // 错误只走 observer；这里 resolve 是为了让限流器释放槽位
              error: (err) => { observer.error(err); resolve(); },
              complete: () => { observer.complete(); resolve(); },
            });
          }),
      )
      // 限流器被 stop、fn 同步抛出之类的失败以前被丢掉，订阅方永远等不到结果
      .catch((err) => observer.error(err));
    return () => {
      cancelled = true;
      inner?.unsubscribe();
      // 订阅方退订了也要还槽位——不只是任务取消：firstValueFrom 这类"拿到第一个值就退订"的消费者
      // 退订之后，内层随后的 complete 送不到这里。只靠 complete 来 resolve 的话，一个账号的两个槽位
      // 两次请求就全部漏光，第三次起所有调用永远排队（rc.9 的 request115 就是这样挂死的）
      release?.();
    };
  });
}

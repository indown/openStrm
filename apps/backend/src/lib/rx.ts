/**
 * rxjs 的小补丁。
 */
import { Observable, defer, from, lastValueFrom, mergeMap } from "rxjs";

/**
 * 会 unref 的定时发牌，用来替代 rxjs 自带的 timer。
 *
 * 自带的 timer 走 setInterval / setTimeout 且没有 unref 的口子：常驻循环挂在上面，
 * 进程就退不出来了（docker stop 只能等超时被 kill）；重试的等待挂在上面，
 * 停机也要多等一个退避。这里自己发牌，句柄一律 unref。
 *
 * periodMs 不给就是发一张牌即结束（一次性的等待）。
 */
export function unrefTimer(dueMs: number, periodMs?: number): Observable<number> {
  return new Observable<number>((subscriber) => {
    let n = 0;
    let handle: NodeJS.Timeout | null = null;
    const arm = (ms: number) => {
      handle = setTimeout(() => {
        subscriber.next(n++);
        if (periodMs === undefined) return subscriber.complete();
        // next 里同步退订是常事（take / first / takeWhile 就在下游）：那时 teardown 已经
        // clearTimeout 过刚刚触发的这个 handle，再 arm 一次就成了没人拿得住的永动定时器
        if (subscriber.closed) return;
        arm(periodMs);
      }, ms);
      handle.unref?.();
    };
    arm(dueMs);
    return () => {
      if (handle) clearTimeout(handle);
    };
  });
}

/**
 * 有界并发地跑一遍，边跑边报进度——mapLimit 的可取消版。
 *
 * 和 lib/async.ts 的 mapLimit 的差别只有两点，但对长活儿很要紧：
 *   - signal 一掐就不再派新的（mapLimit 只能等它自己跑完；校验一个大目录是两万个文件）
 *   - 每做完一个报一次数，调用方拿去推进度
 * 不收集结果：要结果的还是用 mapLimit。
 */
export async function forEachLimit<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
  opts: { signal?: AbortSignal; onDone?: (done: number, total: number) => void } = {},
): Promise<void> {
  // 空输入也要认取消：已经掐了还「顺利跑完」，调用方会当成一切正常
  opts.signal?.throwIfAborted();
  if (items.length === 0) return;
  let done = 0;
  await lastValueFrom(
    from(items).pipe(
      mergeMap(
        (item) =>
          defer(async () => {
            opts.signal?.throwIfAborted();
            await fn(item);
            opts.onDone?.(++done, items.length);
          }),
        concurrency,
      ),
    ),
    { defaultValue: undefined },
  );
}

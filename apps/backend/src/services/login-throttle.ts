/**
 * 登录失败退避。
 *
 * 按来源 IP 记连续失败次数：攒够 maxFailures 次就锁一段时间，每锁一次时长翻倍，
 * 上限 maxLockMs；登录成功立刻清零。纯内存，进程重启归零——目的是让脚本
 * 试口令的速度从"每秒几十次"掉到"每分钟几次"，不是替代强口令。
 *
 * 只按 IP 分桶：管理界面只有一个账号，按用户名分桶没有意义。放在反代后面时
 * 要设 TRUST_PROXY，否则所有人共用反代那一个 IP 的桶。键由调用方给（lib/ip.ts 的 ipKey，IPv6 按 /64）。
 *
 * 比对口令用 begin / end 包起来：比对是异步的（KDF 要跑几十毫秒），「先查锁、再比对、再记失败」的话，
 * 同时打进来的一批请求查锁时都还没有失败记录，会全部漏过去。begin 先占位子，在比对的也算进次数里。
 */
export interface LoginThrottle {
  /** 还在锁定期内返回剩余秒数（向上取整），否则 0 */
  blockedFor(key: string): number;
  /**
   * 开始一次比对：锁着、或者已经有 maxFailures 个比对在跑（并发撞库），返回要等的秒数；
   * 否则占一个位子返回 0。占了位子一定要 end
   */
  begin(key: string): number;
  /** 结束一次比对：true 清零，false 记一次失败，不传（中途出错）只还位子 */
  end(key: string, ok?: boolean): void;
  recordFailure(key: string): void;
  recordSuccess(key: string): void;
  reset(): void;
}

interface Bucket {
  failures: number;
  locks: number;
  lockedUntil: number;
  /** 最后一次失败的时间：闲置超过 maxLockMs 的桶没有保留价值 */
  lastFailureAt: number;
  /** begin 了还没 end 的比对 */
  inflight: number;
}

export function createLoginThrottle(opts: {
  maxFailures?: number;
  baseLockMs?: number;
  maxLockMs?: number;
  now?: () => number;
} = {}): LoginThrottle {
  const maxFailures = opts.maxFailures ?? 5;
  const baseLockMs = opts.baseLockMs ?? 30_000;
  const maxLockMs = opts.maxLockMs ?? 15 * 60_000;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  function prune(): void {
    // 桶在失败时（和 begin 占位时）创建。以前只清"解锁且失败数为 0"的桶：失败一两次就停手的来源永远留着，
    // 分布式慢速试口令能把这张表撑到无限大。现在按闲置时间清：没有比对在跑、已解锁、
    // 最后一次失败距今超过 maxLockMs 的都扔掉
    if (buckets.size < 1000) return;
    const t = now();
    for (const [key, b] of buckets) {
      if (b.inflight === 0 && b.lockedUntil <= t && t - b.lastFailureAt > maxLockMs) buckets.delete(key);
    }
  }

  const fresh = (): Bucket => ({ failures: 0, locks: 0, lockedUntil: 0, lastFailureAt: 0, inflight: 0 });

  function blockedFor(key: string): number {
    const b = buckets.get(key);
    if (!b) return 0;
    const remaining = b.lockedUntil - now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  function recordFailure(key: string): void {
    prune();
    const b = buckets.get(key) ?? fresh();
    b.lastFailureAt = now();
    b.failures += 1;
    if (b.failures >= maxFailures) {
      b.locks += 1;
      b.failures = 0;
      b.lockedUntil = now() + Math.min(baseLockMs * 2 ** (b.locks - 1), maxLockMs);
    }
    buckets.set(key, b);
  }

  return {
    blockedFor,
    begin(key) {
      const wait = blockedFor(key);
      if (wait > 0) return wait;
      prune();
      const b = buckets.get(key) ?? fresh();
      // 已经在跑的比对全失败就够锁了：再多放进来的只是白给的尝试次数，等它们出结果
      if (b.failures + b.inflight >= maxFailures) return 1;
      b.inflight += 1;
      buckets.set(key, b);
      return 0;
    },
    end(key, ok) {
      const b = buckets.get(key);
      if (b && b.inflight > 0) b.inflight -= 1;
      if (ok === true) buckets.delete(key);
      else if (ok === false) recordFailure(key);
      else if (b && b.inflight === 0 && b.failures === 0 && b.locks === 0) buckets.delete(key);
    },
    recordFailure,
    recordSuccess(key) {
      buckets.delete(key);
    },
    reset() {
      buckets.clear();
    },
  };
}

/** API 进程共用的一份 */
export const loginThrottle = createLoginThrottle();

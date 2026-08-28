/**
 * 登录失败退避。
 *
 * 按来源 IP 记连续失败次数：攒够 maxFailures 次就锁一段时间，每锁一次时长翻倍，
 * 上限 maxLockMs；登录成功立刻清零。纯内存，进程重启归零——目的是让脚本
 * 试口令的速度从"每秒几十次"掉到"每分钟几次"，不是替代强口令。
 *
 * 只按 IP 分桶：管理界面只有一个账号，按用户名分桶没有意义。放在反代后面时
 * 要设 TRUST_PROXY，否则所有人共用反代那一个 IP 的桶。
 */
export interface LoginThrottle {
  /** 还在锁定期内返回剩余秒数（向上取整），否则 0 */
  blockedFor(key: string): number;
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
    // 桶只会在失败时创建。以前只清"解锁且失败数为 0"的桶：失败一两次就停手的来源永远留着，
    // 分布式慢速试口令（TRUST_PROXY 下 X-Forwarded-For 还能随便造）能把这张表撑到无限大。
    // 现在按闲置时间清：最后一次失败距今超过 maxLockMs 且已解锁的都扔掉
    if (buckets.size < 1000) return;
    const t = now();
    for (const [key, b] of buckets) {
      if (b.lockedUntil <= t && t - b.lastFailureAt > maxLockMs) buckets.delete(key);
    }
  }

  return {
    blockedFor(key) {
      const b = buckets.get(key);
      if (!b) return 0;
      const remaining = b.lockedUntil - now();
      return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    },
    recordFailure(key) {
      prune();
      const b = buckets.get(key) ?? { failures: 0, locks: 0, lockedUntil: 0, lastFailureAt: 0 };
      b.lastFailureAt = now();
      b.failures += 1;
      if (b.failures >= maxFailures) {
        b.locks += 1;
        b.failures = 0;
        b.lockedUntil = now() + Math.min(baseLockMs * 2 ** (b.locks - 1), maxLockMs);
      }
      buckets.set(key, b);
    },
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

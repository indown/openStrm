/**
 * 每个令牌一个令牌桶：模型循环调用比人快得多，别让它把网盘接口打出风控。
 * 平均每分钟 120 次，允许一下子来 30 次（一轮对话里并行调好几个工具很常见）。
 * 只在内存里，重启清零无所谓。
 */
const CAPACITY = 30;
const REFILL_PER_SECOND = 2;

const buckets = new Map<string, { tokens: number; at: number }>();

export type QuotaResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/** 扣 cost 个配额（一个请求批了几条消息就是几个）；不够就一个都不扣 */
export function takeAgentQuota(key: string, cost = 1, now = Date.now()): QuotaResult {
  const b = buckets.get(key) ?? { tokens: CAPACITY, at: now };
  b.tokens = Math.min(CAPACITY, b.tokens + ((now - b.at) / 1000) * REFILL_PER_SECOND);
  b.at = now;
  buckets.set(key, b);
  if (b.tokens >= cost) {
    b.tokens -= cost;
    return { ok: true };
  }
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((cost - b.tokens) / REFILL_PER_SECOND)) };
}

/** 测试用 */
export function __test_resetAgentQuota(): void {
  buckets.clear();
}

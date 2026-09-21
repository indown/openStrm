/**
 * 令牌桶限流。只在内存里，重启清零无所谓。
 *
 *   - 每个令牌一个桶：模型循环调用比人快得多，别让它把网盘接口打出风控。
 *     平均每分钟 120 次，允许一下子来 30 次（一轮对话里并行调好几个工具很常见）。REST 和 /mcp 共用。
 *   - 没登录的请求按来源一个桶（IPv6 按 /64，见 lib/ip.ts）：/oauth/* 和回 401 的 /mcp，谁都能打，不限的话能拿它刷库、刷通知。
 *   - 动态注册、批准通知另有全局的桶：换着地址来也有个总数。
 */
export type QuotaResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface TokenBucket {
  /** 扣 cost 个配额；不够就一个都不扣 */
  take(key: string, cost?: number, now?: number): QuotaResult;
  reset(): void;
}

/** 桶太多时顺手清掉已经回满的：按 IP 分桶时，换着 IP 来的请求不能把这张表撑到无限大 */
const PRUNE_AT = 5000;

export function createTokenBucket(capacity: number, refillPerSecond: number): TokenBucket {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const level = (b: { tokens: number; at: number }, now: number) => Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSecond);
  return {
    take(key, cost = 1, now = Date.now()) {
      if (buckets.size > PRUNE_AT) {
        for (const [k, b] of buckets) if (level(b, now) >= capacity) buckets.delete(k);
      }
      const b = buckets.get(key) ?? { tokens: capacity, at: now };
      b.tokens = level(b, now);
      b.at = now;
      buckets.set(key, b);
      if (b.tokens >= cost) {
        b.tokens -= cost;
        return { ok: true };
      }
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((cost - b.tokens) / refillPerSecond)) };
    },
    reset() {
      buckets.clear();
    },
  };
}

const agentBucket = createTokenBucket(30, 2);

/** 每个令牌（手建的、OAuth 授权的）的配额 */
export function takeAgentQuota(key: string, cost = 1, now = Date.now()): QuotaResult {
  return agentBucket.take(key, cost, now);
}

/** 没登录的请求按 IP：每分钟 30 个，一下子最多 30 个（授权流程一次也就五六个请求） */
export const anonymousIpBucket = createTokenBucket(30, 0.5);

/** 动态注册按来源：每小时 10 个。注册谁都能发，每个都要落一行库 */
export const registrationIpBucket = createTokenBucket(10, 10 / 3600);

/** 动态注册全局：每小时 60 个（正常一个客户端连一次注册一次，够用），换着地址来也就这么多 */
export const registrationGlobalBucket = createTokenBucket(60, 60 / 3600);

/** 授权请求的 Telegram 通知：每小时最多 10 条，有人刷授权请求时不至于把聊天刷屏（设置页里照样看得到） */
export const oauthNotifyBucket = createTokenBucket(10, 10 / 3600);

/** 测试用 */
export function __test_resetAgentQuota(): void {
  agentBucket.reset();
  anonymousIpBucket.reset();
  registrationIpBucket.reset();
  registrationGlobalBucket.reset();
  oauthNotifyBucket.reset();
}

/**
 * 全进程唯一的 pino 实例。
 *
 * Fastify 用 loggerInstance 接入同一个实例，所以 app.log / request.log 和
 * 各 service 里的 child logger 共享级别、格式和输出，LOG_LEVEL 一处生效。
 * 以前 service 层拿不到 fastify 的 logger，要么 console.*，要么由 index.ts
 * 把 app.log 注入进去——两条路都不用再走。
 */
import pino from "pino";
import axios from "axios";

/**
 * 只留 origin + 路径：查询串里可能有 api_key / 签名，Telegram 的 bot token 直接嵌在路径里。
 * 解析不了就不给，宁缺毋滥。
 */
function redactUrl(url: string | undefined, baseURL: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url, baseURL);
    return `${u.origin}${u.pathname.replace(/\/bot[^/]+/, "/bot[redacted]")}`;
  } catch {
    return undefined;
  }
}

/**
 * pino 默认的 err 序列化会把 Error 上所有可枚举属性都带上。AxiosError 挂着整个
 * config（headers 里是 115 的 Cookie、URL 里是 Telegram 的 bot token）、request 和 response：
 * 一次网络错误就把凭据写进日志，而且动辄几十 KB。这里只留下定位问题需要的几项。
 * DOMException（signal.throwIfAborted() 抛的 AbortError 就是）则会把原型上 INDEX_SIZE_ERR…
 * 二十几个常量一并枚举进来，stack 指向的还是 abort() 的调用处而不是抛出处，只留 type 和 message。
 *
 * Fastify 会把 loggerInstance 上的 serializers 合并进它自己的 child logger，
 * 所以 app.log / request.log / 各 service 的 moduleLogger 都经过这里。
 */
export function serializeError(err: unknown): unknown {
  if (axios.isAxiosError(err)) {
    return {
      type: "AxiosError",
      message: err.message,
      code: err.code,
      status: err.response?.status,
      method: err.config?.method?.toUpperCase(),
      url: redactUrl(err.config?.url, err.config?.baseURL),
    };
  }
  if (err instanceof DOMException) return { type: err.name, message: err.message };
  return pino.stdSerializers.err(err as Error);
}

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  serializers: { err: serializeError },
});

/** 按模块打标，日志里能看出是哪块发出来的 */
export function moduleLogger(mod: string) {
  return logger.child({ mod });
}

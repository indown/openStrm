/**
 * 全进程唯一的 pino 实例。
 *
 * Fastify 用 loggerInstance 接入同一个实例，所以 app.log / request.log 和
 * 各 service 里的 child logger 共享级别、格式和输出，LOG_LEVEL 一处生效。
 * 以前 service 层拿不到 fastify 的 logger，要么 console.*，要么由 index.ts
 * 把 app.log 注入进去——两条路都不用再走。
 */
import pino from "pino";

export const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/** 按模块打标，日志里能看出是哪块发出来的 */
export function moduleLogger(mod: string) {
  return logger.child({ mod });
}

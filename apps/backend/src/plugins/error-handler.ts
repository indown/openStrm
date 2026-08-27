import type { FastifyInstance } from "fastify";
import { HttpError } from "../lib/http-error.js";

/**
 * 所有错误响应只有一种壳：`{ message, ...extra }`，HTTP 状态码表达类别。
 *
 * - HttpError：路由主动抛的业务错误，状态码和附加字段原样透出。
 * - Fastify 自己抛的（JSON 解析失败 400、不支持的 content-type 415、body 超限 413）
 *   带 statusCode，照它的来，code 保留方便定位。
 * - 其余都是没预料到的异常：500，记完整堆栈；message 仍然给出去——
 *   这是给管理员自己用的工具，"Internal Server Error" 五个字对排障毫无帮助。
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ message: err.message, ...err.extra });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    const status =
      typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    if (status >= 500) request.log.error({ err }, "unhandled error");
    else request.log.info({ code: e.code, message: e.message }, "request rejected");
    return reply.code(status).send({
      message: e.message || "Internal Server Error",
      ...(e.code ? { code: e.code } : {}),
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ message: `${request.method} ${request.url} not found`, code: "NOT_FOUND" });
  });
}

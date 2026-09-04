import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { HttpError, UPSTREAM_ERROR_STATUS } from "../lib/http-error.js";

/**
 * 所有错误响应只有一种壳：`{ message, ...extra }`，HTTP 状态码表达类别。
 *
 * - HttpError：路由主动抛的业务错误，状态码和附加字段原样透出。
 * - Fastify 自己抛的（JSON 解析失败 400、不支持的 content-type 415、body 超限 413）
 *   带 statusCode，照它的来，code 保留方便定位。
 * - 其余都是没预料到的异常：500，记完整堆栈；message 仍然给出去——
 *   这是给管理员自己用的工具，"Internal Server Error" 五个字对排障毫无帮助。
 *
 * 自己从不回 502 / 504：Cloudflare 会把源站的这两个码换成它的错误页（见 lib/http-error.ts），
 * 业务上的 5xx 都记一条 warn——不然界面上被网关吞掉之后，日志里只剩一个 statusCode，查不回原因。
 */
// loggerInstance 会把 logger 的具体类型带进 FastifyInstance 的类型参数，
// 这里对它泛型化，index.ts 的 pino 实例和测试里的裸 Fastify() 都能传
export function registerErrorHandling<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, Logger>,
): void {
  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof HttpError) {
      const status = err.status === 502 || err.status === 504 ? UPSTREAM_ERROR_STATUS : err.status;
      if (status >= 500) {
        // data 是给前端兜底用的整包结果（比如 HDHive 挂了时的 TMDB 候选），不进日志
        const meta = Object.fromEntries(Object.entries(err.extra).filter(([k]) => k !== "data"));
        request.log.warn({ status, ...meta }, err.message);
      }
      return reply.code(status).send({ message: err.message, ...err.extra });
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

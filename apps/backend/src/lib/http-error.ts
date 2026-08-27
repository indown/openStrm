/**
 * 路由里 `throw new HttpError(404, "...")`，由 plugins/error-handler.ts 统一转成响应。
 *
 * 响应体固定是 `{ message, ...extra }`：extra 放机器可读的 code、给前端兜底用的 data
 * 这类附加字段。以前每个路由自己拼 `{ error }` / `{ code, message }`，前端得两种都认。
 */
export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;

  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.extra = extra;
  }
}

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

/**
 * 上游（115 / OpenList / HDHive / TMDB / Telegram）出错时用它，别写 502。
 *
 * 语义上 502 最贴切，但 Cloudflare 会把源站回的 502 / 504 换成它自己的错误页
 * （官方文档："Cloudflare returns a Cloudflare-branded HTTP 502 or 504 error when your origin
 * web server responds with a standard HTTP 502 bad gateway or 504 gateway timeout error"），
 * message 一个字都到不了浏览器，管理员只能看到一页 Cloudflare 的 JSON。
 * 所以对外一律 500：原话放 message，上游的状态码 / errno 放 extra。plugins/error-handler.ts 还会兜底改写。
 */
export const UPSTREAM_ERROR_STATUS = 500;

export function upstreamError(message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(UPSTREAM_ERROR_STATUS, message, extra);
}

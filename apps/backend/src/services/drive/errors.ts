/**
 * 网盘那边的错误 → HTTP 错误。路由里统一用它，别再各自 instanceof 一遍三家的错误类。
 * 上游状态码放 extra（见 lib/http-error.ts 关于不回 502 的说明）。
 */
import { isAbortError, PermanentError } from "../../lib/errors.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { Cloud115Error } from "../cloud-115/client.js";
import { ShareApiError } from "../cloud-115/share.js";
import { OpenlistError } from "../openlist/client.js";
import { QuarkError } from "../quark/client.js";
import { RemoteDirNotFoundError, ShareGoneError } from "./types.js";

export function driveErrorToHttp(err: unknown, fallback: string): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof RemoteDirNotFoundError) return new HttpError(404, err.message);
  if (err instanceof ShareGoneError) return upstreamError(`分享不可用：${err.message}`, { errno: err.code });
  if (err instanceof ShareApiError) return upstreamError(`分享不可用：${err.message}`, { errno: err.errno });
  if (err instanceof Cloud115Error) return upstreamError(err.message, { upstreamStatus: err.status });
  if (err instanceof QuarkError) return upstreamError(err.message, { upstreamStatus: err.status, code: err.code });
  if (err instanceof OpenlistError) return upstreamError(err.message, { upstreamStatus: err.code });
  if (isAbortError(err)) return new HttpError(499, "已取消");
  // 其余 PermanentError 是「网盘明确说没有」：文件不存在、目录不是目录
  if (err instanceof PermanentError) return new HttpError(404, err.message);
  return upstreamError(err instanceof Error && err.message ? err.message : fallback);
}

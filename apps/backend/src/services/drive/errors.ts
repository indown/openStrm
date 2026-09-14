/**
 * 网盘那边的错误 → HTTP 错误。路由里统一用它，别再各自 instanceof 一遍三家的错误类。
 * 上游状态码放 extra（见 lib/http-error.ts 关于不回 502 的说明）。
 */
import axios from "axios";
import { isAbortError, PermanentError } from "../../lib/errors.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { Cloud115Error } from "../cloud-115/client.js";
import { ShareApiError } from "../cloud-115/share.js";
import { OpenlistError } from "../openlist/client.js";
import { QuarkError } from "../quark/client.js";
import { QuarkTaskError } from "../quark/share.js";
import { RemoteDirNotFoundError, ShareGoneError } from "./types.js";

/**
 * 三家错误里能拿到的事实，给失败分类器用：功能代码不再 instanceof 具体网盘的错误类。
 *   status     HTTP 状态 / 网盘自己的状态码（115 的 HTTP 状态、夸克壳里的 status、OpenList 的 code、axios 的响应状态）
 *   transport  连不上 / HTTP 层失败（值得重试）
 *   taskFailed 网盘的异步任务失败或超时（夸克的转存 / 移动任务）
 *   authCode   网盘明确回了登录态失效的码（夸克 31001 / 31004 / 401，OpenList 401）
 */
export interface DriveErrorFacts {
  status?: number;
  transport: boolean;
  taskFailed: boolean;
  authCode: boolean;
}

export function driveErrorFacts(err: unknown): DriveErrorFacts {
  if (err instanceof OpenlistError) return { status: err.code, transport: err.transport, taskFailed: false, authCode: err.code === 401 };
  if (err instanceof Cloud115Error) return { status: err.status, transport: false, taskFailed: false, authCode: false };
  if (err instanceof QuarkTaskError) return { transport: false, taskFailed: true, authCode: false };
  if (err instanceof QuarkError) return { status: err.status, transport: false, taskFailed: false, authCode: err.code === 31001 || err.code === 31004 || err.status === 401 };
  if (axios.isAxiosError(err)) return { status: err.response?.status, transport: !err.response, taskFailed: false, authCode: false };
  return { transport: false, taskFailed: false, authCode: false };
}

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

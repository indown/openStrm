import axios from "axios";

/**
 * 换多少次都一样的失败：远端明确回答"没有这个对象"、凭据缺失、账号类型不支持之类。
 * 重试策略（取直链、下载）见到它就直接放弃，别再拿同一个请求白等几轮。
 */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

/**
 * 是不是被 AbortSignal 中止的。取消任务后它会以三种样子落到调用方手里：
 * 排在限流器里的请求是 `signal.throwIfAborted()` 抛的 DOMException，timers/promises 的 sleep
 * 抛 Node 自己的 AbortError（都叫 AbortError），正在飞的请求则是 axios 翻译成的 CanceledError。
 * 这些都是调用方自己掐的：不值得重试，也不该按错误记日志。
 */
export function isAbortError(err: unknown): boolean {
  if (axios.isCancel(err)) return true;
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

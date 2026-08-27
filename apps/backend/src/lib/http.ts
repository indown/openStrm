/**
 * 出站 HTTP 的两条保底。
 *
 * - 普通请求统一 30 秒超时。115 的 CDN / WAF 会把连接黑洞掉：不设超时的话，
 *   卡住的请求一直占着账号限流通道的槽位（默认只有 2 个），两个就把整个账号堵到进程重启。
 * - 流式响应另有空闲看门狗：axios 的 timeout 管到响应头为止，body 停住不动它不管。
 */
import type { Readable } from "node:stream";

export const DEFAULT_TIMEOUT_MS = 30_000;
/** 下载流多久没有新数据就放弃。CDN 偶尔会停顿，别设太紧 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * 流上 ms 内没有新数据就销毁它（带一个说明原因的 Error），pipe 的另一头和 on("error") 都会收到。
 *
 * 用的是 data 事件计时，所以要在同一个同步块里、消费方挂 data / pipe 之前调：
 * 加了 data 监听流就进入 flowing 模式，真正吐数据在下一个 tick，消费方那时已经挂上了。
 */
export function guardIdleStream(stream: Readable, ms: number, what: string): void {
  const timer = setTimeout(
    () => stream.destroy(new Error(`${what}：${ms / 1000} 秒内没有收到数据`)),
    ms,
  );
  timer.unref();
  stream.on("data", () => timer.refresh());
  stream.once("close", () => clearTimeout(timer));
}

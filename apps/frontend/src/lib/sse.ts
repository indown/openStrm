/**
 * 读后端推的事件流（服务端那头是 lib/sse.ts）。
 *
 * 用 fetch 而不是 EventSource：EventSource 带不了 Authorization 头，也只能 GET。
 * 代价是绕开了 axios 的拦截器，所以会话失效那套要自己走一遍（handleAuthFailure）。
 */
import { asApiError, getToken, handleAuthFailure } from "@/lib/axios";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

/**
 * 多久没有任何动静就当连接断了。后端每 15 秒发一个心跳注释行，
 * 所以只要连接还活着，这个计时器不可能走到头；反过来，NAT / 负载均衡把连接
 * 悄悄丢掉时，reader.read() 既不返回也不报错，没有这道看门狗界面会一直转下去。
 */
const STALL_MS = 60_000;

export interface StreamOptions<T> {
  /** 退订 / 关弹框时掐断：连接一断，后端那一轮活儿也跟着停 */
  signal?: AbortSignal;
  onEvent: (event: T) => void;
}

/** 发一个 POST，把回来的事件流逐条交给 onEvent；流正常结束时 resolve */
export async function streamSse<T>(path: string, body: unknown, opts: StreamOptions<T>): Promise<void> {
  const controller = new AbortController();
  const abortAll = () => controller.abort();
  if (opts.signal?.aborted) abortAll();
  opts.signal?.addEventListener("abort", abortAll, { once: true });

  let stalled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, STALL_MS);
  };

  try {
    armWatchdog();
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${getToken() ?? ""}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      // 流还没开起来就失败了（鉴权、任务不存在、入参不对）：回的还是平常那个 JSON 错误壳
      const data = await res.json().catch(() => undefined);
      handleAuthFailure(res.status, data, path);
      throw asApiError(res.status, data, `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // 从哪里开始找换行：每来一块只扫新来的部分，不然一条几 MB 的大事件会被反复整串扫
    let searchFrom = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // 心跳也算动静：收到任何东西都把看门狗往后推
      armWatchdog();
      buffer += decoder.decode(value, { stream: true });
      for (let nl = buffer.indexOf("\n", searchFrom); nl >= 0; nl = buffer.indexOf("\n", searchFrom)) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        searchFrom = 0;
        if (!line.startsWith("data: ")) continue; // 心跳是 `: ` 打头的注释行
        let event: T;
        try {
          event = JSON.parse(line.slice(6)) as T;
        } catch {
          continue; // 坏行跳过，不让一条脏数据把整条流带死
        }
        // onEvent 自己抛的错不能当成「坏行」吞掉：那会让界面停在一个没有结论的状态上，
        // 和真的断线一模一样，查都没法查
        opts.onEvent(event);
      }
      searchFrom = buffer.length;
    }
  } catch (err) {
    if (stalled && !opts.signal?.aborted) {
      throw new Error(`连接像是断了：${STALL_MS / 1000} 秒没有收到任何数据（含心跳）`);
    }
    throw err;
  } finally {
    clearTimeout(watchdog);
    opts.signal?.removeEventListener("abort", abortAll);
  }
}

"use client";

import { useEffect, useRef } from "react";

export interface PollingOptions {
  /** false 不轮询（页面只在有活儿在跑时盯着）。首拉由页面自己做，这里从下一个间隔才开始 */
  enabled?: boolean;
  /** 切回前台时立刻拉一次（人回来了要看最新的）。默认开 */
  refreshOnVisible?: boolean;
}

/**
 * 页面级轮询，全站的「隔几秒刷一次」都走这里：
 *   - 页面在后台不发请求：十几个标签页里各开一个 OpenStrm，后端不该被看不见的页面刷着
 *   - 上一轮还没回来就跳过这一轮，不叠着发
 *   - 切回前台立刻拉一次，之后按间隔来
 * fn 每次都取最新的（放在 ref 里），调用方传内联闭包不用管依赖；fn 自己兜错，这里不处理 reject
 */
export function usePolling(fn: () => void | Promise<unknown>, intervalMs: number, opts: PollingOptions = {}): void {
  const { enabled = true, refreshOnVisible = true } = opts;
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    let inFlight = false;
    let cancelled = false;
    const tick = () => {
      if (cancelled || document.visibilityState === "hidden" || inFlight) return;
      inFlight = true;
      Promise.resolve()
        .then(() => fnRef.current())
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    const timer = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    if (refreshOnVisible) document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (refreshOnVisible) document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, intervalMs, refreshOnVisible]);
}

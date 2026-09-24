import { useCallback, useEffect, useRef, useState } from "react";
import type { ResourceLinkState } from "@openstrm/shared";
import { api } from "@/lib/api";

export type LinkCheckState = ResourceLinkState | "checking";

/** 露出多少才算「看见了」 */
const VISIBLE_RATIO = 0.35;
/** 攒多久成一批、一批最多几条 */
const BATCH_DELAY_MS = 300;
const BATCH_MAX = 6;
/** 连着失败几批就不查了：PanSou 那边拦着（公共实例的检测接口常这样），再发只是白白打扰它 */
const MAX_FAILED_BATCHES = 2;

/**
 * 资源搜索结果的有效性检测：只查当前 tab 里屏幕上看得见的 115 / 夸克分享。
 *
 *   - 行挂上 observe 的 ref：露出 35% 以上进队列，没等到发出去就滚走了的从队列里拿掉（滚过去没停下来的不查）；
 *   - 攒 300 毫秒成一批，一批最多 6 条，同时只有一个请求在路上；
 *   - 查过的按 key 记在这一页里（切 tab、再搜同一个词不重查），PanSou 那边还有一层缓存；
 *   - PanSou 说不支持检测（老版本），或者连着两批都失败，就整页不再查。
 *
 * 为什么不用自己的网盘账号查：量一大容易把账号查出风控。真点「转存」时转存框会用账号读一次，那一次才是准的，
 * 读失败说分享没了就用 mark 记成失效
 */
export function useLinkCheck(enabled: boolean) {
  const [states, setStates] = useState<ReadonlyMap<string, LinkCheckState>>(new Map());
  /** 不再查了（PanSou 不支持检测，或者连着失败）：页面据此不画灰点 */
  const [stopped, setStopped] = useState(false);
  const supportedRef = useRef(true);
  const failedRef = useRef(0);
  /** 等着发的：key → 链接 */
  const queueRef = useRef(new Map<string, string>());
  /** 发出去过的（在查或查完）：不再排队 */
  const sentRef = useRef(new Set<string>());
  const inflightRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elByKey = useRef(new Map<string, Element>());
  const hitByEl = useRef(new WeakMap<Element, { key: string; url: string }>());

  const flushRef = useRef<() => void>(() => {});
  const schedule = useCallback(() => {
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      flushRef.current();
    }, BATCH_DELAY_MS);
  }, []);

  const flush = useCallback(() => {
    if (inflightRef.current || !supportedRef.current) return;
    const batch = [...queueRef.current.entries()].slice(0, BATCH_MAX);
    if (batch.length === 0) return;
    for (const [key] of batch) {
      queueRef.current.delete(key);
      sentRef.current.add(key);
    }
    setStates((m) => {
      const next = new Map(m);
      for (const [key] of batch) next.set(key, "checking");
      return next;
    });
    inflightRef.current = true;
    api.resource
      .check(batch.map(([, url]) => url))
      .then((res) => {
        failedRef.current = 0;
        if (!res.supported) {
          supportedRef.current = false;
          setStopped(true);
        }
        setStates((m) => {
          const next = new Map(m);
          for (const [key] of batch) {
            const r = res.results.find((x) => x.key === key);
            if (r && r.state !== "unsupported") next.set(key, r.state);
            else next.delete(key);
          }
          return next;
        });
      })
      .catch(() => {
        // 检测出错：这一批退回「没查」，不重试；连着失败就整页停下
        failedRef.current += 1;
        if (failedRef.current >= MAX_FAILED_BATCHES) {
          supportedRef.current = false;
          setStopped(true);
        }
        setStates((m) => {
          const next = new Map(m);
          for (const [key] of batch) next.delete(key);
          return next;
        });
      })
      .finally(() => {
        inflightRef.current = false;
        if (queueRef.current.size > 0) schedule();
      });
  }, [schedule]);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    const queue = queueRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const hit = hitByEl.current.get(e.target);
          if (!hit || sentRef.current.has(hit.key)) continue;
          if (e.isIntersecting && e.intersectionRatio >= VISIBLE_RATIO) queueRef.current.set(hit.key, hit.url);
          else queueRef.current.delete(hit.key);
        }
        if (queueRef.current.size > 0) schedule();
      },
      { threshold: [0, VISIBLE_RATIO] },
    );
    observerRef.current = observer;
    // 设置是后读到的：开关打开之前就挂上的行也要看
    for (const el of elByKey.current.values()) observer.observe(el);
    return () => {
      observer.disconnect();
      observerRef.current = null;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      queue.clear();
    };
  }, [enabled, schedule]);

  /** 行的 ref：挂上（el）/ 卸下（null）。只给 115 / 夸克的分享挂 */
  const observe = useCallback((key: string, url: string, el: Element | null) => {
    const prev = elByKey.current.get(key);
    if (prev && prev !== el) {
      observerRef.current?.unobserve(prev);
      elByKey.current.delete(key);
      queueRef.current.delete(key);
    }
    if (!el) return;
    elByKey.current.set(key, el);
    hitByEl.current.set(el, { key, url });
    observerRef.current?.observe(el);
  }, []);

  /** 别处得知的结果（转存框打开时说分享没了）：直接记下，也不再去查 */
  const mark = useCallback((key: string, state: ResourceLinkState) => {
    sentRef.current.add(key);
    queueRef.current.delete(key);
    setStates((m) => new Map(m).set(key, state));
  }, []);

  return { states, stopped, observe, mark };
}

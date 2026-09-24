import { useCallback, useEffect, useRef, useState } from "react";
import type { ResourceHit, ResourceLinkState } from "@openstrm/shared";
import { api } from "@/lib/api";

export type LinkCheckState = ResourceLinkState | "checking";

/** 露出多少才算「看见了」 */
const VISIBLE_RATIO = 0.35;
/**
 * 攒多久成一批、一批最多几条。5 条是后端一次交给 PanSou 的量（services/pansou/search.ts 的 CHECK_BATCH），
 * 多一条后端就得拆成两个请求去问
 */
const BATCH_DELAY_MS = 300;
const BATCH_MAX = 5;
/** 连着失败几批就不查了：PanSou 那边拦着（公共实例的检测接口常这样），再发只是白白打扰它 */
const MAX_FAILED_BATCHES = 2;

/** 要查的一条：key 是服务端回结果时对号用的，链接里带着提取码 */
type CheckTarget = Pick<ResourceHit, "key" | "url" | "password">;

/**
 * 有效性按「分享 + 提取码」记，页面和结果行都按它取：同一个分享后面几轮补上了提取码，
 * 原来记的「提取码不对或缺」就不算数了，要按新的提取码重新查
 */
export function linkCheckKey(hit: Pick<ResourceHit, "key" | "password">): string {
  return JSON.stringify([hit.key, hit.password ?? ""]);
}

/**
 * 资源搜索结果的有效性检测：只查当前 tab 里屏幕上看得见的 115 / 夸克分享。
 *
 *   - 行挂上 observe 的 ref：露出 35% 以上进队列，没等到发出去就滚走了的从队列里拿掉（滚过去没停下来的不查）；
 *   - 攒 300 毫秒成一批，一批最多 5 条，同时只有一个请求在路上；
 *   - 查过的按「分享 + 提取码」记在这一页里（切 tab、再搜同一个词不重查），PanSou 那边还有一层缓存；
 *   - PanSou 说不支持检测（老版本），或者连着两批都失败，就整页不再查。
 *
 * 为什么不用自己的网盘账号查：量一大容易把账号查出风控。真点「转存」时转存框会用账号读一次，那一次才是准的，
 * 用 mark 记下；还在路上的检测回来、或者检测失败，都不动它
 */
export function useLinkCheck(enabled: boolean) {
  const [states, setStates] = useState<ReadonlyMap<string, LinkCheckState>>(new Map());
  /** 不再查了（PanSou 不支持检测，或者连着失败）：页面据此不画灰点 */
  const [stopped, setStopped] = useState(false);
  const supportedRef = useRef(true);
  const failedRef = useRef(0);
  /** 等着发的：linkCheckKey → 要查的那条 */
  const queueRef = useRef(new Map<string, CheckTarget>());
  /** 发出去过的（在查或查完）：不再排队 */
  const sentRef = useRef(new Set<string>());
  /** 用账号读过、mark 记下的：检测结果不盖它 */
  const markedRef = useRef(new Set<string>());
  const inflightRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elByKey = useRef(new Map<string, Element>());
  const hitByEl = useRef(new WeakMap<Element, { id: string; hit: CheckTarget }>());

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
    for (const [id] of batch) {
      queueRef.current.delete(id);
      sentRef.current.add(id);
    }
    setStates((m) => {
      const next = new Map(m);
      for (const [id] of batch) next.set(id, "checking");
      return next;
    });
    inflightRef.current = true;
    api.resource
      .check(batch.map(([, hit]) => hit.url))
      .then((res) => {
        failedRef.current = 0;
        if (!res.supported) {
          supportedRef.current = false;
          setStopped(true);
        }
        setStates((m) => {
          const next = new Map(m);
          for (const [id, hit] of batch) {
            // 在查的时候用账号读过了（mark）：那一次才是准的
            if (markedRef.current.has(id)) continue;
            const r = res.results.find((x) => x.key === hit.key);
            if (r && r.state !== "unsupported") next.set(id, r.state);
            else next.delete(id);
          }
          return next;
        });
      })
      .catch(() => {
        // 检测出错：这一批退回「没查」，不重试；连着失败就整页停下。用账号读过的留着
        failedRef.current += 1;
        if (failedRef.current >= MAX_FAILED_BATCHES) {
          supportedRef.current = false;
          setStopped(true);
        }
        setStates((m) => {
          const next = new Map(m);
          for (const [id] of batch) if (!markedRef.current.has(id)) next.delete(id);
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
          const seen = hitByEl.current.get(e.target);
          if (!seen || sentRef.current.has(seen.id)) continue;
          if (e.isIntersecting && e.intersectionRatio >= VISIBLE_RATIO) queueRef.current.set(seen.id, seen.hit);
          else queueRef.current.delete(seen.id);
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
  const observe = useCallback((hit: CheckTarget, el: Element | null) => {
    const id = linkCheckKey(hit);
    const prev = elByKey.current.get(id);
    if (prev && prev !== el) {
      observerRef.current?.unobserve(prev);
      elByKey.current.delete(id);
      queueRef.current.delete(id);
    }
    if (!el) return;
    elByKey.current.set(id, el);
    hitByEl.current.set(el, { id, hit });
    observerRef.current?.observe(el);
  }, []);

  /** 别处得知的结果（转存框用账号读了一次）：直接记下，也不再去查 */
  const mark = useCallback((hit: Pick<ResourceHit, "key" | "password">, state: ResourceLinkState) => {
    const id = linkCheckKey(hit);
    markedRef.current.add(id);
    sentRef.current.add(id);
    queueRef.current.delete(id);
    setStates((m) => new Map(m).set(id, state));
  }, []);

  return { states, stopped, observe, mark };
}

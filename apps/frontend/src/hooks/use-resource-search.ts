import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import type { ResourceSearchResult } from "@openstrm/shared";
import { api } from "@/lib/api";
import { apiErrorBody, apiErrorMessage } from "@/lib/axios";

/**
 * 资源搜索的一次搜索，分几问：
 *
 * PanSou 的插件是「尽快响应，持续处理」——4 秒先回一部分，后台最长 30 秒搜完写进它的缓存，同一个词再问一次才拿得到补全的，
 * 响应里又没有「补完了没有」的标记。所以 first 出第一屏之后，隔 2 秒、3 秒、3 秒各再问一次（more，走缓存很快），
 * 连续两轮没变多就提前停。
 *
 * 新一轮的总数不少于当前的才换上去。但有人在操作时（转存框开着、往下滚过一屏）不直接换——列表会在手底下跳，
 * 点到的不是想点的那条——先攒在 pending 里，页面顶上给一条「又找到 N 条」，点了才换。
 */

export type ResourceSearchStatus = "idle" | "loading" | "refining" | "done" | "error";

export interface ResourceSearchState {
  keyword: string;
  status: ResourceSearchStatus;
  result: ResourceSearchResult | null;
  /** 有人在操作时攒着没换上去的那一轮 */
  pending: ResourceSearchResult | null;
  /** 问到第几轮了（1 起，first 算第一轮） */
  round: number;
  error: string | null;
  /** 后端的错误码：PANSOU_NOT_CONFIGURED 时页面换成「去设置」 */
  errorCode: string | null;
}

/** more 那几轮离上一轮回来隔多久 */
const MORE_DELAYS_MS = [2_000, 3_000, 3_000];
export const TOTAL_ROUNDS = MORE_DELAYS_MS.length + 1;

const IDLE: ResourceSearchState = { keyword: "", status: "idle", result: null, pending: null, round: 0, error: null, errorCode: null };

const linkCount = (r: ResourceSearchResult | null) => r?.items.length ?? 0;
/**
 * PanSou 这一轮一共给了多少（看得见的 + 屏蔽词藏掉的）：判断「还在不在变多」看它。
 * 只看看得见的，某一轮只多了被藏掉的几条就会被当成没变、提前停
 */
const rawCount = (r: ResourceSearchResult | null) => linkCount(r) + (r?.blocked ?? 0);

export function useResourceSearch(opts: { shouldHold: () => boolean }) {
  const [state, setState] = useState<ResourceSearchState>(IDLE);
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  /** 这次搜索带的外文原名（选了 TMDB 候选时有），后面几轮和「再取一次」都带上 */
  const titleEnRef = useRef<string | undefined>(undefined);
  // 页面每次渲染都给一个新函数，放 ref 里读最新的，免得 search 跟着变
  const holdRef = useRef(opts.shouldHold);
  useEffect(() => {
    holdRef.current = opts.shouldHold;
  });

  const stop = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  /**
   * 一轮回来了：变多了才换上去（一样多的一轮可能只是换了顺序，没必要让列表跳一下）；有人在操作就先攒着。
   * 攒着的也按「比攒着的那轮还多」才更新
   */
  const offer = useCallback((next: ResourceSearchResult) => {
    setState((s) => {
      if (!s.result) return { ...s, result: next };
      const base = s.pending ?? s.result;
      if (linkCount(next) > linkCount(base)) {
        if (holdRef.current()) return { ...s, pending: next };
        return { ...s, result: next, pending: null };
      }
      // 看得见的没变多、屏蔽词藏掉的变了：只换这个数，列表不动，也不出「又找到」。
      // 不然「TG 没搜到、插件搜到的全被藏了」会一直显示「没搜到」，而不是「都被屏蔽词藏掉了」
      if (linkCount(next) === linkCount(base) && (next.blocked ?? 0) !== (base.blocked ?? 0)) {
        return s.pending ? { ...s, pending: { ...s.pending, blocked: next.blocked } } : { ...s, result: { ...s.result, blocked: next.blocked } };
      }
      return s;
    });
  }, []);

  const search = useCallback(
    (keyword: string, searchOpts: { refresh?: boolean; titleEn?: string } = {}) => {
      const kw = keyword.trim();
      if (!kw) return;
      stop();
      const titleEn = searchOpts.titleEn?.trim() || undefined;
      titleEnRef.current = titleEn;
      const seq = ++seqRef.current;
      const ac = new AbortController();
      abortRef.current = ac;
      setState({ ...IDLE, keyword: kw, status: "loading", round: 1 });

      const finish = () => {
        if (seq === seqRef.current) setState((s) => ({ ...s, status: "done" }));
      };

      /** done：已经问了几轮；last：目前最多的一轮有几条；flat：连续几轮没变多 */
      const more = (done: number, last: number, flat: number) => {
        if (done >= TOTAL_ROUNDS || flat >= 2) return finish();
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          setState((s) => (seq === seqRef.current ? { ...s, round: done + 1 } : s));
          api.resource
            .search(kw, "more", { signal: ac.signal, titleEn })
            .then((next) => {
              if (seq !== seqRef.current) return;
              offer(next);
              const n = rawCount(next);
              more(done + 1, Math.max(n, last), n > last ? 0 : flat + 1);
            })
            .catch((err: unknown) => {
              // 补结果那一轮失败：停下，已有的留着
              if (seq !== seqRef.current || axios.isCancel(err)) return;
              finish();
            });
        }, MORE_DELAYS_MS[done - 1]);
      };

      api.resource
        .search(kw, "first", { refresh: searchOpts.refresh, signal: ac.signal, titleEn })
        .then((first) => {
          if (seq !== seqRef.current) return;
          setState((s) => ({ ...s, status: "refining", result: first }));
          more(1, rawCount(first), 0);
        })
        .catch((err: unknown) => {
          if (seq !== seqRef.current || axios.isCancel(err)) return;
          setState((s) => ({
            ...s,
            status: "error",
            error: apiErrorMessage(err, "搜索失败"),
            errorCode: apiErrorBody(err).code ?? null,
          }));
        });
    },
    [offer, stop],
  );

  /** 顶上那条「又找到 N 条」：点了就换 */
  const applyPending = useCallback(() => {
    setState((s) => (s.pending ? { ...s, result: s.pending, pending: null } : s));
  }, []);

  /** 停了以后「再取一次」：走缓存，很快，能拿到插件在后台补完的。人自己点的，直接换 */
  const fetchMore = useCallback(() => {
    const kw = state.keyword;
    if (!kw || state.status === "loading" || state.status === "refining") return;
    stop();
    const seq = ++seqRef.current;
    const ac = new AbortController();
    abortRef.current = ac;
    setState((s) => ({ ...s, status: "refining" }));
    api.resource
      .search(kw, "more", { signal: ac.signal, titleEn: titleEnRef.current })
      .then((next) => {
        if (seq !== seqRef.current) return;
        setState((s) => ({ ...s, status: "done", result: linkCount(next) >= linkCount(s.result) ? next : s.result, pending: null }));
      })
      .catch((err: unknown) => {
        if (seq !== seqRef.current || axios.isCancel(err)) return;
        setState((s) => ({ ...s, status: "done" }));
      });
  }, [state.keyword, state.status, stop]);

  const reset = useCallback(() => {
    stop();
    seqRef.current += 1;
    setState(IDLE);
  }, [stop]);

  return { ...state, search, applyPending, fetchMore, reset };
}

"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Check, Film, Tv } from "lucide-react";
import { api, type TmdbSearchResult } from "@/lib/api";
import { cn } from "@/lib/utils";

/** 候选最多几个：再多就不是「确认是哪一部」了 */
const MAX_CANDIDATES = 6;
/** TMDB 超过这么久没回就不等了：这一排是先占着位置等的（不然结果出来以后才插进来，列表会被往下推） */
const WAIT_MS = 4_000;
/** 读不到（连不上、超时、key 不对）以后多久内不再问：不然每搜一次都先占一排、再收起来 */
const BACKOFF_MS = 10 * 60_000;
let unavailableUntil = 0;

/** 海报在这里只有 46px 宽，换小一号的图（w154），省流量 */
const smallPoster = (url: string) => url.replace("/t/p/w500/", "/t/p/w154/");

export interface TmdbPick {
  /** `movie-693134` */
  key: string;
  title: string;
  originalTitle: string;
  year: string;
}

export const tmdbKeyOf = (r: Pick<TmdbSearchResult, "mediaType" | "id">) => `${r.mediaType}-${r.id}`;

interface TmdbStripProps {
  keyword: string;
  /** 选中的那个，`movie-693134` */
  selected: string | null;
  /** 地址里带的年份（选中候选时写进去的）：有它才会加亮 */
  year: string | null;
  onSelect: (pick: TmdbPick | null) => void;
}

/**
 * 顶上那排 TMDB 候选：确认要的是哪一部。点一个按它在 TMDB 上的名字重搜、标题里年份对得上的加亮；再点一次取消。
 * 只是辅助：TMDB 读不到（没配、连不上、没搜到）就什么都不显示，不挡搜索。
 * 片名总按简体中文问：搜的是中文资源站，设置里 TMDB 的语言可能是给影库刮削配的英文 / 繁体
 */
export function TmdbStrip({ keyword, selected, year, onSelect }: TmdbStripProps) {
  const [items, setItems] = useState<TmdbSearchResult[]>([]);
  // 头一帧就按「要去问」占位：初值是 false 的话，带着 ?tmdb= 进来会先闪一下「已按 TMDB 上的一部作品搜」那一行
  const [loading, setLoading] = useState(() => Boolean(keyword) && Date.now() >= unavailableUntil);
  /** 加载失败的海报（TMDB 的图片在国内常被墙）：退回图标，别把 alt 文字画在卡片上 */
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setItems([]);
    if (!keyword || Date.now() < unavailableUntil) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), WAIT_MS);
    api.tmdb
      .search(keyword, "zh-CN", ac.signal)
      .then((list) => {
        if (!cancelled) setItems(list.filter((r) => r.mediaType === "movie" || r.mediaType === "tv").slice(0, MAX_CANDIDATES));
      })
      .catch(() => {
        if (!cancelled) unavailableUntil = Date.now() + BACKOFF_MS;
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [keyword]);

  if (loading) {
    return (
      <div className="space-y-1.5" aria-busy="true" aria-label="在 TMDB 上找是哪一部">
        <div className="h-4 w-56 animate-pulse rounded bg-muted" />
        <div className="flex gap-2 overflow-hidden pb-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[81px] w-48 shrink-0 animate-pulse rounded-lg border bg-muted/50" />
          ))}
        </div>
      </div>
    );
  }

  const picked = items.find((r) => tmdbKeyOf(r) === selected);
  // 选中的那部不在这一排里（换了名字重搜以后 TMDB 没再列出来，或者这次没读到）：至少给个取消的地方
  if (selected && !picked) {
    return (
      <p className="text-xs text-muted-foreground">
        已按 TMDB 上的一部作品搜{year ? `，标题里带 ${year} 的标出来了` : ""}。
        <button type="button" className="ml-1 text-brand hover:underline" onClick={() => onSelect(null)}>
          取消选择
        </button>
      </p>
    );
  }
  if (items.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        {picked
          ? year
            ? `标题里带 ${year} 的已经标出来了；再点一次取消`
            : "已选这一部；再点一次取消"
          : "是哪一部？点一下按 TMDB 上的名字搜，标题里年份对得上的会标出来"}
      </p>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
        {items.map((r) => {
          const key = tmdbKeyOf(r);
          const active = key === selected;
          const poster = r.posterUrl ? smallPoster(r.posterUrl) : "";
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              title={r.overview || r.title}
              onClick={() => onSelect(active ? null : { key, title: r.title, originalTitle: r.originalTitle ?? "", year: r.year })}
              className={cn(
                "flex w-48 shrink-0 items-center gap-2 rounded-lg border bg-card p-1.5 text-left transition-colors hover:bg-accent",
                active && "border-brand/60 ring-1 ring-brand/30",
              )}
            >
              <div className="relative h-[69px] w-[46px] shrink-0 overflow-hidden rounded bg-muted">
                {poster && !broken.has(poster) ? (
                  <Image
                    src={poster}
                    alt=""
                    fill
                    sizes="46px"
                    className="object-cover"
                    unoptimized
                    onError={() => setBroken((s) => new Set(s).add(poster))}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                    {r.mediaType === "tv" ? <Tv className="size-4" /> : <Film className="size-4" />}
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-sm leading-snug font-medium">{r.title}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {r.year || "年份不详"} · {r.mediaType === "tv" ? "剧集" : "电影"}
                </div>
              </div>
              {active && <Check className="size-4 shrink-0 text-brand" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

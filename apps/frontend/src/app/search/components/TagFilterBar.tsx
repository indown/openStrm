"use client";

import { useMemo } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { ResourceHit } from "@openstrm/shared";
import { TAG_FILTERS, YEAR_FILTER } from "@/lib/resource";
import { cn } from "@/lib/utils";

interface TagFilterBarProps {
  /** 当前这一类的结果（没按标签筛过的），按钮上的条数按它数 */
  hits: ResourceHit[];
  selected: ReadonlySet<string>;
  /** 选了 TMDB 候选时的年份：多一个「只看这一年」 */
  year: string | null;
  onToggle: (tag: string) => void;
  onClear: () => void;
}

/**
 * 列表上面那排筛选按钮：只列这一类里出现过的标签（带条数），「只看 4K」点一下就行。
 * 分辨率之间是「或」，其余之间是「且」（规则在 lib/resource.ts）。选中的即使这一类里没有也照样列出来，好取消
 */
export function TagFilterBar({ hits, selected, year, onToggle, onClear }: TagFilterBarProps) {
  const chips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of hits) for (const t of h.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    const list = TAG_FILTERS.map((t) => ({ key: t as string, label: t as string, count: counts.get(t) ?? 0 }));
    if (year) list.unshift({ key: YEAR_FILTER, label: `${year} 年`, count: hits.filter((h) => h.title.includes(year)).length });
    return list.filter((c) => c.count > 0 || selected.has(c.key));
  }, [hits, selected, year]);

  if (chips.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="按标签筛选"
      className="flex items-center gap-1.5 overflow-x-auto border-b px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      {chips.map((c) => {
        const on = selected.has(c.key);
        return (
          <button
            key={c.key}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(c.key)}
            className={cn(
              "shrink-0 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              on ? "border-brand/40 bg-brand/10 text-brand" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {c.label}
            <span className="ml-1 tabular-nums opacity-70">{c.count}</span>
          </button>
        );
      })}
      {selected.size > 0 && (
        <button type="button" onClick={onClear} className="shrink-0 px-1 text-xs text-muted-foreground hover:text-foreground">
          清除
        </button>
      )}
    </div>
  );
}

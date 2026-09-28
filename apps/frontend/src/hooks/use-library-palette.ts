"use client";

import { useEffect, useState } from "react";
import type { LibraryHit } from "@openstrm/shared";
import { api } from "@/lib/api";
import { inputKindOf } from "@/lib/share";

export type LibraryPaletteData = { hits: LibraryHit[]; total: number; loading: boolean };

const EMPTY: LibraryPaletteData = { hits: [], total: 0, loading: false };
const DEBOUNCE_MS = 250;
const LIMIT = 5;

/**
 * ⌘K 里的影库：影库可能有上万个目录，不能像任务、追更那样打开时全拉下来在内存里筛，
 * 所以打了两个字以上（而且不是链接）才防抖去问后端，旧的请求作废。拉失败就是没有这一组，不弹提示
 */
export function useLibraryPalette(open: boolean, query: string): LibraryPaletteData {
  const [data, setData] = useState<LibraryPaletteData>(EMPTY);
  const q = query.trim();
  const searchable = open && q.length >= 2 && inputKindOf(q) === "search";

  useEffect(() => {
    if (!searchable) {
      setData(EMPTY);
      return;
    }
    const ac = new AbortController();
    setData((prev) => ({ ...prev, loading: true }));
    const t = setTimeout(() => {
      api.library
        .search({ q, limit: LIMIT }, ac.signal)
        .then((r) => {
          if (!ac.signal.aborted) setData({ hits: r.hits, total: r.total, loading: false });
        })
        .catch(() => {
          if (!ac.signal.aborted) setData(EMPTY);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [searchable, q]);

  return data;
}

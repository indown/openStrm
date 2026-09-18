"use client";

/**
 * 任务页背景：整个 strm 库里抽出来的一批作品海报（后端按作品目录的修改时间排，新的在前）。
 *
 * key 是任务表的指纹（id + 本地目录）：增删任务、改了本地目录就重拉；轮询刷运行状态不会动它。
 * 空串不拉；窄屏上墙不画，也不拉。
 */
import { useEffect, useState } from "react";
import type { StrmPosterRef } from "@openstrm/shared";
import { useBackdropWide, type BackdropPoster } from "@/components/poster-backdrop";
import { api } from "@/lib/api";
import { NO_POSTERS, toBackdropPosters, type ShownPosters } from "@/lib/poster-images";

/** 头一回要把整个库走一遍，可能超时；后端照样算完存着，过这么久再要一次 */
const RETRY_MS = 30_000;

export function useAllPosters(key: string): BackdropPoster[] {
  const wide = useBackdropWide();
  const [shown, setShown] = useState<ShownPosters>(NO_POSTERS);

  // 换下来的那一批解钉（新的一批这时候已经钉住了）；卸载时解钉最后一批
  useEffect(() => () => shown.release(), [shown]);

  useEffect(() => {
    if (!key || !wide) {
      setShown(NO_POSTERS);
      return;
    }
    let alive = true;
    let retry: number | undefined;
    const load = async (attempt: number) => {
      let refs: StrmPosterRef[];
      try {
        refs = (await api.strm.allPosters()).posters;
      } catch {
        // 背景图而已：拿不到就当没有，再试一次就算了
        if (alive && attempt === 0) retry = window.setTimeout(() => void load(1), RETRY_MS);
        return;
      }
      if (!alive) return;
      const next = await toBackdropPosters(
        refs.map((r) => ({ key: JSON.stringify([r.taskId, r.path]), taskId: r.taskId, poster: r })),
        () => alive,
      );
      if (alive) setShown(next);
      else next.release();
    };
    void load(0);
    return () => {
      alive = false;
      window.clearTimeout(retry);
    };
  }, [key, wide]);

  return shown.posters;
}

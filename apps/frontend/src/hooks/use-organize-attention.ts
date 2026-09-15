"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { ORGANIZE_CHANGED_EVENT } from "@/lib/organize";

const REFRESH_MS = 60_000;

/**
 * 侧栏「整理」的角标：要人管的整理有几个（待执行、有失败或没做完、撤销没退回完、自动触发的预览失败；进行中的不算）。
 * 60 秒刷新一次；切页面、整理页有动作（notifyOrganizeChanged）时立刻刷新；标签页在后台时不拉
 */
export function useOrganizeAttentionCount(): number {
  const pathname = usePathname();
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      api.organize
        .attention()
        .then((r) => {
          if (alive) setCount(r.runs.filter((a) => a.reason !== "busy").length);
        })
        .catch(() => {
          /* 角标拉不到就不显示，别打扰 */
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    window.addEventListener(ORGANIZE_CHANGED_EVENT, load);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener(ORGANIZE_CHANGED_EVENT, load);
      document.removeEventListener("visibilitychange", load);
    };
  }, [pathname]);

  return count;
}

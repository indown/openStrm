"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { UPDATE_CHANGED_EVENT } from "@/lib/update";

/** 侧栏版本号旁边的小点：有没有比当前新的版本。读的是库里的缓存，不会因为它去联网 */
export function useUpdateBadge(): { outdated: boolean; latest: string } {
  const [state, setState] = useState<{ outdated: boolean; latest: string }>({ outdated: false, latest: "" });
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      api.update
        .get()
        .then((s) => {
          if (alive) setState({ outdated: s.outdated, latest: s.state.latest?.version ?? "" });
        })
        .catch(() => {
          /* 拉不到就不显示，别打扰 */
        });
    };
    load();
    window.addEventListener(UPDATE_CHANGED_EVENT, load);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      window.removeEventListener(UPDATE_CHANGED_EVENT, load);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  return state;
}

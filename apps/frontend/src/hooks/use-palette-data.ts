"use client";

import { useEffect, useState } from "react";
import type { AccountInfo, ShareFollowSummary } from "@openstrm/shared";
import { api, type TaskRow } from "@/lib/api";

export type PaletteData = {
  tasks: TaskRow[];
  accounts: AccountInfo[];
  follows: ShareFollowSummary[];
};

const EMPTY: PaletteData = { tasks: [], accounts: [], follows: [] };

/**
 * 命令面板要搜的实体。
 *
 * 三样东西量都很小（任务几十、账号个位数、追更几十），所以是**打开时拉一次、在内存里过滤**，
 * 而不是每敲一个键问一次后端 —— 那样要防抖、要取消旧请求、还要一个新接口。
 * 每次打开都重拉（任务可能刚加），但旧数据留在屏幕上，面板不会先空一下再填。
 * 三条并发，谁失败谁留空，不弹提示：面板的主体是静态命令，实体拉不到也不该拦着用。
 */
export function usePaletteData(open: boolean): PaletteData {
  const [data, setData] = useState<PaletteData>(EMPTY);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void Promise.all([
      api.tasks.list().catch(() => [] as TaskRow[]),
      api.accounts.list().catch(() => [] as AccountInfo[]),
      api.follow
        .list()
        .then((r) => r.follows)
        .catch(() => [] as ShareFollowSummary[]),
    ]).then(([tasks, accounts, follows]) => {
      if (alive) setData({ tasks, accounts, follows });
    });
    return () => {
      alive = false;
    };
  }, [open]);

  return data;
}

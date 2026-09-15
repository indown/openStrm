"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { OrganizeFailureGroupKey, OrganizeItem, OrganizeRunStats } from "@openstrm/shared";
import { api } from "@/lib/api";
import { apiErrorBody, apiErrorMessage } from "@/lib/axios";

/** 进行中的 run 多久拉一次 summary */
export const POLL_MS = 2000;

/** 任务已有一次整理在进行中：后端的 409 带着那次的 runId，toast 给个「查看」直接打开 */
export function toastRunError(err: unknown, fallback: string, openRun: (id: string) => void): void {
  const busyId = (apiErrorBody(err) as { runId?: unknown }).runId;
  const message = apiErrorMessage(err, fallback);
  if (typeof busyId === "string" && busyId) toast.error(message, { action: { label: "查看", onClick: () => openRun(busyId) } });
  else toast.error(message);
}

/** 执行确认框里的「会动什么」：stats.planned 里含建目录 / 删目录，文件和目录分开说 */
export function plannedText(stats: OrganizeRunStats): string {
  const files = stats.planned - stats.plannedMkdir - stats.plannedRmdir;
  const parts = [`改名 / 移动 ${files} 个文件`];
  if (stats.plannedMkdir > 0) parts.push(`建 ${stats.plannedMkdir} 个目录`);
  if (stats.plannedRmdir > 0) parts.push(`删 ${stats.plannedRmdir} 个腾空的目录`);
  return parts.join("，");
}

export type RunItemsQuery = { unit: string } | { group: OrganizeFailureGroupKey };

/**
 * 按需拉项：详情不带全部项（一次整理最多两万个文件），展开单元 / 失败分组时才拉。
 * version 是详情刷新的次数：详情变了（改了单元、执行有进展）就重拉，展开着的清单跟着变
 */
export function useRunItems(runId: string, query: RunItemsQuery, enabled: boolean, version: number): { items: OrganizeItem[] | null; error: string | null } {
  const [items, setItems] = useState<OrganizeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unit = "unit" in query ? query.unit : undefined;
  const group = "group" in query ? query.group : undefined;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api.organize
      .items(runId, group !== undefined ? { group } : { unit: unit ?? "" })
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setError(null);
      })
      .catch((err) => {
        if (alive) setError(apiErrorMessage(err, "读取文件清单失败"));
      });
    return () => {
      alive = false;
    };
  }, [runId, unit, group, enabled, version]);
  return { items, error };
}

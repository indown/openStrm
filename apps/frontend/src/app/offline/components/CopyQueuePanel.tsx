"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { api, type CopyItem } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";

const STATUS_META: Record<CopyItem["status"], { tone: StatusTone; label: string; pulse?: boolean }> = {
  pending: { tone: "info", label: "复制中", pulse: true },
  done: { tone: "success", label: "已复制" },
  skipped: { tone: "neutral", label: "已跳过" },
  failed: { tone: "danger", label: "失败" },
};

const TRIGGER_LABEL: Record<CopyItem["trigger"], string> = {
  offline: "云下载",
  share: "转存",
  follow: "追更",
  monitor: "网盘监控",
  manual: "手动",
};

/**
 * 「复制到 OpenList」的队列。登记是各个来源做的（云下载 / 转存 / 追更 / 监控），
 * 这里只看进度：失败的能单独重试，不想跟的能去掉。
 */
export function CopyQueuePanel() {
  const [items, setItems] = useState<CopyItem[] | null>(null);
  const [pending, setPending] = useState(0);
  const [working, setWorking] = useState<Set<string>>(new Set());

  const load = useCallback(async (silent = true) => {
    try {
      const q = await api.copy.list();
      setItems(q.items);
      setPending(q.watcher.pending);
    } catch (err) {
      if (!silent) toast.error(apiErrorMessage(err, "读取复制队列失败"));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 有在跑的就盯着，跑完自己停
  useEffect(() => {
    if (pending === 0) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [pending, load]);

  const act = async (id: string, what: "retry" | "remove") => {
    setWorking((prev) => new Set(prev).add(id));
    try {
      if (what === "retry") {
        await api.copy.retry(id);
        toast.success("已重新排队");
      } else {
        await api.copy.remove(id);
      }
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, what === "retry" ? "重试失败" : "删除失败"));
    } finally {
      setWorking((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  if (!items || items.length === 0) return null;

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium">复制到 OpenList</h2>
        {pending > 0 && (
          <StatusBadge tone="brand" className="tabular-nums" pulse>
            {pending} 个在队列里
          </StatusBadge>
        )}
      </div>
      <ul className="divide-y">
        {items.slice(0, 20).map((c) => {
          const meta = STATUS_META[c.status];
          const busy = working.has(c.id);
          return (
            <li key={c.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={meta.tone} pulse={meta.pulse}>
                    {meta.label}
                  </StatusBadge>
                  <span className="break-all text-sm font-medium">{c.name}</span>
                  <span className="text-xs text-muted-foreground">· {TRIGGER_LABEL[c.trigger]}</span>
                </div>
                <p className="break-all text-xs text-muted-foreground">
                  → {c.dstDir}
                  {c.detail ? ` · ${c.detail}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {c.status !== "pending" && (
                  <Button variant="ghost" size="icon" className="size-8" title="重试复制" disabled={busy} onClick={() => void act(c.id, "retry")}>
                    {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive hover:text-destructive"
                  title="从队列里去掉"
                  disabled={busy}
                  onClick={() => void act(c.id, "remove")}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {items.length > 20 && <p className="text-xs text-muted-foreground">只显示最近 20 条</p>}
    </section>
  );
}

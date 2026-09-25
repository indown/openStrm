"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AddCopyDialog, AFTER_COPY_LABEL } from "@/components/AddCopyDialog";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
 * 「复制到 OpenList」的队列。自动登记是各个来源做的（云下载 / 转存 / 追更 / 监控）；
 * 「新建复制」是事后补的手动发起（转存时没勾、后来才开了复制）。失败的能单独重试，不想跟的能去掉。
 * 队列空着、复制也没配好时整块不显示，免得没用这个功能的人看到一块空面板
 */
export function CopyQueuePanel() {
  const [items, setItems] = useState<CopyItem[] | null>(null);
  const [pending, setPending] = useState(0);
  const [total, setTotal] = useState(0);
  const [working, setWorking] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<CopyItem | null>(null);
  /** 设置页选了 OpenList 账号、至少给一个网盘填了挂载根：队列空着也给「新建复制」的入口 */
  const [configured, setConfigured] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    api.settings
      .get()
      .then((s) => setConfigured(Boolean(s.openlistCopy?.account) && Object.values(s.openlistCopy?.mounts ?? {}).some((m) => m?.trim())))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const q = await api.copy.list();
      setItems(q.items);
      setTotal(q.total);
      setPending(q.watcher.pending);
      setError(null);
    } catch (err) {
      // 轮询期间一次抖动不该让整块面板消失：留着上一份，只在旁边说一句
      setError(apiErrorMessage(err, "读取复制队列失败"));
      setItems((prev) => prev ?? []);
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

  if (!items || (items.length === 0 && !configured)) return null;

  return (
    <section id="copy-queue" className="scroll-mt-20 space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium">复制到 OpenList</h2>
        {pending > 0 && (
          <StatusBadge tone="brand" className="tabular-nums" pulse>
            {pending} 个在队列里
          </StatusBadge>
        )}
        {error && <span className="break-all text-xs text-destructive">{error}</span>}
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setAddOpen(true)} disabled={!configured} title={configured ? undefined : "先到设置页配好 OpenList 账号和挂载根"}>
          <Plus className="size-4" />
          新建复制
        </Button>
      </div>
      {items.length === 0 && <p className="text-xs text-muted-foreground">队列是空的。转存、追更、云下载、监控落下的新文件按任务设置自动排进来；网盘上已经有的用「新建复制」补。</p>}
      <ul className="divide-y">
        {items.map((c) => {
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
                  {c.afterCopy !== "keep" && <span className="text-xs text-muted-foreground">· 复制后{AFTER_COPY_LABEL[c.afterCopy]}</span>}
                </div>
                <p className="break-all text-xs text-muted-foreground">
                  → {c.dstDir}
                  {c.detail ? ` · ${c.detail}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {c.canRetry && (
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
                  onClick={() => setDropTarget(c)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {total > items.length && <p className="text-xs text-muted-foreground">只显示 {items.length} 条（能重试的、还在跑的排在前面），队列里共 {total} 条</p>}

      <AddCopyDialog open={addOpen} onOpenChange={setAddOpen} onQueued={() => void load()} />

      <AlertDialog open={dropTarget !== null} onOpenChange={(o) => !o && setDropTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>不跟这条复制了？</AlertDialogTitle>
            <AlertDialogDescription>
              「{dropTarget?.name}」会从队列里去掉。已经提交给 OpenList 的复制不会被取消，只是这边不再盯着它。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                const target = dropTarget;
                setDropTarget(null);
                if (target) void act(target.id, "remove");
              }}
            >
              去掉
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

"use client";

import { useState } from "react";
import { AlertTriangle, Ban, ChevronDown, ChevronRight, Loader2, RotateCw, Search, Undo2 } from "lucide-react";
import { toast } from "sonner";
import type { OrganizeFailureGroup, OrganizeFailureGroupKey, OrganizeRun, OrganizeRunStage } from "@openstrm/shared";
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
import { StatusBadge } from "@/components/status-badge";
import { api } from "@/lib/api";
import { baseName, dirName, failureGroupMeta, notifyOrganizeChanged, scopeLabel } from "@/lib/organize";
import { toastRunError, useRunItems } from "./helpers";

/** 一组失败项的文件清单：展开时才拉，详情刷新（version）时重拉 */
function GroupFiles({ runId, group, stage, version }: { runId: string; group: OrganizeFailureGroupKey; stage: OrganizeRunStage; version: number }) {
  const { items, error } = useRunItems(runId, { group }, true, version);
  if (error) return <p className="break-all text-xs text-destructive">{error}</p>;
  if (!items) {
    return (
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        加载中…
      </p>
    );
  }
  return (
    <ul className="space-y-1 text-xs">
      {items.map((it) => {
        const shown = it.action === "rmdir" ? it.srcPath : it.action === "mkdir" ? it.dstPath : stage === "revert" ? it.srcPath : it.dstPath;
        return (
          <li key={it.id} className="flex flex-wrap items-baseline gap-x-2">
            <span className="break-all">{baseName(shown)}</span>
            <span className="break-all text-muted-foreground">{dirName(shown)}</span>
            {it.attempts > 1 && <span className="text-muted-foreground tabular-nums">已试 {it.attempts} 轮</span>}
            {it.error && <span className="break-all text-destructive">{it.error}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** 失败面板：分组由后端算（OrganizeRunDetail.groups），这里只管文案和按钮；每组的文件清单展开时才拉 */
export function FailurePanel({
  run,
  groups,
  busy,
  version,
  onWorking,
  onChanged,
  onRevert,
  onOpenRun,
}: {
  run: OrganizeRun;
  groups: OrganizeFailureGroup[];
  busy: boolean;
  /** 详情刷新的次数：展开着的清单跟着重拉 */
  version: number;
  /** 放弃要在网盘上改回原名：进行中头部的执行 / 撤销 / 删除也得禁用 */
  onWorking: (working: boolean) => void;
  onChanged: () => Promise<void>;
  onRevert: () => void;
  onOpenRun: (id: string) => void;
}) {
  const [pending, setPending] = useState<{ type: "skip" | "repreview" | "retry"; group: OrganizeFailureGroup } | null>(null);
  const [working, setWorkingState] = useState(false);
  const setWorking = (w: boolean) => {
    setWorkingState(w);
    onWorking(w);
  };
  const [open, setOpen] = useState<Partial<Record<OrganizeFailureGroupKey, boolean>>>({});
  if (groups.length === 0) return null;
  const reverting = run.stage === "revert";
  const disabled = busy || working;

  const retry = async (group: OrganizeFailureGroup) => {
    if (reverting) {
      onRevert();
      return;
    }
    setWorking(true);
    try {
      await api.organize.apply(run.id, group.itemIds);
      toast.success(group.key === "mirror" ? `开始补本地镜像 ${group.itemIds.length} 项` : `开始重试 ${group.itemIds.length} 项`);
      notifyOrganizeChanged();
      await onChanged();
    } catch (err) {
      toastRunError(err, "重试失败", onOpenRun);
    } finally {
      setWorking(false);
    }
  };
  const confirmPending = async () => {
    if (!pending) return;
    const { type, group } = pending;
    if (type === "retry") {
      await retry(group);
      setPending(null);
      return;
    }
    setWorking(true);
    try {
      const r = await api.organize.skip(run.id, group.itemIds);
      const parts = [`已放弃 ${r.skipped} 项`];
      if (r.renamedBack > 0) parts.push(`${r.renamedBack} 项先改回了原名`);
      if (r.refused.length > 0) parts.push(`${r.refused.length} 项没能放弃：${r.refused[0].reason}`);
      if (r.refused.length > 0) toast.warning(parts.join("；"));
      else toast.success(parts.join("；"));
      notifyOrganizeChanged();
      if (type === "repreview") {
        const next = await api.organize.repreview(run.id);
        toast.success("按同一范围重新预览，请稍候");
        setPending(null);
        onOpenRun(next.id);
        return;
      }
      await onChanged();
    } catch (err) {
      toastRunError(err, "操作失败", onOpenRun);
      // 放弃可能已经做了、只是重新预览没建成：刷新一下照实显示
      await onChanged();
    } finally {
      setWorking(false);
      setPending(null);
    }
  };
  const pendingText = () => {
    if (!pending) return { title: "", body: "" };
    if (pending.type === "retry") {
      const g = pending.group;
      return {
        title: `重试这 ${g.itemIds.length} 项？`,
        body: `其中 ${g.deletes} 个是删除（冲突选了删掉 / 覆盖）：重试会在网盘上把它们删掉，进网盘回收站，撤销退不回来。不想删就先看文件、再点「放弃」。`,
      };
    }
    const n = pending.group.itemIds.length - pending.group.held;
    const heldNote = pending.group.held > 0 ? `另有 ${pending.group.held} 项已挪回但没改回原名，不能放弃，只能继续撤销。` : "";
    if (pending.type === "repreview") {
      return { title: "放弃这些项并重新预览？", body: `先把这 ${n} 项标成「已放弃」，再按同一范围（${scopeLabel(run)}）重新预览；已经整理好的会显示为「不变」，只剩真正没做的。` };
    }
    if (pending.group.key === "mirror") return { title: `放弃这 ${n} 项？`, body: "网盘上已经改好，只是本地 strm 没跟上。放弃后不再当失败项提醒；网盘监控看到这些文件的事件时仍会顺手把本地补上，也可以用全量同步或体检补齐。之后撤销这次整理时，这些文件照样退回原处。" };
    if (reverting) return { title: `放弃退回这 ${n} 项？`, body: `这些文件留在整理后的位置，不再退回；本地 strm 保持现状。放弃之后这次撤销就算收口了。${heldNote}` };
    return { title: `放弃这 ${n} 项？`, body: "这些项会标成「已放弃」，网盘和本地都不再动；原地改了名还没挪走的会先在网盘上改回原名。" };
  };
  const text = pendingText();

  return (
    <section className="space-y-3 rounded-xl border border-destructive/40 bg-card p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangle className="size-4 text-destructive" />
        {reverting ? "没退回的项" : "需要处理的项"}
      </div>
      {groups.map((g) => {
        const meta = failureGroupMeta(g.key, run.stage);
        return (
          <div key={g.key} className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={meta.tone} className="tabular-nums">
                {meta.label} · {g.itemIds.length}
              </StatusBadge>
              <span className="text-xs text-muted-foreground">{meta.hint}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {g.repreview && (
                <Button size="sm" className="h-8" disabled={disabled} onClick={() => setPending({ type: "repreview", group: g })}>
                  <Search className="size-4" />
                  重新预览
                </Button>
              )}
              {g.retry && (
                <Button
                  size="sm"
                  variant={g.repreview ? "outline" : "default"}
                  className="h-8"
                  disabled={disabled}
                  // 组里有删除项（重试会真删）就先确认；别的直接重试
                  onClick={() => (!reverting && g.deletes > 0 ? setPending({ type: "retry", group: g }) : void retry(g))}
                >
                  {reverting ? <Undo2 className="size-4" /> : <RotateCw className="size-4" />}
                  {reverting ? "继续撤销" : g.key === "mirror" ? "补本地" : "重试"}
                </Button>
              )}
              {g.skip && g.itemIds.length > g.held && (
                <Button size="sm" variant="outline" className="h-8" disabled={disabled} onClick={() => setPending({ type: "skip", group: g })}>
                  <Ban className="size-4" />
                  放弃
                </Button>
              )}
              {g.held > 0 && <span className="text-xs text-muted-foreground">{g.held} 项已挪回没改回原名，只能继续撤销</span>}
              <button type="button" className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}>
                {open[g.key] ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {open[g.key] ? "收起" : "看文件"}
              </button>
            </div>
            {open[g.key] && <GroupFiles runId={run.id} group={g.key} stage={run.stage} version={version} />}
          </div>
        );
      })}

      <AlertDialog open={pending != null} onOpenChange={(o) => !o && !working && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{text.title}</AlertDialogTitle>
            <AlertDialogDescription>{text.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmPending();
              }}
              disabled={working}
            >
              {working ? <Loader2 className="size-4 animate-spin" /> : pending?.type === "repreview" ? "放弃并重新预览" : pending?.type === "retry" ? "重试" : "放弃"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Ban, ChevronDown, ChevronRight, Film, Loader2, Play, RefreshCw, RotateCw, Search, Square, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import type { OrganizeRun, OrganizeRunDetail, OrganizeRunStatus, OrganizeUnit, OrganizeUnitPatch } from "@openstrm/shared";
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
import { StatusBadge, TONE_CLASS } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { Spinner, TableSkeleton } from "@/components/loading";
import { api, type TaskRow } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { fmtTime } from "@/lib/format";
import { RUN_STATUS_META, TRIGGER_LABEL, isBusyStatus, notifyOrganizeChanged } from "@/lib/organize";
import { AdjustDialog } from "./AdjustDialog";
import { FailurePanel } from "./FailurePanel";
import { MatchDialog } from "./MatchDialog";
import { UnitList } from "./UnitList";
import { POLL_MS, plannedText, toastRunError } from "./helpers";

/** 执行 / 撤销中每隔几次 summary 拉一次完整详情：单元卡上的数字、展开着的文件表跟着变 */
const FULL_EVERY = 5;

export function RunView({
  runId,
  tasks,
  onClose,
  onOpenRun,
  onLoaded,
}: {
  runId: string;
  tasks: TaskRow[] | null;
  onClose: () => void;
  onOpenRun: (id: string) => void;
  /** 第一次读到这次整理时告诉页面（页面把任务下拉框和范围切过来） */
  onLoaded?: (run: OrganizeRun) => void;
}) {
  const [detail, setDetail] = useState<OrganizeRunDetail | null>(null);
  /** 完整详情拉了几次：展开着的文件清单按它重拉 */
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [matching, setMatching] = useState<OrganizeUnit | null>(null);
  const [adjusting, setAdjusting] = useState<OrganizeUnit | null>(null);
  const [confirm, setConfirm] = useState<"apply" | "revert" | "delete" | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [showScopes, setShowScopes] = useState(false);
  /** 正在保存修改的单元（换匹配 / 季集偏移 / 勾选 / 按文件勾选） */
  const [patching, setPatching] = useState<ReadonlySet<string>>(new Set());
  /** 失败面板在放弃（要在网盘上改回原名） */
  const [panelWorking, setPanelWorking] = useState(false);
  const fullSeq = useRef(0);
  const sumSeq = useRef(0);
  const lastStatus = useRef<OrganizeRunStatus | null>(null);
  const reported = useRef(false);
  const logRef = useRef<HTMLPreElement>(null);

  /**
   * 状态变了（包括第一次读到）：待处理可能跟着变（预览好了待执行、执行完有失败、撤销没退完…），让侧栏角标刷新。
   * 第一次读到也要算：预览常常在页面第一次读详情之前就做完了，看不到「进行中 → 待执行」这一下
   */
  const seen = useCallback((status: OrganizeRunStatus) => {
    if (lastStatus.current !== status) notifyOrganizeChanged();
    lastStatus.current = status;
  }, []);

  const load = useCallback(async () => {
    const n = ++fullSeq.current;
    try {
      const d = await api.organize.getRun(runId);
      if (n !== fullSeq.current) return;
      seen(d.run.status);
      setDetail(d);
      setVersion((v) => v + 1);
      setError(null);
    } catch (err) {
      if (n !== fullSeq.current) return;
      setError(apiErrorMessage(err, "读取整理记录失败"));
    }
  }, [runId, seen]);

  /** 进行中只拉 run 和开关（不带单元和项）；一结束就拉一次完整详情，别拿「待执行 + 0 个单元」闪一下 */
  const loadSummary = useCallback(async () => {
    const n = ++sumSeq.current;
    try {
      const s = await api.organize.summary(runId);
      if (n !== sumSeq.current) return;
      seen(s.run.status);
      if (!isBusyStatus(s.run.status)) {
        void load();
        return;
      }
      setDetail((d) => (d ? { ...d, ...s } : d));
    } catch {
      /* 下一轮再拉 */
    }
  }, [runId, seen, load]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!detail || reported.current) return;
    reported.current = true;
    onLoaded?.(detail.run);
  }, [detail, onLoaded]);

  const status = detail?.run.status;
  useEffect(() => {
    if (!status || !isBusyStatus(status)) return;
    let tick = 0;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      tick += 1;
      if (tick % FULL_EVERY === 0) void load();
      else void loadSummary();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [status, load, loadSummary]);

  // 日志展开着就一直停在最底下
  const logLength = detail?.run.log.length ?? 0;
  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [showLog, logLength]);

  const markPatching = (keys: string[], on: boolean) =>
    setPatching((s) => {
      const next = new Set(s);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  /** 改单元：进行中这个单元转圈，执行 / 撤销 / 删除先禁用（后端也会回 409，这里是别让人点）；成功返回 true */
  const patchUnit = async (unit: OrganizeUnit, patch: OrganizeUnitPatch): Promise<boolean> => {
    markPatching([unit.key], true);
    try {
      await api.organize.patchUnit(runId, unit.key, patch);
      await load();
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, "修改失败"));
      // 失败多半是这次预览已经不能改了（执行了 / 取消了 / 进程重启过）：刷新一下，页面照实显示
      await load();
      return false;
    } finally {
      markPatching([unit.key], false);
    }
  };

  /** 批量勾选（一次重规划）；「只选把握大的」是把握大的勾上、其余取消，两次批量 */
  const bulk = async (steps: Array<{ keys: string[]; selected: boolean }>) => {
    const keys = steps.flatMap((s) => s.keys);
    if (keys.length === 0) return;
    markPatching(keys, true);
    try {
      let changed = 0;
      for (const s of steps) if (s.keys.length > 0) changed += (await api.organize.patchUnits(runId, s.keys, { selected: s.selected })).changed;
      if (changed === 0) toast.info("列出的作品已经是这样勾的了");
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, "修改失败"));
      await load();
    } finally {
      markPatching(keys, false);
    }
  };

  /** 按文件勾选：取消勾选的文件留在原处，跟着它的字幕 / nfo 一起留下 */
  const toggleItems = async (unit: OrganizeUnit, ids: string[], selected: boolean) => {
    markPatching([unit.key], true);
    try {
      await api.organize.patchItems(runId, ids, selected);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, "修改失败"));
      await load();
    } finally {
      markPatching([unit.key], false);
    }
  };

  const repreview = async () => {
    setBusy(true);
    try {
      const next = await api.organize.repreview(runId);
      toast.success("按同一范围重新预览，请稍候");
      notifyOrganizeChanged();
      onOpenRun(next.id);
    } catch (err) {
      toastRunError(err, "重新预览失败", onOpenRun);
    } finally {
      setBusy(false);
    }
  };

  const act = async (kind: "apply" | "cancel" | "revert" | "delete") => {
    setBusy(true);
    try {
      if (kind === "apply") await api.organize.apply(runId);
      else if (kind === "cancel") await api.organize.cancel(runId);
      else if (kind === "revert") await api.organize.revert(runId);
      else {
        await api.organize.remove(runId);
        toast.success("已删除这条整理记录");
        notifyOrganizeChanged();
        onClose();
        return;
      }
      toast.success(kind === "apply" ? "开始执行" : kind === "cancel" ? "已取消" : "开始撤销");
      notifyOrganizeChanged();
      await load();
    } catch (err) {
      toastRunError(err, "操作失败", onOpenRun);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  if (error && !detail) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="读不到这条整理记录"
        description={error}
        action={
          <Button variant="outline" onClick={onClose}>
            返回
          </Button>
        }
      />
    );
  }
  if (!detail) return <TableSkeleton rows={4} />;

  const { run, units, counts, dirCount, groups, revertable, applicable, editable, executed, outdated } = detail;
  const outdatedRunId = outdated?.kind === "changed" ? outdated.runId : undefined;
  const blockedBy = revertable.blockedBy;
  const meta = RUN_STATUS_META[run.status];
  const canApply = applicable.ok;
  const canCancel = isBusyStatus(run.status);
  const reverting = run.stage === "revert";
  // 改单元 / 放弃还在保存的时候不给执行、撤销、删除（后端也会回 409）
  const locked = busy || panelWorking || patching.size > 0;
  // 预览没做完（列目录 / 识别中途失败或被取消）：没有单元，也没有统计可看
  const previewFailed = units.length === 0 && run.stage === "apply" && (run.status === "failed" || run.status === "cancelled");
  const mirrorLeft = run.stats.failedByKind.mirror;
  const unsure = units.filter((u) => u.selected && (!u.match || u.match.confidence !== "high")).length;
  const task = tasks?.find((t) => t.id === run.taskId) ?? null;
  const origin = task ? task.originPath.replace(/\/+$/, "") : "";
  const full = (p: string) => (origin ? `${origin}/${p}` : p);
  const manualScopes = run.trigger === "manual";

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={meta.tone} pulse={meta.pulse}>
                {meta.label}
              </StatusBadge>
              <span className="text-xs text-muted-foreground">
                {TRIGGER_LABEL[run.trigger]} · {fmtTime(run.createdAt * 1000)}
              </span>
            </div>
            {task && (
              <div className="break-all text-xs text-muted-foreground">
                任务：{task.originPath} → {task.targetPath}
              </div>
            )}
            <div className="break-all text-sm">
              范围：
              {run.scopePaths.length === 0 ? (
                run.scopePath ? (
                  full(run.scopePath)
                ) : (
                  "整个任务"
                )
              ) : (
                <button type="button" className="inline-flex items-center gap-0.5 hover:text-brand" onClick={() => setShowScopes((v) => !v)}>
                  {manualScopes ? `${run.scopePaths.length} 个目录` : `${run.scopePaths.length} 个新增路径`}
                  {showScopes ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                </button>
              )}
            </div>
            {showScopes && run.scopePaths.length > 0 && (
              <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
                {run.scopePaths.map((p) => (
                  <li key={p} className="break-all">
                    {full(p)}
                  </li>
                ))}
              </ul>
            )}
            {run.error && !previewFailed && <div className="break-all text-xs text-destructive">{run.error}</div>}
            {!revertable.ok && blockedBy && (
              <div className="text-xs text-muted-foreground">
                不能撤销：{revertable.reason}
                <button type="button" className="ml-1 text-brand hover:underline" onClick={() => onOpenRun(blockedBy.id)}>
                  打开那一次（{fmtTime(blockedBy.createdAt * 1000)}）
                </button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            {canCancel && (
              <Button variant="outline" size="sm" onClick={() => void act("cancel")} disabled={busy}>
                <Square className="size-4" />
                取消
              </Button>
            )}
            {(run.status === "ready" || (!executed && (run.status === "cancelled" || run.status === "failed"))) && (
              <Button variant="outline" size="sm" onClick={() => void repreview()} disabled={locked} title="按同一范围重新列目录、识别、规划">
                <Search className="size-4" />
                重新预览
              </Button>
            )}
            {canApply && (
              <Button size="sm" onClick={() => setConfirm("apply")} disabled={locked}>
                {run.status === "ready" ? <Play className="size-4" /> : <RotateCw className="size-4" />}
                {run.status === "ready" ? `执行 ${run.stats.planned} 项` : `重试失败项（${applicable.count}）`}
              </Button>
            )}
            {revertable.ok && (
              <Button variant={reverting ? "default" : "outline"} size="sm" onClick={() => setConfirm("revert")} disabled={locked}>
                <Undo2 className="size-4" />
                {reverting ? "继续撤销" : "撤销"}
              </Button>
            )}
            {!isBusyStatus(run.status) && (
              <Button variant="ghost" size="icon" className="size-8 text-destructive hover:text-destructive" title="删除记录" onClick={() => setConfirm("delete")} disabled={locked}>
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        </div>

        {run.progress && isBusyStatus(run.status) && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="break-all">{run.progress.message}</span>
              {run.progress.total > 0 && (
                <span className="tabular-nums">
                  {run.progress.done} / {run.progress.total}
                </span>
              )}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full ${TONE_CLASS.brand.bar} transition-all`}
                style={{ width: run.progress.total > 0 ? `${Math.round((run.progress.done / run.progress.total) * 100)}%` : "30%" }}
              />
            </div>
          </div>
        )}

        {!previewFailed && (
          <div className="flex flex-wrap gap-2 text-xs">
            <StatusBadge tone="neutral" className="tabular-nums">
              {run.stats.units} 部作品
            </StatusBadge>
            <StatusBadge tone="brand" className="tabular-nums">
              {run.stats.planned} 项要动
            </StatusBadge>
            {run.stats.keep > 0 && <StatusBadge tone="neutral" className="tabular-nums">{run.stats.keep} 项已规范</StatusBadge>}
            {run.stats.conflicts > 0 && <StatusBadge tone="danger" className="tabular-nums">{run.stats.conflicts} 项冲突</StatusBadge>}
            {run.stats.skipped > 0 && <StatusBadge tone="neutral" className="tabular-nums">{run.stats.skipped} 项跳过</StatusBadge>}
            {!reverting && run.stats.done > 0 && <StatusBadge tone="success" className="tabular-nums">{run.stats.done} 项完成</StatusBadge>}
            {!reverting && run.stats.failed > 0 && <StatusBadge tone="danger" className="tabular-nums">{run.stats.failed} 项失败</StatusBadge>}
            {reverting && run.stats.reverted > 0 && <StatusBadge tone="success" className="tabular-nums">{run.stats.reverted} 项已退回</StatusBadge>}
            {reverting && run.stats.notReverted > 0 && <StatusBadge tone="danger" className="tabular-nums">{run.stats.notReverted} 项没退回</StatusBadge>}
            {mirrorLeft > 0 && <StatusBadge tone="warning" className="tabular-nums">{mirrorLeft} 项本地未同步</StatusBadge>}
            {unsure > 0 && run.status === "ready" && <StatusBadge tone="warning" className="tabular-nums">{unsure} 部识别把握不大</StatusBadge>}
          </div>
        )}

        {run.log.length > 0 && (
          <div>
            <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowLog((v) => !v)}>
              {showLog ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              日志（{run.log.length}）
            </button>
            {showLog && (
              <pre ref={logRef} className="mt-2 max-h-60 overflow-auto rounded-md bg-muted/50 p-2 text-xs leading-relaxed">
                {run.log.join("\n")}
              </pre>
            )}
          </div>
        )}
      </section>

      {run.status === "ready" && (!editable || outdated) && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 space-y-1">
            {outdated?.kind === "changed" && (
              <p>
                预览之后这个任务又整理 / 撤销过（{fmtTime(outdated.at * 1000)}
                {outdatedRunId && (
                  <button type="button" className="ml-1 text-brand hover:underline" onClick={() => onOpenRun(outdatedRunId)}>
                    看那一次
                  </button>
                )}
                ），网盘可能已经变了，建议重新预览再执行。
              </p>
            )}
            {outdated?.kind === "old" && <p>这是 {Math.max(1, Math.floor((Date.now() / 1000 - outdated.at) / 86400))} 天前的预览，网盘可能已经变了，建议重新预览再执行。</p>}
            {!editable && <p>这次预览是上次启动时做的，单元结构没保存下来，不能再换匹配、改季集或勾选；可以直接执行，或者重新预览。</p>}
          </div>
          <Button size="sm" variant="outline" onClick={() => void repreview()} disabled={locked}>
            <Search className="size-4" />
            重新预览
          </Button>
        </div>
      )}

      {!isBusyStatus(run.status) && run.status !== "ready" && (
        <FailurePanel run={run} groups={groups} busy={busy} version={version} onWorking={setPanelWorking} onChanged={load} onRevert={() => setConfirm("revert")} onOpenRun={onOpenRun} />
      )}

      {run.status === "planning" && units.length === 0 ? (
        <Spinner label="正在列目录、识别作品…" />
      ) : previewFailed ? (
        <EmptyState
          icon={run.status === "failed" ? AlertTriangle : Ban}
          title={run.status === "failed" ? "预览没做完" : "预览已取消"}
          description={run.status === "failed" ? run.error || "列目录或识别的时候出错了。" : "这次预览在识别完之前被取消了。"}
          action={
            <Button onClick={() => void repreview()} disabled={locked}>
              <Search className="size-4" />
              重新预览
            </Button>
          }
        />
      ) : units.length === 0 ? (
        <EmptyState icon={Film} title="范围里没有视频文件" description="换一个目录，或检查设置里的 strm 扩展名。" />
      ) : (
        <UnitList
          runId={runId}
          units={units}
          counts={counts}
          dirCount={dirCount}
          stage={run.stage}
          version={version}
          ready={run.status === "ready"}
          editable={editable}
          patching={patching}
          busy={locked}
          onPatch={(u, patch) => void patchUnit(u, patch)}
          onBulk={(keys, selected) => void bulk([{ keys, selected }])}
          onOnlyHigh={(list) =>
            void bulk([
              { keys: list.filter((u) => u.match && u.match.confidence !== "high").map((u) => u.key), selected: false },
              { keys: list.filter((u) => u.match?.confidence === "high").map((u) => u.key), selected: true },
            ])
          }
          onToggleItems={(u, ids, selected) => void toggleItems(u, ids, selected)}
          onMatch={setMatching}
          onAdjust={setAdjusting}
        />
      )}

      <MatchDialog unit={matching} onOpenChange={(o) => !o && setMatching(null)} onPick={(pick) => (matching ? patchUnit(matching, { match: pick }) : Promise.resolve(false))} />
      <AdjustDialog unit={adjusting} onOpenChange={(o) => !o && setAdjusting(null)} onSave={(p) => (adjusting ? patchUnit(adjusting, p) : Promise.resolve(false))} />

      <AlertDialog open={confirm != null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "apply" ? "在网盘上执行整理" : confirm === "revert" ? "撤销这次整理" : "删除整理记录"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "apply" &&
                (run.status === "ready"
                  ? `会在网盘上${plannedText(run.stats)}，本地 strm 跟着挪。Emby 会把改名后的条目当新条目，播放记录可能丢失。${unsure > 0 ? `有 ${unsure} 部识别把握不大，建议先确认。` : ""}`
                  : `只重试失败和没做的 ${applicable.count} 项（临时失败、风控中断、本地没跟上的），已完成的不会重做。「预览后变了」「名字不被接受」的项不在里面，在上面的面板里单独处理。`)}
              {confirm === "revert" && (reverting ? "把还没退回的项接着退回原处；已经退回的不会重做。" : "按记录把文件退回原来的位置和名字；已经被别的操作动过的项会跳过，之后可以放弃。")}
              {confirm === "delete" && "只删这条记录，网盘和本地文件都不动；删掉之后就不能撤销这次整理了。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (confirm) void act(confirm);
              }}
              disabled={busy}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : confirm === "apply" ? "执行" : confirm === "revert" ? "撤销" : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

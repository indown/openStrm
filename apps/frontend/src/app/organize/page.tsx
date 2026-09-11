"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Film,
  FolderOpen,
  FolderTree,
  History,
  Loader2,
  Play,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Square,
  Trash2,
  Tv,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import type { OrganizeItem, OrganizeRun, OrganizeRunDetail, OrganizeUnit } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { PageHeader } from "@/components/page-header";
import { StatusBadge, TONE_CLASS } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { Spinner, TableSkeleton } from "@/components/loading";
import { DirectoryTreeDialog } from "@/app/home/components/DirectoryTreeDialog";
import { api, type TaskRow } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { fmtTime } from "@/lib/format";
import { ACTION_META, CONFIDENCE_META, RUN_STATUS_META, TRIGGER_LABEL, baseName, dirName, isBusyStatus } from "@/lib/organize";
import { MatchDialog } from "./components/MatchDialog";
import { AdjustDialog } from "./components/AdjustDialog";

const DESCRIPTION = "识别网盘里的影视文件，按 TMDB 规范命名并归到标准目录；先预览再执行，做过的能撤销";
const POLL_MS = 2000;

export default function OrganizePage() {
  return (
    <React.Suspense
      fallback={
        <div className="space-y-6">
          <PageHeader icon={FolderTree} title="整理" description={DESCRIPTION} />
          <TableSkeleton rows={4} />
        </div>
      }
    >
      <OrganizeContent />
    </React.Suspense>
  );
}

function OrganizeContent() {
  const router = useRouter();
  const search = useSearchParams();
  const runId = search.get("run") ?? "";
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [taskId, setTaskId] = useState(search.get("task") ?? "");
  const [subPath, setSubPath] = useState(search.get("path") ?? "");
  const [browsing, setBrowsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    api.tasks
      .list()
      .then((rows) => {
        setTasks(rows);
        setTaskId((prev) => (prev && rows.some((t) => t.id === prev) ? prev : (rows[0]?.id ?? "")));
      })
      .catch((err) => {
        setTasks([]);
        toast.error(apiErrorMessage(err, "读取任务列表失败"));
      });
  }, []);

  const task = useMemo(() => tasks?.find((t) => t.id === taskId) ?? null, [tasks, taskId]);

  const openRun = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams();
      if (taskId) params.set("task", taskId);
      if (id) params.set("run", id);
      router.replace(`/organize${params.size ? `?${params}` : ""}`);
    },
    [router, taskId],
  );

  const createRun = async () => {
    if (!taskId) return;
    setCreating(true);
    try {
      const run = await api.organize.createRun({ taskId, subPath: subPath.trim() });
      openRun(run.id);
      toast.success("开始识别，请稍候");
    } catch (err) {
      toast.error(apiErrorMessage(err, "预览失败"));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FolderTree}
        title="整理"
        description={DESCRIPTION}
        actions={
          <Button variant="outline" onClick={() => setHistoryOpen(true)} disabled={!taskId}>
            <History className="size-4" />
            历史
          </Button>
        }
      />

      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">任务</label>
            {tasks === null ? (
              <div className="text-sm text-muted-foreground">加载中…</div>
            ) : tasks.length === 0 ? (
              <div className="text-sm text-muted-foreground">还没有任务，先到「任务」页建一个。</div>
            ) : (
              <Select value={taskId} onValueChange={(v) => { setTaskId(v); setSubPath(""); }}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择任务" />
                </SelectTrigger>
                <SelectContent>
                  {tasks.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.originPath} → {t.targetPath}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">范围（相对任务目录，留空整理整个任务）</label>
            <div className="flex items-center gap-2">
              <Input value={subPath} onChange={(e) => setSubPath(e.target.value)} placeholder={task ? `${task.originPath}/…` : ""} />
              <Button type="button" variant="outline" size="icon" onClick={() => setBrowsing(true)} disabled={!task} title="浏览网盘目录">
                <FolderOpen className="size-4" />
              </Button>
            </div>
          </div>
          <div className="flex items-end">
            <Button onClick={() => void createRun()} disabled={!taskId || creating} className="w-full md:w-auto">
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              预览
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          预览只读网盘和 TMDB，不改任何东西；确认清单后点「执行」才会在网盘上改名 / 移动，本地 strm 会跟着走。
        </p>
      </section>

      {runId ? (
        <RunView key={runId} runId={runId} onClose={() => openRun(null)} />
      ) : (
        <EmptyState icon={FolderTree} title="还没有预览" description="选好任务和范围，点「预览」；或者从「历史」里打开之前的整理记录。" />
      )}

      {task && (
        <DirectoryTreeDialog
          open={browsing}
          onOpenChange={setBrowsing}
          account={task.account}
          onSelect={(p) => {
            const origin = task.originPath.replace(/^\/+|\/+$/g, "");
            const rel = p === origin ? "" : p.startsWith(`${origin}/`) ? p.slice(origin.length + 1) : p;
            setSubPath(rel);
          }}
        />
      )}
      <HistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} taskId={taskId} onPick={(id) => { setHistoryOpen(false); openRun(id); }} />
    </div>
  );
}

/* ------------------------------- run ------------------------------- */

function RunView({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<OrganizeRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [matching, setMatching] = useState<OrganizeUnit | null>(null);
  const [adjusting, setAdjusting] = useState<OrganizeUnit | null>(null);
  const [confirm, setConfirm] = useState<"apply" | "revert" | "delete" | null>(null);
  const [showLog, setShowLog] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const d = await api.organize.getRun(runId);
      if (n !== seq.current) return;
      setDetail(d);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setError(apiErrorMessage(err, "读取整理记录失败"));
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const status = detail?.run.status;
  useEffect(() => {
    if (!status || !isBusyStatus(status)) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [status, load]);

  const patchUnit = async (unit: OrganizeUnit, patch: Parameters<typeof api.organize.patchUnit>[2]) => {
    try {
      await api.organize.patchUnit(runId, unit.key, patch);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, "修改失败"));
      throw err;
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
        onClose();
        return;
      }
      toast.success(kind === "apply" ? "开始执行" : kind === "cancel" ? "已取消" : "开始撤销");
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, "操作失败"));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  if (error && !detail) {
    return <EmptyState icon={AlertTriangle} title="读不到这条整理记录" description={error} action={<Button variant="outline" onClick={onClose}>返回</Button>} />;
  }
  if (!detail) return <TableSkeleton rows={4} />;

  const { run, units, items, revertable } = detail;
  const meta = RUN_STATUS_META[run.status];
  const retryable = items.some((i) => (i.status === "pending" || i.status === "failed") && ["rename", "move", "mkdir", "rmdir"].includes(i.action));
  const canApply = (run.status === "ready" && run.stats.planned > 0) || ((run.status === "failed" || run.status === "cancelled" || run.status === "done") && retryable);
  const canCancel = isBusyStatus(run.status);
  const itemsByUnit = new Map<string, OrganizeItem[]>();
  for (const it of items) {
    const list = itemsByUnit.get(it.unitKey) ?? [];
    list.push(it);
    itemsByUnit.set(it.unitKey, list);
  }
  const dirItems = itemsByUnit.get("") ?? [];
  const unsure = units.filter((u) => u.selected && (!u.match || u.match.confidence !== "high")).length;

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
            <div className="break-all text-sm">
              范围：{run.scopePath || "整个任务"}
              {run.scopePaths.length > 0 && `（${run.scopePaths.length} 个新增路径）`}
            </div>
            {run.error && <div className="break-all text-xs text-destructive">{run.error}</div>}
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
            {canApply && (
              <Button size="sm" onClick={() => setConfirm("apply")} disabled={busy}>
                <Play className="size-4" />
                {run.status === "ready" ? `执行 ${run.stats.planned} 项` : "继续执行"}
              </Button>
            )}
            {revertable.ok && (
              <Button variant="outline" size="sm" onClick={() => setConfirm("revert")} disabled={busy}>
                <Undo2 className="size-4" />
                撤销
              </Button>
            )}
            {!isBusyStatus(run.status) && (
              <Button variant="ghost" size="icon" className="size-8 text-destructive hover:text-destructive" title="删除记录" onClick={() => setConfirm("delete")} disabled={busy}>
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

        <div className="flex flex-wrap gap-2 text-xs">
          <StatusBadge tone="neutral" className="tabular-nums">{run.stats.units} 部作品</StatusBadge>
          <StatusBadge tone="brand" className="tabular-nums">{run.stats.planned} 项要动</StatusBadge>
          {run.stats.keep > 0 && <StatusBadge tone="neutral" className="tabular-nums">{run.stats.keep} 项已规范</StatusBadge>}
          {run.stats.conflicts > 0 && <StatusBadge tone="danger" className="tabular-nums">{run.stats.conflicts} 项冲突</StatusBadge>}
          {run.stats.skipped > 0 && <StatusBadge tone="neutral" className="tabular-nums">{run.stats.skipped} 项跳过</StatusBadge>}
          {run.stats.done > 0 && <StatusBadge tone="success" className="tabular-nums">{run.stats.done} 项完成</StatusBadge>}
          {run.stats.failed > 0 && <StatusBadge tone="danger" className="tabular-nums">{run.stats.failed} 项失败</StatusBadge>}
          {unsure > 0 && run.status === "ready" && <StatusBadge tone="warning" className="tabular-nums">{unsure} 部识别把握不大</StatusBadge>}
        </div>

        {run.log.length > 0 && (
          <div>
            <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowLog((v) => !v)}>
              {showLog ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              日志（{run.log.length}）
            </button>
            {showLog && (
              <pre className="mt-2 max-h-60 overflow-auto rounded-md bg-muted/50 p-2 text-xs leading-relaxed">{run.log.slice(-100).join("\n")}</pre>
            )}
          </div>
        )}
      </section>

      {run.status === "planning" && units.length === 0 ? (
        <Spinner label="正在列目录、识别作品…" />
      ) : units.length === 0 ? (
        <EmptyState icon={Film} title="范围里没有视频文件" description="换一个目录，或检查设置里的 strm 扩展名。" />
      ) : (
        <div className="space-y-3">
          {units.map((u) => (
            <UnitCard
              key={u.key}
              unit={u}
              items={itemsByUnit.get(u.key) ?? []}
              editable={run.status === "ready"}
              onToggle={(selected) => void patchUnit(u, { selected })}
              onRemember={(remember) => void patchUnit(u, { remember })}
              onMatch={() => setMatching(u)}
              onAdjust={() => setAdjusting(u)}
            />
          ))}
          {dirItems.length > 0 && <DirItems items={dirItems} />}
        </div>
      )}

      <MatchDialog unit={matching} onOpenChange={(o) => !o && setMatching(null)} onPick={(pick) => (matching ? patchUnit(matching, { match: pick }) : Promise.resolve())} />
      <AdjustDialog unit={adjusting} onOpenChange={(o) => !o && setAdjusting(null)} onSave={(p) => (adjusting ? patchUnit(adjusting, p) : Promise.resolve())} />

      <AlertDialog open={confirm != null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "apply" ? "在网盘上执行整理" : confirm === "revert" ? "撤销这次整理" : "删除整理记录"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "apply" &&
                `会在网盘上改名 / 移动 ${run.stats.planned} 项，本地 strm 跟着挪。Emby 会把改名后的条目当新条目，播放记录可能丢失。${unsure > 0 ? `有 ${unsure} 部识别把握不大，建议先确认。` : ""}`}
              {confirm === "revert" && "按记录把文件退回原来的位置和名字；已经被别的操作动过的项会跳过。"}
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

/* ------------------------------- unit ------------------------------- */

function UnitCard({
  unit,
  items,
  editable,
  onToggle,
  onRemember,
  onMatch,
  onAdjust,
}: {
  unit: OrganizeUnit;
  items: OrganizeItem[];
  editable: boolean;
  onToggle: (selected: boolean) => void;
  onRemember: (remember: boolean) => void;
  onMatch: () => void;
  onAdjust: () => void;
}) {
  const [open, setOpen] = useState(false);
  // 海报加载失败（TMDB 图片被墙）就退回图标，别把 alt 文字画在卡片上
  const [posterBroken, setPosterBroken] = useState(false);
  const m = unit.match;
  const conf = CONFIDENCE_META[m?.confidence ?? "none"];
  const changing = items.filter((i) => i.action === "rename" || i.action === "move").length;
  const conflicts = items.filter((i) => i.action === "conflict").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const tmdbUrl = m ? `https://www.themoviedb.org/${m.mediaType}/${m.tmdbId}` : "";

  return (
    <div className={`rounded-xl border bg-card p-4 ${unit.selected ? "" : "opacity-60"}`}>
      <div className="flex gap-3">
        <div className="relative hidden h-24 w-16 shrink-0 overflow-hidden rounded-md bg-muted sm:block">
          {m?.posterUrl && !posterBroken ? (
            <Image src={m.posterUrl} alt="" fill className="object-cover" unoptimized onError={() => setPosterBroken(true)} />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">{m?.mediaType === "tv" ? <Tv className="size-5" /> : <Film className="size-5" />}</div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {editable && <Checkbox checked={unit.selected} onCheckedChange={(v) => onToggle(v === true)} disabled={!m} title={m ? "勾上才会执行" : "没识别出来的不能执行"} />}
            <span className="break-all text-sm font-medium">{m ? `${m.title}${m.year ? ` (${m.year})` : ""}` : unit.parsedTitle || unit.rawName}</span>
            <StatusBadge tone={conf.tone} title={conf.hint}>
              {conf.label}
            </StatusBadge>
            {m && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                {m.mediaType === "tv" ? <Tv className="size-3" /> : <Film className="size-3" />}
                {m.mediaType === "tv" ? "剧集" : "电影"}
                <a href={tmdbUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-foreground">
                  #{m.tmdbId}
                  <ExternalLink className="size-3" />
                </a>
              </span>
            )}
          </div>
          <div className="break-all text-xs text-muted-foreground">
            原：{unit.rootPath || "（任务根目录）"}
            {unit.rootPath && unit.rawName !== baseName(unit.rootPath) ? ` · ${unit.rawName}` : ""}
          </div>
          {unit.dstRoot && <div className="break-all text-xs text-muted-foreground">→ {unit.dstRoot}</div>}
          {m && <div className="text-xs text-muted-foreground">{m.reason}</div>}
          {unit.notes.map((n, i) => (
            <div key={i} className="flex items-start gap-1 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span className="break-all">{n}</span>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
            <span>{unit.fileCount} 个文件（{unit.videoCount} 个视频）</span>
            {changing > 0 && <span className="text-brand">{changing} 项要动</span>}
            {conflicts > 0 && <span className="text-destructive">{conflicts} 项冲突</span>}
            {failed > 0 && <span className="text-destructive">{failed} 项失败</span>}
            {unit.referencedBy > 0 && <span>被 {unit.referencedBy} 条追更 / 云下载引用，执行后自动改写</span>}
            {unit.seasonOverride != null && <span>季 → {unit.seasonOverride}</span>}
            {unit.episodeOffset !== 0 && <span>集偏移 {unit.episodeOffset > 0 ? `+${unit.episodeOffset}` : unit.episodeOffset}</span>}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        {editable && (
          <>
            <Button variant="outline" size="sm" className="h-8" onClick={onMatch}>
              <Search className="size-4" />
              换匹配
            </Button>
            {m?.mediaType === "tv" && (
              <Button variant="outline" size="sm" className="h-8" onClick={onAdjust}>
                <SlidersHorizontal className="size-4" />
                季 / 集偏移
              </Button>
            )}
            {m && (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox checked={unit.remember} onCheckedChange={(v) => onRemember(v === true)} />
                记住这个识别
              </label>
            )}
          </>
        )}
        <button type="button" className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {open ? "收起" : "看文件"}（{items.length}）
        </button>
      </div>
      {open && <ItemsTable items={items} />}
    </div>
  );
}

function ItemStatus({ it }: { it: OrganizeItem }) {
  if (it.status === "done") return <StatusBadge tone={it.error ? "warning" : "success"} title={it.error || undefined}>{it.error ? "完成，本地未同步" : "完成"}</StatusBadge>;
  if (it.status === "failed") return <StatusBadge tone="danger" title={it.error}>失败</StatusBadge>;
  if (it.curPath) return <StatusBadge tone="warning" title={it.curPath}>已改名，待移动</StatusBadge>;
  if (it.status === "reverted") return <StatusBadge tone="neutral">已退回</StatusBadge>;
  if (it.status === "skipped") return <StatusBadge tone="neutral" title={it.error}>跳过</StatusBadge>;
  const a = ACTION_META[it.action];
  return <StatusBadge tone={a.tone}>{a.label}</StatusBadge>;
}

function ItemsTable({ items }: { items: OrganizeItem[] }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-md border">
      <table className="w-full min-w-[640px] text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium">动作</th>
            <th className="px-2 py-1.5 text-left font-medium">原来</th>
            <th className="px-2 py-1.5 text-left font-medium">整理后</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const changed = it.action === "rename" || it.action === "move";
            return (
              <tr key={it.id} className="border-t align-top">
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <ItemStatus it={it} />
                </td>
                <td className="px-2 py-1.5">
                  <div className="break-all">{baseName(it.srcPath)}</div>
                  <div className="break-all text-muted-foreground">{dirName(it.srcPath)}</div>
                  {(it.reason || it.error) && <div className="break-all text-destructive">{it.error || it.reason}</div>}
                </td>
                <td className="px-2 py-1.5">
                  {changed || it.action === "conflict" ? (
                    <>
                      <div className={`break-all ${changed ? "font-medium" : ""}`}>{baseName(it.dstPath)}</div>
                      <div className="break-all text-muted-foreground">{dirName(it.dstPath)}</div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 建目录 / 删空目录：不属于某个作品，单独列 */
function DirItems({ items }: { items: OrganizeItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border bg-card p-4">
      <button type="button" className="flex w-full items-center gap-1 text-sm" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        目录操作（{items.length}）
        <span className="ml-2 text-xs text-muted-foreground">建目标目录、删腾空的源目录</span>
      </button>
      {open && (
        <ul className="mt-3 space-y-1 text-xs">
          {items.map((it) => (
            <li key={it.id} className="flex items-start gap-2">
              <ItemStatus it={it} />
              <span className="break-all">{it.action === "rmdir" ? it.srcPath : it.dstPath}</span>
              {it.error && <span className="break-all text-destructive">{it.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------- history ------------------------------- */

function HistoryDialog({ open, onOpenChange, taskId, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; taskId: string; onPick: (id: string) => void }) {
  const [runs, setRuns] = useState<OrganizeRun[] | null>(null);
  useEffect(() => {
    if (!open) return;
    setRuns(null);
    api.organize
      .listRuns(taskId)
      .then((r) => setRuns(r.runs))
      .catch((err) => {
        setRuns([]);
        toast.error(apiErrorMessage(err, "读取整理历史失败"));
      });
  }, [open, taskId]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>整理历史</DialogTitle>
          <DialogDescription>这个任务最近的整理记录；只有最近一次执行过的能撤销。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {runs === null ? (
            <Spinner label="加载中…" />
          ) : runs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">还没有整理记录</p>
          ) : (
            <ul className="divide-y">
              {runs.map((r) => {
                const meta = RUN_STATUS_META[r.status];
                return (
                  <li key={r.id}>
                    <button type="button" className="flex w-full flex-wrap items-center gap-2 px-1 py-2 text-left text-sm hover:bg-accent" onClick={() => onPick(r.id)}>
                      <StatusBadge tone={meta.tone} pulse={meta.pulse}>
                        {meta.label}
                      </StatusBadge>
                      <span className="min-w-0 flex-1 break-all">{r.scopePath || "整个任务"}{r.scopePaths.length > 0 ? `（${r.scopePaths.length} 个新增路径）` : ""}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {r.stats.units} 部 · {r.stats.done > 0 ? `完成 ${r.stats.done}` : `${r.stats.planned} 项`} · {TRIGGER_LABEL[r.trigger]} · {fmtTime(r.createdAt * 1000)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

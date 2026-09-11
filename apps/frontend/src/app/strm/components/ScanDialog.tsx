"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, FileCog, FolderOpen, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { StrmIssue, StrmIssueType, StrmScanResult } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/empty-state";
import { Spinner } from "@/components/loading";
import { StatusBadge } from "@/components/status-badge";
import { api } from "@/lib/api";
import { ISSUE_META, baseName, parentOf, strmErrorMessage, type RequestDelete } from "@/lib/strm";

/** 一个 tab 最多渲染这么多条，再多滚也滚不完 */
const RENDER_CAP = 500;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  /** 扫描范围（"" 是整个任务目录）；换了范围由页面用 key 重新挂载 */
  path: string;
  /** 在浏览器里打开某个目录（会关掉弹框） */
  onOpenPath: (dir: string) => void;
  onDelete: RequestDelete;
  /** 「全部重写」交给修正弹框 */
  onRewriteAll: (path: string) => void;
};

type Tab = "all" | StrmIssueType;

const TAB_ORDER: StrmIssueType[] = [
  "nonstandard-name",
  "nested-same-name",
  "stale-content",
  "unparsable",
  "duplicate-episode",
  "empty-dir",
  "leftover-part",
];

function FilterTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-1 tabular-nums ${active ? "bg-card font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

/**
 * 体检结果。弹框保持挂载：关掉去浏览器里处理一两条再打开，不用重扫；
 * 处理过的条目就地从清单里划掉。
 */
export function ScanDialog({ open, onOpenChange, taskId, path, onOpenPath, onDelete, onRewriteAll }: Props) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<StrmScanResult | null>(null);
  const [issues, setIssues] = useState<StrmIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [busyPaths, setBusyPaths] = useState<Set<string>>(new Set());

  const run = async () => {
    if (!taskId) return;
    setRunning(true);
    setError(null);
    try {
      const res = await api.strm.scan(taskId, path);
      setResult(res);
      setIssues(res.issues);
      setTab("all");
    } catch (err) {
      setError(strmErrorMessage(err, "扫描失败"));
    } finally {
      setRunning(false);
    }
  };

  // 第一次打开自动跑一遍
  useEffect(() => {
    if (open && !result && !running && !error) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const presentTypes = useMemo(() => TAB_ORDER.filter((t) => issues.some((i) => i.type === t)), [issues]);
  const shown = useMemo(() => (tab === "all" ? issues : issues.filter((i) => i.type === tab)), [issues, tab]);
  const activeMeta = tab === "all" ? null : ISSUE_META[tab];
  const listedTotal = result ? Object.values(result.counts).reduce((a, b) => a + b, 0) : 0;

  const withBusy = async (paths: string[], fn: () => Promise<void>) => {
    setBusyPaths((prev) => new Set([...prev, ...paths]));
    try {
      await fn();
    } finally {
      setBusyPaths((prev) => {
        const next = new Set(prev);
        for (const p of paths) next.delete(p);
        return next;
      });
    }
  };

  const dropPaths = (paths: Set<string>) => {
    setIssues((prev) =>
      prev
        .filter((i) => !paths.has(i.path))
        .map((i) => (i.related ? { ...i, related: i.related.filter((r) => !paths.has(r)) } : i)),
    );
  };

  const deletePaths = (paths: string[], label: string) =>
    withBusy(paths, async () => {
      const res = await onDelete(paths, label);
      if (!res) return;
      const failed = new Set(res.failed.map((f) => f.path));
      dropPaths(new Set(paths.filter((p) => !failed.has(p))));
    });

  const rewriteOne = (issue: StrmIssue) =>
    withBusy([issue.path], async () => {
      try {
        const res = await api.strm.rewrite(taskId, issue.path, false);
        if (res.changed > 0) {
          toast.success(`已重写 ${baseName(issue.path)}`);
          dropPaths(new Set([issue.path]));
        } else toast.info("内容已经是最新的，没有改动");
      } catch (err) {
        toast.error(strmErrorMessage(err, "重写失败"));
      }
    });

  const batchButton = () => {
    if (!activeMeta?.batch || tab === "all") return null;
    const paths = shown.map((i) => i.path);
    if (activeMeta.batch === "rewrite") {
      return (
        <Button variant="outline" size="sm" className="h-7" onClick={() => onRewriteAll(path)}>
          <FileCog className="size-3.5" />
          全部重写
        </Button>
      );
    }
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-destructive hover:text-destructive"
        onClick={() => void deletePaths(paths, `全部${activeMeta.label}（${paths.length} 项）`)}
        disabled={paths.length === 0 || busyPaths.size > 0}
      >
        <Trash2 className="size-3.5" />
        删除全部{activeMeta.label}（{paths.length}）
      </Button>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>体检</DialogTitle>
          <DialogDescription className="break-all">范围：{path ? path : "整个任务目录"}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {running && <Spinner label="正在扫描整个目录，大库要一会…" />}
          {!running && error && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>没能完成</AlertTitle>
              <AlertDescription className="break-all">{error}</AlertDescription>
            </Alert>
          )}
          {!running && !error && result && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <p className="tabular-nums">
                  扫描了 {result.files} 个文件（{result.strm} 个 strm）、{result.dirs} 个目录
                  {listedTotal > 0 && `，发现 ${listedTotal} 处问题`}
                </p>
                <Button variant="outline" size="sm" className="h-7" onClick={() => void run()}>
                  <RefreshCw className="size-3.5" />
                  重新扫描
                </Button>
              </div>
              {result.truncated && <p className="text-xs text-warning">目录太大，只扫描了一部分；处理完再扫一次。</p>}
              {result.skippedRoots.length > 0 && (
                <p className="break-all text-xs text-muted-foreground">跳过了其它任务的输出目录：{result.skippedRoots.join("、")}</p>
              )}
              {issues.length === 0 ? (
                <EmptyState className="py-10" icon={CheckCircle2} title="没有发现问题" description="同名嵌套、空目录、内容过期、无法解析、重复剧集、残留分段都没有。" />
              ) : (
                <div className="overflow-hidden rounded-xl border">
                  <div className="flex flex-wrap items-center gap-1 border-b bg-muted/40 px-3 py-2 text-xs">
                    <FilterTab active={tab === "all"} onClick={() => setTab("all")}>
                      全部 {issues.length}
                    </FilterTab>
                    {presentTypes.map((t) => (
                      <FilterTab key={t} active={tab === t} onClick={() => setTab(t)}>
                        {ISSUE_META[t].label} {result.counts[t]}
                      </FilterTab>
                    ))}
                    <div className="ml-auto">{batchButton()}</div>
                  </div>
                  {activeMeta && (
                    <div className="border-b px-3 py-2 text-xs text-muted-foreground">
                      {activeMeta.hint}
                      {tab !== "all" && result.counts[tab] > shown.length && `（共 ${result.counts[tab]} 处，只列出前 ${shown.length} 条）`}
                    </div>
                  )}
                  <div className="max-h-[45vh] divide-y overflow-y-auto">
                    {shown.slice(0, RENDER_CAP).map((issue) => {
                      const meta = ISSUE_META[issue.type];
                      const busy = busyPaths.has(issue.path);
                      return (
                        <div key={`${issue.type}:${issue.path}`} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-start">
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                              <span className="break-all font-mono text-xs">{issue.path || "（根目录）"}</span>
                            </div>
                            {issue.detail && <p className="break-all text-xs text-muted-foreground">{issue.detail}</p>}
                            {issue.related && issue.related.length > 0 && (
                              <ul className="space-y-0.5">
                                {issue.related.map((r) => (
                                  <li key={r} className="flex items-center gap-1 text-xs">
                                    <span className="min-w-0 flex-1 break-all font-mono text-muted-foreground">{r}</span>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-7 shrink-0 text-destructive hover:text-destructive"
                                      title="删除这一份"
                                      onClick={() => void deletePaths([r], `「${baseName(r)}」`)}
                                      disabled={busyPaths.has(r)}
                                    >
                                      <Trash2 className="size-3.5" />
                                    </Button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-0.5 self-end sm:self-start">
                            <Button variant="ghost" size="icon" className="size-8" title="打开所在目录" onClick={() => onOpenPath(parentOf(issue.path))}>
                              <FolderOpen className="size-4" />
                            </Button>
                            {issue.type === "stale-content" && (
                              <Button variant="ghost" size="icon" className="size-8" title="重写为应有内容" onClick={() => void rewriteOne(issue)} disabled={busy}>
                                {busy ? <Loader2 className="size-4 animate-spin" /> : <FileCog className="size-4" />}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-destructive hover:text-destructive"
                              title="删除"
                              onClick={() => void deletePaths([issue.path], `「${baseName(issue.path) || issue.path}」`)}
                              disabled={busy || issue.path === ""}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                    {shown.length > RENDER_CAP && (
                      <div className="px-3 py-2 text-xs text-muted-foreground">还有 {shown.length - RENDER_CAP} 条未显示，处理完再扫一次。</div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

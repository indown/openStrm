"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Eraser,
  File as FileIcon,
  FolderOpen,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, TONE_CLASS, type StatusTone } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/loading";
import {
  api,
  type OfflineFollowup,
  type OfflineListPage,
  type OfflineTask,
  type OfflineTaskState,
} from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { AddOfflineTaskDialog } from "./components/AddOfflineTaskDialog";

/** 有任务在下载或有回执待兑现时的刷新间隔 */
const POLL_INTERVAL_MS = 5000;

const STATE_META: Record<OfflineTaskState, { tone: StatusTone; label: string; pulse?: boolean }> = {
  pending: { tone: "neutral", label: "等待中" },
  downloading: { tone: "info", label: "下载中", pulse: true },
  done: { tone: "success", label: "已完成" },
  failed: { tone: "danger", label: "失败" },
  unknown: { tone: "neutral", label: "未知" },
};

function formatSize(bytes: number): string {
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtTime(sec: number): string {
  if (!sec) return "-";
  return new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false });
}

function fmtRate(bytesPerSec: number): string {
  if (!bytesPerSec) return "";
  return `${formatSize(bytesPerSec)}/s`;
}

const PAGE_TITLE = "云下载";
const PAGE_DESCRIPTION = "把磁力、ed2k、http 链接交给 115 在云端下载；下载到同步任务的目录时，完成后自动生成 strm";

export default function OfflinePage() {
  const [accounts, setAccounts] = useState<string[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [account, setAccount] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<OfflineListPage | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskPaths, setTaskPaths] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ hashes: string[]; label: string } | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [clearTarget, setClearTarget] = useState<{ flag: number; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState<Set<string>>(new Set());
  // 列表请求的序号：切账号 / 翻页时慢的旧响应不能盖掉新的
  const seqRef = useRef(0);

  useEffect(() => {
    api.accounts
      .list()
      .then((list) => {
        const names = list.filter((a) => a.accountType === "115").map((a) => a.name);
        setAccounts(names);
        setAccount((prev) => (prev && names.includes(prev) ? prev : (names[0] ?? "")));
      })
      .catch((err) => toast.error(apiErrorMessage(err, "获取账户列表失败")))
      .finally(() => setAccountsLoaded(true));
    // 回执只记 taskId，展示时要换成任务的网盘路径
    api.tasks
      .list()
      .then((rows) => setTaskPaths(Object.fromEntries(rows.map((t) => [t.id, t.originPath]))))
      .catch(() => {});
  }, []);

  /** 拉列表。silent：后台轮询用，不转刷新按钮、失败也不弹提示 */
  const load = useCallback(
    async (silent = false) => {
      if (!account) return;
      const seq = ++seqRef.current;
      if (!silent) setRefreshing(true);
      try {
        const res = await api.offline.list(account, page);
        if (seq !== seqRef.current) return;
        setData(res);
        setError(null);
        // 把最后一页删空后 115 的 pageCount 会变小；page 停在原地就会一直看到"没有任务"的空页
        if (res.pageCount >= 1 && page > res.pageCount) setPage(res.pageCount);
      } catch (err) {
        if (seq !== seqRef.current) return;
        const msg = apiErrorMessage(err, "读取云下载列表失败");
        setError(msg);
        if (!silent) toast.error(msg);
      } finally {
        if (seq === seqRef.current) {
          setLoaded(true);
          if (!silent) setRefreshing(false);
        }
      }
    },
    [account, page],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // 有任务在下载、或还有回执没兑现时，每 5 秒刷一次；页面切到后台不刷
  const active = useMemo(
    () =>
      Boolean(
        data?.tasks.some((t) => t.state === "pending" || t.state === "downloading") ||
          (data?.watcher.pending ?? 0) > 0,
      ),
    [data],
  );
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void load(true);
    };
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  // 列表变了就把已经不在页面上的勾选去掉
  useEffect(() => {
    if (!data) return;
    const present = new Set(data.tasks.map((t) => t.infoHash));
    setSelected((prev) => {
      const next = new Set([...prev].filter((h) => present.has(h)));
      return next.size === prev.size ? prev : next;
    });
  }, [data]);

  const followupByHash = useMemo(
    () => new Map<string, OfflineFollowup>((data?.followups ?? []).map((f) => [f.infoHash, f])),
    [data],
  );

  const tasks = data?.tasks ?? [];
  const allSelected = tasks.length > 0 && tasks.every((t) => selected.has(t.infoHash));

  const toggleAll = (on: boolean) => {
    setSelected(on ? new Set(tasks.map((t) => t.infoHash)) : new Set());
  };
  const toggleOne = (hash: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(hash);
      else next.delete(hash);
      return next;
    });
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.offline.remove({ account, infoHashes: deleteTarget.hashes, deleteFiles });
      toast.success(`已删除 ${deleteTarget.hashes.length} 个任务${deleteFiles ? "及其文件" : ""}`);
      setDeleteTarget(null);
      setDeleteFiles(false);
      await load(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, "删除失败"));
    } finally {
      setBusy(false);
    }
  };

  const doClear = async () => {
    if (!clearTarget) return;
    setBusy(true);
    try {
      await api.offline.clear({ account, flag: clearTarget.flag });
      toast.success(`已清空${clearTarget.label}任务`);
      setClearTarget(null);
      setPage(1);
      await load(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, "清空失败"));
    } finally {
      setBusy(false);
    }
  };

  const doRestart = async (task: OfflineTask) => {
    setRestarting((prev) => new Set(prev).add(task.infoHash));
    try {
      await api.offline.restart({ account, infoHash: task.infoHash });
      toast.success(`已重试：${task.name}`);
      await load(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, "重试失败"));
    } finally {
      setRestarting((prev) => {
        const next = new Set(prev);
        next.delete(task.infoHash);
        return next;
      });
    }
  };

  // 账号列表还没回来：标题先出，下面占个表格骨架
  if (!accountsLoaded) {
    return (
      <div className="space-y-6">
        <PageHeader icon={CloudDownload} title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <TableSkeleton rows={4} />
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader icon={CloudDownload} title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <EmptyState
          icon={KeyRound}
          title="还没有 115 账号"
          description="云下载要通过 115 账号提交，先到「账户」页添加一个。"
          action={
            <Button asChild>
              <Link href="/account">去添加账号</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={CloudDownload}
        title={PAGE_TITLE}
        description={PAGE_DESCRIPTION}
        actions={
          <>
            {accounts.length > 1 ? (
              <Select
                value={account}
                onValueChange={(v) => {
                  setAccount(v);
                  setPage(1);
                  setSelected(new Set());
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="账号" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Badge variant="outline">账号 {account}</Badge>
            )}
            <Button variant="outline" onClick={() => load()} disabled={refreshing}>
              <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
              刷新
            </Button>
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="size-4" />
              添加
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {data?.quota != null && (
          <StatusBadge tone="neutral" className="tabular-nums">
            配额剩余 {data.quota}
            {data.total != null ? ` / ${data.total}` : ""}
          </StatusBadge>
        )}
        {data && (
          <StatusBadge tone="neutral" className="tabular-nums">
            共 {data.count} 个任务
          </StatusBadge>
        )}
        {data?.watcher.pending ? (
          <StatusBadge tone="brand" className="tabular-nums">
            {data.watcher.pending} 个回执待兑现（生成 strm / 复制到 OpenList）
          </StatusBadge>
        ) : null}
        {data?.watcher.lastError && (
          <span className="break-all text-xs text-destructive">回执循环最近一次出错：{data.watcher.lastError}</span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {selected.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteTarget({ hashes: [...selected], label: `所选的 ${selected.size} 个任务` })}
            >
              <Trash2 className="size-4" />
              删除所选（{selected.size}）
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setClearTarget({ flag: 0, label: "已完成的" })}>
            <Eraser className="size-4" />
            清空已完成
          </Button>
          <Button variant="outline" size="sm" onClick={() => setClearTarget({ flag: 2, label: "失败的" })}>
            <Eraser className="size-4" />
            清空失败
          </Button>
        </div>
      </div>

      {!loaded ? (
        <TableSkeleton rows={4} />
      ) : tasks.length === 0 ? (
        error ? (
          <EmptyState
            icon={CloudDownload}
            title="列表加载失败"
            description={error}
            action={
              <Button variant="outline" onClick={() => load()} disabled={refreshing}>
                <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
                重试
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={CloudDownload}
            title="还没有云下载任务"
            description="把磁力、ed2k 或 http 链接交给 115，下载完可以自动生成 strm。"
            action={
              <Button onClick={() => setAddOpen(true)}>
                <Plus className="size-4" />
                添加任务
              </Button>
            }
          />
        )
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={allSelected} onCheckedChange={(v) => toggleAll(v === true)} aria-label="全选" />
                </TableHead>
                <TableHead>名称</TableHead>
                <TableHead className="w-24 text-right">大小</TableHead>
                <TableHead className="w-36">进度</TableHead>
                <TableHead className="w-28">状态</TableHead>
                <TableHead className="w-40">添加时间</TableHead>
                <TableHead className="w-24 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => {
                const meta = STATE_META[t.state];
                const followup = followupByHash.get(t.infoHash);
                return (
                  <TableRow key={t.infoHash}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(t.infoHash)}
                        onCheckedChange={(v) => toggleOne(t.infoHash, v === true)}
                        aria-label="选择"
                      />
                    </TableCell>
                    <TableCell className="min-w-[240px]">
                      <div className="flex min-w-0 items-start gap-2">
                        {t.isDir ? (
                          <FolderOpen className="mt-0.5 size-4 shrink-0 text-warning" />
                        ) : (
                          <FileIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        )}
                        <div className="min-w-0">
                          <div className="break-all text-sm" title={t.url}>
                            {t.name || t.url}
                          </div>
                          {followup && <FollowupLine followup={followup} originPath={taskPaths[followup.taskId]} />}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">{formatSize(t.size)}</TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className={`h-full rounded-full ${TONE_CLASS[STATE_META[t.state].tone].bar}`} style={{ width: `${t.percent}%` }} />
                        </div>
                        <div className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                          {t.percent}%{t.state === "downloading" && t.rateDownload ? ` · ${fmtRate(t.rateDownload)}` : ""}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={meta.tone} pulse={meta.pulse} title={t.statusText}>
                        {t.state === "unknown" ? t.statusText || meta.label : meta.label}
                      </StatusBadge>
                      {t.state === "failed" && t.statusText && (
                        <div className="mt-1 break-all text-xs text-muted-foreground">{t.statusText}</div>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                      {fmtTime(t.addTime)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <div className="flex justify-end gap-0.5">
                        {t.state === "failed" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            title="重试"
                            onClick={() => doRestart(t)}
                            disabled={restarting.has(t.infoHash)}
                          >
                            {restarting.has(t.infoHash) ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <RotateCcw className="size-4" />
                            )}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 text-destructive hover:text-destructive"
                          title="删除"
                          onClick={() => setDeleteTarget({ hashes: [t.infoHash], label: t.name || "这个任务" })}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {data && data.pageCount > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground tabular-nums">
            第 {data.page} / {data.pageCount} 页
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            title="上一页"
            disabled={page <= 1 || refreshing}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            title="下一页"
            disabled={page >= data.pageCount || refreshing}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}

      <AddOfflineTaskDialog open={addOpen} onOpenChange={setAddOpen} account={account} onAdded={() => void load(true)} />

      <AlertDialog
        open={deleteTarget != null}
        onOpenChange={(o) => {
          if (!o) {
            setDeleteTarget(null);
            setDeleteFiles(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除{deleteTarget?.hashes.length === 1 ? "任务" : "所选任务"}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p className="break-all">将从 115 的云下载列表里删除：{deleteTarget?.label}</p>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                  <Checkbox checked={deleteFiles} onCheckedChange={(v) => setDeleteFiles(v === true)} />
                  同时删除已下载到网盘的文件
                </label>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void doDelete();
              }}
              disabled={busy}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearTarget != null} onOpenChange={(o) => !o && setClearTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空{clearTarget?.label}任务？</AlertDialogTitle>
            <AlertDialogDescription>只清理云下载列表，已经下载到网盘的文件不会被删除。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void doClear();
              }}
              disabled={busy}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : "清空"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FollowupLine({ followup, originPath }: { followup: OfflineFollowup; originPath?: string }) {
  const isCopy = followup.kind === "openlist-copy";
  const target = isCopy
    ? (followup.copyDstDir ?? "")
    : `${originPath ?? followup.taskId}${followup.subPath ? `/${followup.subPath}` : ""}`;
  const badge: { tone: StatusTone; label: string } =
    followup.status === "done"
      ? { tone: "success", label: isCopy ? "已复制到 OpenList" : "strm 已生成" }
      : followup.status === "failed"
        ? { tone: "danger", label: isCopy ? "OpenList 复制失败" : "strm 未生成" }
        : { tone: "neutral", label: isCopy ? "完成后复制到 OpenList" : "完成后生成 strm" };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
      {target && (
        <span className="max-w-[220px] truncate" title={target}>
          → {target}
        </span>
      )}
      {followup.detail && <span className="break-all">{followup.detail}</span>}
    </div>
  );
}

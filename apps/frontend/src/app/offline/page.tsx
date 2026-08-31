"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Eraser,
  File as FileIcon,
  FolderOpen,
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

const STATE_META: Record<OfflineTaskState, { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
  pending: { variant: "outline", label: "等待中" },
  downloading: { variant: "secondary", label: "下载中" },
  done: { variant: "default", label: "已完成" },
  failed: { variant: "destructive", label: "失败" },
  unknown: { variant: "outline", label: "未知" },
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

  if (!accountsLoaded) return <div>Loading...</div>;

  if (accounts.length === 0) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <h1 className="text-2xl font-semibold">云下载</h1>
        <p className="text-sm text-muted-foreground">还没有 115 账号，请先到「账户」页添加。</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <CloudDownload className="h-6 w-6" />
            云下载
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            把磁力、ed2k、http 链接交给 115 在云端下载；下载到同步任务的目录时，完成后自动生成 strm
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
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
          <Button variant="outline" size="sm" onClick={() => load()} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            <span className="ml-1">添加</span>
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-sm">
        {data?.quota != null && (
          <Badge variant="outline">
            配额剩余 {data.quota}
            {data.total != null ? ` / ${data.total}` : ""}
          </Badge>
        )}
        {data && <Badge variant="outline">共 {data.count} 个任务</Badge>}
        {data?.watcher.pending ? (
          <Badge variant="secondary">{data.watcher.pending} 个回执待兑现（生成 strm / 复制到 OpenList）</Badge>
        ) : null}
        {data?.watcher.lastError && (
          <span className="text-xs text-destructive break-all">回执循环最近一次出错：{data.watcher.lastError}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteTarget({ hashes: [...selected], label: `所选的 ${selected.size} 个任务` })}
            >
              <Trash2 className="h-4 w-4" />
              <span className="ml-1">删除所选（{selected.size}）</span>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setClearTarget({ flag: 0, label: "已完成的" })}>
            <Eraser className="h-4 w-4" />
            <span className="ml-1">清空已完成</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setClearTarget({ flag: 2, label: "失败的" })}>
            <Eraser className="h-4 w-4" />
            <span className="ml-1">清空失败</span>
          </Button>
        </div>
      </div>

      {error && !data && loaded && <p className="text-sm text-destructive break-all">{error}</p>}

      <div className="rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox checked={allSelected} onCheckedChange={(v) => toggleAll(v === true)} aria-label="全选" />
              </TableHead>
              <TableHead>名称</TableHead>
              <TableHead className="w-24">大小</TableHead>
              <TableHead className="w-36">进度</TableHead>
              <TableHead className="w-28">状态</TableHead>
              <TableHead className="w-40">添加时间</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!loaded ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
                  加载中...
                </TableCell>
              </TableRow>
            ) : tasks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  {error ? "列表加载失败" : "还没有云下载任务"}
                </TableCell>
              </TableRow>
            ) : (
              tasks.map((t) => {
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
                      <div className="flex items-start gap-2 min-w-0">
                        {t.isDir ? (
                          <FolderOpen className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                        ) : (
                          <FileIcon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                        )}
                        <div className="min-w-0">
                          <div className="text-sm break-all" title={t.url}>
                            {t.name || t.url}
                          </div>
                          {followup && <FollowupLine followup={followup} originPath={taskPaths[followup.taskId]} />}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatSize(t.size)}</TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <div className="h-1.5 rounded bg-muted overflow-hidden">
                          <div
                            className={`h-full ${t.state === "failed" ? "bg-destructive" : "bg-primary"}`}
                            style={{ width: `${t.percent}%` }}
                          />
                        </div>
                        <div className="text-xs text-muted-foreground whitespace-nowrap">
                          {t.percent}%{t.state === "downloading" && t.rateDownload ? ` · ${fmtRate(t.rateDownload)}` : ""}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={meta.variant} title={t.statusText}>
                        {t.state === "unknown" ? t.statusText || meta.label : meta.label}
                      </Badge>
                      {t.state === "failed" && t.statusText && (
                        <div className="text-xs text-muted-foreground mt-1 break-all">{t.statusText}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtTime(t.addTime)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {t.state === "failed" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="重试"
                          onClick={() => doRestart(t)}
                          disabled={restarting.has(t.infoHash)}
                        >
                          {restarting.has(t.infoHash) ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RotateCcw className="h-4 w-4" />
                          )}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        title="删除"
                        onClick={() => setDeleteTarget({ hashes: [t.infoHash], label: t.name || "这个任务" })}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {data && data.pageCount > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            第 {data.page} / {data.pageCount} 页
          </span>
          <Button variant="outline" size="sm" disabled={page <= 1 || refreshing} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= data.pageCount || refreshing}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="h-4 w-4" />
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
                <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
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
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "删除"}
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
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "清空"}
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
  const badge =
    followup.status === "done"
      ? { variant: "default" as const, label: isCopy ? "已复制到 OpenList" : "strm 已生成" }
      : followup.status === "failed"
        ? { variant: "destructive" as const, label: isCopy ? "OpenList 复制失败" : "strm 未生成" }
        : { variant: "outline" as const, label: isCopy ? "完成后复制到 OpenList" : "完成后生成 strm" };
  return (
    <div className="mt-1 flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
      <Badge variant={badge.variant} className="text-[10px] px-1.5 py-0">
        {badge.label}
      </Badge>
      {target && (
        <span className="truncate max-w-[220px]" title={target}>
          → {target}
        </span>
      )}
      {followup.detail && <span className="break-all">{followup.detail}</span>}
    </div>
  );
}

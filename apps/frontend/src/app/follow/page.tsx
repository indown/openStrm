"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pause, Pencil, Play, RefreshCw, Rss, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import type { ShareFollowSummary } from "@openstrm/shared";
import { api, type FollowListResponse } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { FOLLOW_INTERVALS, intervalLabel, scopeLabel } from "@/lib/follow";

/** 有订阅正在检查时的刷新间隔 */
const POLL_INTERVAL_MS = 5000;

function fmtTime(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function relativePast(ms: number | null): string {
  if (!ms) return "还没检查过";
  const d = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

function relativeFuture(ms: number): string {
  const d = Math.floor((ms - Date.now()) / 1000);
  if (d <= 30) return "即将";
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} 分钟后`;
  if (d < 86400) return `${Math.round(d / 3600)} 小时后`;
  return `${Math.round(d / 86400)} 天后`;
}

/** enabled + status 合成界面上的一个徽标 */
function statusMeta(f: ShareFollowSummary): { variant: "default" | "secondary" | "destructive" | "outline"; label: string } {
  if (f.status === "checking") return { variant: "secondary", label: "检查中" };
  if (!f.enabled) {
    if (f.status === "expired") return { variant: "destructive", label: "分享失效" };
    if (f.status === "stale") return { variant: "outline", label: "已停更" };
    return { variant: "outline", label: "已暂停" };
  }
  if (f.status === "error") return { variant: "destructive", label: "出错" };
  return { variant: "default", label: "追更中" };
}

export default function FollowPage() {
  const [data, setData] = useState<FollowListResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskPaths, setTaskPaths] = useState<Record<string, string> | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [editTarget, setEditTarget] = useState<ShareFollowSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ShareFollowSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 刷新和「立即检查」的响应可能交错，慢的旧列表不能盖掉新的
  const seqRef = useRef(0);

  useEffect(() => {
    api.tasks
      .list()
      .then((rows) => setTaskPaths(Object.fromEntries(rows.map((t) => [t.id, t.originPath]))))
      .catch(() => setTaskPaths({}));
  }, []);

  const load = useCallback(async (silent = false) => {
    const seq = ++seqRef.current;
    if (!silent) setRefreshing(true);
    try {
      const res = await api.follow.list();
      if (seq !== seqRef.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      const msg = apiErrorMessage(err, "读取追更列表失败");
      setError(msg);
      if (!silent) toast.error(msg);
    } finally {
      if (seq === seqRef.current) {
        setLoaded(true);
        if (!silent) setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 有订阅在检查时每 5 秒刷一次；页面切到后台不刷
  const active = useMemo(
    () => Boolean(data?.follows.some((f) => f.status === "checking") || (data?.watcher.checking.length ?? 0) > 0),
    [data],
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void load(true);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const mergeFollow = (next: ShareFollowSummary) =>
    setData((prev) => (prev ? { ...prev, follows: prev.follows.map((f) => (f.id === next.id ? next : f)) } : prev));

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await fn();
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const doCheck = (f: ShareFollowSummary) =>
    withBusy(f.id, async () => {
      mergeFollow({ ...f, status: "checking" });
      try {
        const r = await api.follow.check(f.id);
        mergeFollow(r.follow);
        if (r.run?.added.length) {
          toast.success(`「${f.name}」新增 ${r.run.added.length} 个，生成 ${r.run.generated} 个 strm`);
        } else if (r.run?.error) {
          toast.error(`「${f.name}」检查出错：${r.run.error}`);
        } else if (r.run?.skipped.length) {
          toast.info(`「${f.name}」有 ${r.run.skipped.length} 项变化被跳过，详情见最近动态`);
        } else {
          toast.info(`「${f.name}」没有新增`);
        }
      } catch (err) {
        toast.error(apiErrorMessage(err, "检查失败"));
        void load(true);
      }
    });

  const doToggle = (f: ShareFollowSummary) =>
    withBusy(f.id, async () => {
      try {
        mergeFollow(await api.follow.update(f.id, { enabled: !f.enabled }));
        toast.success(f.enabled ? `已暂停「${f.name}」` : `已继续「${f.name}」，稍后就会检查一次`);
      } catch (err) {
        toast.error(apiErrorMessage(err, "操作失败"));
      }
    });

  const doDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.follow.remove(deleteTarget.id);
      toast.success(`已删除「${deleteTarget.name}」`);
      setData((prev) => (prev ? { ...prev, follows: prev.follows.filter((f) => f.id !== deleteTarget.id) } : prev));
      setDeleteTarget(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, "删除失败"));
    } finally {
      setDeleting(false);
    }
  };

  const follows = data?.follows ?? [];
  const activeCount = follows.filter((f) => f.enabled).length;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Rss className="h-6 w-6" />
            追更
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            盯住分享里的剧集目录，定期把新增的文件自动转存到任务目录并生成 strm
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {follows.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <Badge variant="outline">
            {activeCount} / {follows.length} 条在追
          </Badge>
          {data?.watcher.lastError && (
            <span className="text-xs text-destructive break-all">循环最近一次出错：{data.watcher.lastError}</span>
          )}
        </div>
      )}

      {error && !data && loaded && <p className="text-sm text-destructive break-all">{error}</p>}

      <div className="rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead className="w-48">目标</TableHead>
              <TableHead className="w-36">检查</TableHead>
              <TableHead className="min-w-[160px]">最近动态</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="w-32 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!loaded ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
                  加载中...
                </TableCell>
              </TableRow>
            ) : follows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-10">
                  {error
                    ? "列表加载失败"
                    : "还没有追更订阅。转存分享时（分享详情或影库的「保存到任务目录」）勾选「转存后追更」，新集就会自动跟过来。"}
                </TableCell>
              </TableRow>
            ) : (
              follows.map((f) => (
                <FollowRow
                  key={f.id}
                  follow={f}
                  originPath={taskPaths ? (taskPaths[f.taskId] ?? null) : undefined}
                  busy={busyIds.has(f.id)}
                  onCheck={() => void doCheck(f)}
                  onToggle={() => void doToggle(f)}
                  onEdit={() => setEditTarget(f)}
                  onDelete={() => setDeleteTarget(f)}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <EditFollowDialog
        target={editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
        onSaved={(next) => {
          mergeFollow(next);
          setEditTarget(null);
        }}
      />

      <AlertDialog open={deleteTarget != null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除追更</AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              不再检查「{deleteTarget?.name}」的更新。已经转存到网盘和生成的 strm 不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void doDelete();
              }}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FollowRow({
  follow: f,
  originPath,
  busy,
  onCheck,
  onToggle,
  onEdit,
  onDelete,
}: {
  follow: ShareFollowSummary;
  /** undefined = 任务列表还没拿到；null = 任务已删除 */
  originPath: string | null | undefined;
  busy: boolean;
  onCheck: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const meta = statusMeta(f);
  const scope = scopeLabel(f);
  const target =
    originPath === undefined
      ? "…"
      : `${originPath ?? "（任务已删除）"}${f.subPath ? `/${f.subPath}` : ""}`;
  const last = f.recent[0];
  const checking = f.status === "checking";
  return (
    <TableRow>
      <TableCell className="min-w-[180px]">
        <div className="text-sm font-medium break-all">{f.name}</div>
        <div className="text-xs text-muted-foreground break-all">
          {f.watchPath || "分享根目录"}
          {scope !== "整个目录" && ` · 只追：${scope}`}
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground break-all">→ {target}</TableCell>
      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
        <div>{intervalLabel(f.intervalMinutes)}</div>
        <div title={`上次：${fmtTime(f.lastCheckedAt)}`}>上次 {relativePast(f.lastCheckedAt)}</div>
        {f.enabled && !checking && <div title={fmtTime(f.nextCheckAt)}>下次 {relativeFuture(f.nextCheckAt)}</div>}
      </TableCell>
      <TableCell>
        {last ? (
          <div className="text-xs space-y-0.5">
            {last.added.length > 0 && (
              <div className="break-all">
                <span className="text-green-600 dark:text-green-500">+{last.added.length}</span>{" "}
                {last.added.slice(0, 2).join("、")}
                {last.added.length > 2 ? ` 等 ${last.added.length} 个` : ""}
              </div>
            )}
            {last.skipped.length > 0 && (
              <div className="text-muted-foreground break-all" title={last.skipped.join("\n")}>
                跳过 {last.skipped.length} 项（{last.skipped[0]}
                {last.skipped.length > 1 ? " 等" : ""}）
              </div>
            )}
            {last.error && (last.added.length > 0 || last.skipped.length > 0) && (
              <div className="text-destructive break-all">{last.error}</div>
            )}
            <div className="text-muted-foreground">{relativePast(last.at)}</div>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">订阅以来还没有新增</span>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={meta.variant}>{meta.label}</Badge>
        {f.lastError && f.status !== "checking" && (
          <div className="text-xs text-muted-foreground mt-1 break-all" title={f.lastError}>
            {f.lastError.length > 60 ? `${f.lastError.slice(0, 60)}…` : f.lastError}
          </div>
        )}
      </TableCell>
      <TableCell className="text-right whitespace-nowrap">
        <Button variant="ghost" size="sm" title="立即检查" onClick={onCheck} disabled={busy || checking}>
          {busy || checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="sm" title={f.enabled ? "暂停" : "继续"} onClick={onToggle} disabled={busy || checking}>
          {f.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="sm" title="编辑" onClick={onEdit} disabled={busy}>
          <Pencil className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" title="删除" onClick={onDelete} disabled={busy}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

function EditFollowDialog({
  target,
  onOpenChange,
  onSaved,
}: {
  target: ShareFollowSummary | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (next: ShareFollowSummary) => void;
}) {
  const [name, setName] = useState("");
  const [interval, setIntervalMin] = useState("360");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!target) return;
    setName(target.name);
    setIntervalMin(String(target.intervalMinutes));
  }, [target]);

  const save = async () => {
    if (!target) return;
    setSaving(true);
    try {
      onSaved(await api.follow.update(target.id, { name: name.trim() || target.name, intervalMinutes: Number(interval) }));
      toast.success("已保存");
    } catch (err) {
      toast.error(apiErrorMessage(err, "保存失败"));
    } finally {
      setSaving(false);
    }
  };

  const presets = FOLLOW_INTERVALS.some((o) => String(o.value) === interval)
    ? FOLLOW_INTERVALS
    : [...FOLLOW_INTERVALS, { value: Number(interval), label: intervalLabel(Number(interval)) }];

  return (
    <Dialog open={target != null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>编辑追更</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">名称</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="订阅名称" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">检查间隔</label>
            <Select value={interval} onValueChange={setIntervalMin}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presets.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

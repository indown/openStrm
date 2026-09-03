"use client";

import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, TONE_CLASS } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { CardListSkeleton } from "@/components/loading";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { RUN_STATUS } from "@/lib/status";
import type { TaskExecutionSummary } from "@openstrm/shared";
import {
  Clock,
  XCircle,
  Trash2,
  Eye,
  Calendar,
  User,
  Folder,
  FileText,
  Download,
  Trash,
  History,
  RefreshCw,
} from "lucide-react";

// 格式化时间
const formatTime = (timestamp: number) => {
  return new Date(timestamp).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

// 计算执行时长
const getDuration = (startTime: number, endTime?: number) => {
  const end = endTime || Date.now();
  const duration = end - startTime;
  const seconds = Math.floor(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}小时${minutes % 60}分钟`;
  } else if (minutes > 0) {
    return `${minutes}分钟${seconds % 60}秒`;
  } else {
    return `${seconds}秒`;
  }
};

/** 静态导出下 useSearchParams 必须包在 Suspense 里，不然 next build 直接报错（和日志页一样） */
export default function TaskHistoryPage() {
  return (
    <React.Suspense
      fallback={
        <div className="space-y-6">
          <PageHeader icon={History} title="任务执行历史" description="查看所有任务的执行记录和状态" />
          <CardListSkeleton />
        </div>
      }
    >
      <TaskHistoryContent />
    </React.Suspense>
  );
}

function TaskHistoryContent() {
  const router = useRouter();
  // 任务页的"执行历史"带 taskId 过来：只看这一个任务的记录
  const taskId = useSearchParams().get("taskId") ?? "";
  const [history, setHistory] = useState<TaskExecutionSummary[]>([]);
  // 只有首次加载显示骨架；之后点"刷新"列表留在屏幕上
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TaskExecutionSummary | null>(null);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);

  const fetchHistory = useCallback(async () => {
    try {
      setRefreshing(true);
      setHistory(await api.history.list(taskId || undefined));
    } catch (error) {
      toast.error(apiErrorMessage(error, "获取任务历史失败"));
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, [taskId]);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  /** 过滤时用第一条记录里的任务信息做标题；记录为空就只能显示 id */
  const filteredTask = taskId ? history[0]?.taskInfo : undefined;

  const deleteHistory = async (executionId: string) => {
    try {
      await api.history.remove(executionId);
      setHistory((prev) => prev.filter((h) => h.id !== executionId));
      toast.success("删除成功");
    } catch (error) {
      toast.error(apiErrorMessage(error, "删除失败"));
    }
  };

  const deleteAllHistory = async () => {
    try {
      await api.history.clear();
      toast.success("所有历史记录已删除");
      // 重新加载历史记录
      fetchHistory();
    } catch (error) {
      toast.error(apiErrorMessage(error, "删除失败"));
    }
  };

  const viewLogs = (execution: TaskExecutionSummary) => {
    // 同一标签页打开：顶栏有返回键，看完直接回来，不用在标签页之间切
    router.push(`/log?taskId=${encodeURIComponent(execution.taskId)}&executionId=${encodeURIComponent(execution.id)}`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={History}
        title="任务执行历史"
        description={taskId ? "只显示这个任务的执行记录" : "查看所有任务的执行记录和状态"}
        actions={
          <>
            <Button onClick={fetchHistory} variant="outline" disabled={refreshing}>
              <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
              {refreshing ? "刷新中..." : "刷新"}
            </Button>
            {!taskId && (
              <Button onClick={() => setClearDialogOpen(true)} variant="outline" disabled={history.length === 0}>
                <Trash className="size-4" />
                删除所有历史
              </Button>
            )}
          </>
        }
      >
        {taskId && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="break-all font-normal">
              {filteredTask ? `${filteredTask.originPath} → ${filteredTask.targetPath}` : `任务 ${taskId.slice(0, 8)}…`}
            </Badge>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => router.push("/history")}>
              查看全部
            </Button>
          </div>
        )}
      </PageHeader>

      {!loaded ? (
        <CardListSkeleton />
      ) : history.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={taskId ? "这个任务还没有执行记录" : "暂无任务执行历史"}
          description={taskId ? "到任务列表点「开始」跑一次，记录会出现在这里" : "任务跑过之后，每次执行的结果都会记在这里"}
        />
      ) : (
        <div className="grid gap-4">
          {history.map((execution) => {
            const status = RUN_STATUS[execution.status];
            const StatusIcon = status.icon;

            return (
              <div key={execution.id} className="rounded-xl border bg-card p-5 transition-shadow hover:shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <StatusIcon className={`mt-0.5 size-5 shrink-0 ${TONE_CLASS[status.tone].text}`} />
                    <div className="min-w-0">
                      <div className="break-all text-base font-semibold leading-tight" title={`任务 ${execution.taskId}`}>
                        {execution.taskInfo.originPath || `任务 ${execution.taskId}`}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <User className="size-4" />
                          <span>{execution.taskInfo.account}</span>
                        </span>
                        <span className="flex min-w-0 items-center gap-1">
                          <Folder className="size-4 shrink-0" />
                          <span className="break-all">→ {execution.taskInfo.targetPath}</span>
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge tone={status.tone} pulse={execution.status === "running"}>
                      {status.label}
                    </StatusBadge>
                    <Button size="sm" variant="outline" onClick={() => viewLogs(execution)}>
                      <Eye className="size-4" />
                      查看日志
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-destructive hover:text-destructive"
                      onClick={() => setDeleteTarget(execution)}
                      title="删除这条记录"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm">
                      <Calendar className="size-4 text-muted-foreground" />
                      <span className="text-muted-foreground">开始时间</span>
                      <span className="tabular-nums">{formatTime(execution.startTime)}</span>
                    </div>
                    {execution.endTime && (
                      <div className="flex items-center gap-2 text-sm">
                        <Clock className="size-4 text-muted-foreground" />
                        <span className="text-muted-foreground">执行时长</span>
                        <span className="tabular-nums">{getDuration(execution.startTime, execution.endTime)}</span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm">
                      <Download className="size-4 text-muted-foreground" />
                      <span className="text-muted-foreground">下载文件</span>
                      <span className="tabular-nums">
                        {execution.summary.downloadedFiles}/{execution.summary.totalFiles}
                      </span>
                    </div>
                    {execution.taskInfo.removeExtraFiles && (
                      <div className="flex items-center gap-2 text-sm">
                        <Trash className="size-4 text-muted-foreground" />
                        <span className="text-muted-foreground">删除文件</span>
                        <span className="tabular-nums">{execution.summary.deletedFiles}</span>
                      </div>
                    )}
                    {(execution.summary.failedFiles ?? 0) > 0 && (
                      <div className="flex items-center gap-2 text-sm text-destructive">
                        <XCircle className="size-4" />
                        <span>失败文件</span>
                        <span className="tabular-nums">{execution.summary.failedFiles}</span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    {execution.summary.errorMessage && (
                      <div className="break-all text-sm text-destructive">
                        <span className="font-medium">错误信息</span>
                        <span className="ml-2">{execution.summary.errorMessage}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条执行记录</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除「{deleteTarget?.taskInfo.originPath || deleteTarget?.taskId}」在 {deleteTarget ? formatTime(deleteTarget.startTime) : ""} 的这次执行记录吗？记录和日志会一起删掉，无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (deleteTarget) void deleteHistory(deleteTarget.id);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除所有历史</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除全部 {history.length} 条执行记录吗？记录和日志会一起删掉，无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={() => void deleteAllHistory()}>
              全部删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

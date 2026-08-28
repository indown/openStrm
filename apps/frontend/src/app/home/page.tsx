"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CalendarClock,
  Edit,
  FileText,
  FolderX,
  History,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { TaskExecutionSummary } from "@openstrm/shared";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { api, type StartTaskResult, type TaskRow } from "@/lib/api";
import { apiErrorBody, apiErrorMessage } from "@/lib/axios";
import { AddTaskDialog } from "./components/AddTaskDialog";

/** 有任务在跑时的状态轮询间隔 */
const POLL_INTERVAL_MS = 5000;

type Account = { name: string; accountType: string };

/** 上次执行结果的配色，和历史页一致 */
const RUN_STATUS: Record<TaskExecutionSummary["status"], { label: string; className: string }> = {
  running: { label: "运行中", className: "bg-blue-100 text-blue-800 hover:bg-blue-100" },
  completed: { label: "成功", className: "bg-green-100 text-green-800 hover:bg-green-100" },
  failed: { label: "失败", className: "bg-red-100 text-red-800 hover:bg-red-100" },
  cancelled: { label: "已取消", className: "bg-yellow-100 text-yellow-800 hover:bg-yellow-100" },
};

function relativePast(ms: number): string {
  const d = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

function relativeFuture(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const d = Math.max(0, Math.floor((t - Date.now()) / 1000));
  if (d < 60) return "不到 1 分钟后";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟后`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时后`;
  return `${Math.floor(d / 86400)} 天后`;
}

function fmtTime(value: number | string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/** 后端 startTask 的 message 是固定的英文句式，界面上说成人话 */
function describeStart(res: StartTaskResult): string {
  const m = /^(\d+) files to download$/.exec(res.message);
  if (m) return `开始处理 ${m[1]} 个文件`;
  if (res.message === "no files to download") return "本地已是最新，没有需要处理的文件";
  return res.message;
}

/** 上次执行的一句话摘要 */
function describeRun(run: TaskExecutionSummary): string {
  if (run.status === "failed") return run.summary.errorMessage || "失败";
  if (run.status === "cancelled") return run.summary.errorMessage ? `已取消：${run.summary.errorMessage}` : "已取消";
  if (run.status === "running") return "进行中";
  const parts = [`${run.summary.downloadedFiles}/${run.summary.totalFiles} 个文件`];
  if (run.summary.deletedFiles) parts.push(`清理 ${run.summary.deletedFiles} 个`);
  return parts.join("，");
}

export default function Home() {
  const [data, setData] = useState<TaskRow[]>([]);
  // 只有首次加载显示整页转圈；之后的刷新和轮询表格留在屏幕上
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // 编辑 / 删除 / 清空目录弹框放在页面层，由当前操作的那一行驱动，不在每一行里各放一份
  const [editing, setEditing] = useState<TaskRow | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TaskRow | null>(null);
  const [clearTarget, setClearTarget] = useState<TaskRow | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [startingTasks, setStartingTasks] = useState<Set<string>>(new Set());
  // 列表请求的序号：慢的旧响应不能盖掉新状态（比如启动前发出的轮询把乐观标上的 processing 改回去）
  const listSeqRef = useRef(0);
  const router = useRouter();

  /** 拉任务列表。silent：后台轮询用，不转刷新按钮、失败也不弹提示（每 5 秒一条太吵） */
  const fetchTasks = useCallback(async (silent = false) => {
    const seq = ++listSeqRef.current;
    if (!silent) setRefreshing(true);
    try {
      const rows = await api.tasks.list();
      if (seq === listSeqRef.current) setData(rows);
    } catch (err) {
      if (!silent) toast.error(apiErrorMessage(err, "获取任务列表失败"));
    } finally {
      setLoaded(true);
      if (!silent) setRefreshing(false);
    }
  }, []);

  const fetchAccounts = useCallback(async () => {
    try {
      setAccountsLoading(true);
      const list = await api.accounts.list();
      setAccounts(list.map((a) => ({ name: a.name, accountType: a.accountType })));
    } catch (err) {
      toast.error(apiErrorMessage(err, "获取账户列表失败"));
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    fetchAccounts();
  }, [fetchTasks, fetchAccounts]);

  // 有任务在跑时每 5 秒刷一次状态；页面切到后台不刷，切回来立刻刷一次
  const hasProcessing = data.some((task) => task.status === "processing");
  useEffect(() => {
    if (!hasProcessing) return;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void fetchTasks(true);
    };
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void fetchTasks(true);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hasProcessing, fetchTasks]);

  // 有任务在跑或在启动的账户：同账户的任务互斥
  const busyAccounts = useMemo(() => {
    const set = new Set<string>();
    for (const task of data) {
      if (task.status === "processing" || startingTasks.has(task.id)) set.add(task.account);
    }
    return set;
  }, [data, startingTasks]);

  const deleteTask = async (task: TaskRow) => {
    try {
      await api.tasks.remove(task.id);
      toast.success("任务已删除");
      setDeleteTarget(null);
      fetchTasks();
    } catch (err) {
      toast.error(apiErrorMessage(err, "删除失败"));
    }
  };

  const startTask = useCallback(async (id: string) => {
    setStartingTasks((prev) => new Set(prev).add(id));
    try {
      const res = await api.tasks.start(id);
      toast.success(describeStart(res));
      if (res.warning) toast.warning(res.warning);
      // 只有在 API 成功返回后才更新状态为 processing；同时作废在途的列表响应，
      // 免得启动前发出的轮询把它改回 pending。之后的轮询会拿到真实状态
      listSeqRef.current++;
      setData((prev) => prev.map((task) => (task.id === id ? { ...task, status: "processing" as const } : task)));
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "ECONNABORTED") {
        toast.error("启动超时：读取网盘目录太久，请稍后到历史页看结果");
      } else if (error && typeof error === "object" && "response" in error) {
        const { message, details } = apiErrorBody(error);
        const text = message || "任务启动失败";
        toast.error(details ? `${text}：${details}` : text);
      } else {
        toast.error("任务启动失败");
      }
    } finally {
      setStartingTasks((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      // 起不来的也会进历史：把"上次执行"刷出来
      void fetchTasks(true);
    }
  }, [fetchTasks]);

  // 取消任务；不管成没成功都重新拉一次状态
  const cancelTask = useCallback(async (id: string) => {
    try {
      await api.tasks.cancel(id);
      toast.success("任务已取消");
    } catch (err) {
      toast.error(apiErrorMessage(err, "任务取消失败"));
    } finally {
      void fetchTasks(true);
    }
  }, [fetchTasks]);

  /** 运行中看实时日志；不在运行就去看这个任务的执行历史 */
  const openLogs = (task: TaskRow) => {
    const id = encodeURIComponent(task.id);
    router.push(task.status === "processing" ? `/log?taskId=${id}` : `/history?taskId=${id}`);
  };

  const clearDirectory = async (task: TaskRow) => {
    try {
      await api.system.clearDirectory(task.targetPath);
      toast.success(`已清空 ${task.targetPath}`);
      setClearTarget(null);
    } catch (error: unknown) {
      toast.error(apiErrorBody(error).message || "清空目录失败");
    }
  };

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex justify-between items-start gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">任务管理</h1>
          <p className="text-sm text-muted-foreground mt-1">
            每个任务把网盘的一个目录同步成本地的 strm 目录；可以手动跑，也可以定时
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => fetchTasks()} disabled={refreshing}>
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
            刷新
          </Button>
          <AddTaskDialog
            onSuccess={() => fetchTasks()}
            accounts={accounts}
            accountsLoading={accountsLoading}
            trigger={
              <Button>
                <Plus className="w-4 h-4 mr-2" />
                新建任务
              </Button>
            }
          />
        </div>
      </div>

      {data.length === 0 ? (
        <div className="text-center py-12 rounded-lg border border-dashed">
          <AlertCircle className="mx-auto h-10 w-10 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-medium">还没有任务</h3>
          <p className="mt-2 text-sm text-muted-foreground">点右上角「新建任务」，选一个网盘目录和本地目录就能开始</p>
        </div>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[280px]">任务</TableHead>
                <TableHead className="w-40">定时</TableHead>
                <TableHead className="w-60">上次执行</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-48 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((task) => {
                const starting = startingTasks.has(task.id);
                const running = task.status === "processing";
                const busy = busyAccounts.has(task.account);
                const startDisabled = starting || running || busy;
                const startTitle = starting
                  ? "启动中..."
                  : busy
                    ? `账户 ${task.account} 有任务正在运行`
                    : "开始同步";
                const run = task.lastRun;
                return (
                  <TableRow key={task.id}>
                    <TableCell className="align-top">
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <Badge
                            variant="outline"
                            className={`shrink-0 text-xs font-normal ${busy ? "border-orange-300 text-orange-700" : "text-muted-foreground"}`}
                            title={`账户 ${task.account}（${task.accountType ?? "?"}）`}
                          >
                            {task.account}
                          </Badge>
                          <span className="text-sm font-medium break-all" title={task.originPath}>
                            {task.originPath}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                          <span className="break-all" title={`本地路径：${task.targetPath}`}>
                            → {task.targetPath}
                          </span>
                          {task.enable302 && (
                            <Badge variant="secondary" className="shrink-0 text-[10px] px-1.5 py-0" title="Emby 302 直链已开启">
                              302
                            </Badge>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      {task.cronExpression ? (
                        <div className="space-y-0.5">
                          <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{task.cronExpression}</code>
                          {task.nextRunAt && (
                            <div
                              className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap"
                              title={`下次：${fmtTime(task.nextRunAt)}`}
                            >
                              <CalendarClock className="w-3 h-3" />
                              {relativeFuture(task.nextRunAt)}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">手动</span>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      {run ? (
                        <button
                          type="button"
                          className="text-left min-w-0 max-w-[230px] group"
                          title={`${fmtTime(run.startTime)}\n${describeRun(run)}\n点击查看执行历史`}
                          onClick={() => router.push(`/history?taskId=${encodeURIComponent(task.id)}`)}
                        >
                          <div className="flex items-center gap-2">
                            <Badge className={`border-0 ${RUN_STATUS[run.status].className}`}>{RUN_STATUS[run.status].label}</Badge>
                            <span className="text-xs text-muted-foreground whitespace-nowrap">{relativePast(run.startTime)}</span>
                          </div>
                          <div
                            className={`text-xs mt-1 truncate group-hover:underline ${run.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                          >
                            {describeRun(run)}
                          </div>
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">还没跑过</span>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      {starting ? (
                        <Badge variant="secondary" className="whitespace-nowrap">
                          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                          启动中
                        </Badge>
                      ) : running ? (
                        <Badge className={`border-0 whitespace-nowrap ${RUN_STATUS.running.className}`}>
                          <span className="w-2 h-2 mr-1.5 rounded-full bg-blue-600 animate-pulse" />
                          运行中
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground font-normal whitespace-nowrap">
                          空闲
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex justify-end gap-0.5">
                        {running ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            title="取消任务"
                            onClick={() => cancelTask(task.id)}
                          >
                            <Square className="w-4 h-4" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            title={startTitle}
                            disabled={startDisabled}
                            onClick={() => startTask(task.id)}
                          >
                            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          title={running ? "实时日志" : "执行历史"}
                          onClick={() => openLogs(task)}
                        >
                          {running ? <FileText className="w-4 h-4" /> : <History className="w-4 h-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          title={running ? "运行中不能编辑" : "编辑任务"}
                          disabled={running}
                          onClick={() => {
                            setEditing(task);
                            setEditorOpen(true);
                          }}
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                          title={running ? "运行中不能清空目录" : "清空本地目录"}
                          disabled={running}
                          onClick={() => setClearTarget(task)}
                        >
                          <FolderX className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          title={running ? "运行中不能删除" : "删除任务"}
                          disabled={running}
                          onClick={() => setDeleteTarget(task)}
                        >
                          <Trash2 className="w-4 h-4" />
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

      {/* 编辑弹框：整页一个，编辑哪一行就喂哪一行的数据 */}
      <AddTaskDialog
        task={editing ?? undefined}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        accounts={accounts}
        accountsLoading={accountsLoading}
        onSuccess={() => fetchTasks()}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="sm:max-w-[460px]">
          <AlertDialogHeader>
            <AlertDialogTitle>删除任务</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p className="break-all font-medium text-foreground">
                  {deleteTarget?.originPath} → {deleteTarget?.targetPath}
                </p>
                <p>账户 {deleteTarget?.account}。只删除任务定义和它的定时；本地已生成的 strm 不会被删。</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) void deleteTask(deleteTarget);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearTarget !== null} onOpenChange={(open) => !open && setClearTarget(null)}>
        <AlertDialogContent className="sm:max-w-[460px]">
          <AlertDialogHeader>
            <AlertDialogTitle>清空本地目录</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  将删除本地目录 <span className="font-medium text-foreground break-all">{clearTarget?.targetPath}</span> 下的所有文件和子目录，网盘不受影响。
                </p>
                <p className="text-destructive font-medium">此操作无法撤销；下次同步会重新生成 strm。</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={(e) => {
                e.preventDefault();
                if (clearTarget) void clearDirectory(clearTarget);
              }}
            >
              确认清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

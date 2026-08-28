"use client";

import { DataTable } from "@/components/data-table";
import { AddTaskDialog } from "./components/AddTaskDialog";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { ColumnDef } from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, type TaskRow } from "@/lib/api";
import { apiErrorBody, apiErrorMessage } from "@/lib/axios";
import { 
  Play, 
  Square, 
  FileText, 
  Edit, 
  Trash2, 
  Plus,
  CheckCircle,
  XCircle,
  AlertCircle,
  FolderX,
  Loader2,
  RefreshCw
} from "lucide-react";

/** 任务行：后端定义 + 运行状态；success/failed 是页面侧的展示态 */
export type Task = Omit<TaskRow, "status"> & { status: TaskRow["status"] | "success" | "failed" };

// 状态图标和颜色映射
const getStatusConfig = (status: Task["status"]) => {
  const configs = {
    pending: { icon: AlertCircle, color: "bg-slate-100 text-slate-700 hover:bg-slate-200 hover:text-slate-800", label: "待处理" },
    processing: { icon: AlertCircle, color: "bg-blue-100 text-blue-800 hover:bg-blue-200 hover:text-blue-900", label: "处理中" },
    success: { icon: CheckCircle, color: "bg-green-100 text-green-800 hover:bg-green-200 hover:text-green-900", label: "成功" },
    failed: { icon: XCircle, color: "bg-red-100 text-red-800 hover:bg-red-200 hover:text-red-900", label: "失败" }
  };
  return configs[status] || { icon: CheckCircle, color: "bg-gray-200 text-gray-700 border border-gray-300 hover:bg-gray-300 hover:text-gray-900", label: "空闲" };
};

// UI 样式常量
const BUTTON_STYLES = {
  disabled: "opacity-30 cursor-not-allowed bg-gray-100 hover:bg-gray-100",
  enabled: "hover:bg-green-50 hover:text-green-600",
  loading: "text-blue-600",
  icon: {
    disabled: "text-gray-400",
    enabled: "text-gray-600"
  }
} as const;

const ACCOUNT_STYLES = {
  busy: "border-orange-300 bg-orange-50 text-orange-700",
  normal: ""
} as const;

// 状态标签常量
const STATUS_LABELS = {
  starting: "启动中",
  running: "运行中"
} as const;

/** 有任务在跑时的状态轮询间隔 */
const POLL_INTERVAL_MS = 5000;

export default function Home() {
  const [data, setData] = useState<Task[]>([]);
  // 只有首次加载显示整页转圈；之后的刷新和轮询表格留在屏幕上
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // 编辑 / 删除 / 清空目录弹框放在页面层，由当前操作的那一行驱动，不在每一行里各放一份
  const [editing, setEditing] = useState<Task | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [clearTarget, setClearTarget] = useState<Task | null>(null);
  const [accounts, setAccounts] = useState<Array<{name: string, accountType: string}>>([]);
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

  // 获取账户列表
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

  // 删除任务
  const deleteTask = async (id: string) => {
    try {
      await api.tasks.remove(id);
      toast.success("任务删除成功");
      fetchTasks();
    } catch (err) {
      toast.error(apiErrorMessage(err, "删除失败"));
    }
  };

  // 开始任务
  const startTask = useCallback(async (id: string) => {
    // 添加到正在启动的任务集合
    setStartingTasks(prev => new Set(prev).add(id));
    
    try {
      const res = await api.tasks.start(id);
      toast.success(`任务已开始: ${res.message}`);
      
      // 只有在API成功返回后才更新状态为processing；同时作废在途的列表响应，
      // 免得启动前发出的轮询把它改回 pending。之后的轮询会拿到真实状态
      listSeqRef.current++;
      setData(prevData => 
        prevData.map(task => 
          task.id === id ? { ...task, status: "processing" as const } : task
        )
      );
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ECONNABORTED') {
        toast.error("任务启动超时，请稍后检查任务状态");
      } else if (error && typeof error === 'object' && 'response' in error) {
        const { message, details } = apiErrorBody(error);
        const text = message || "任务开始失败";
        toast.error(details ? `${text}: ${details}` : text);
      } else {
        toast.error("任务开始失败");
      }
    } finally {
      // 从正在启动的任务集合中移除
      setStartingTasks(prev => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
    }
  }, []);

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

  // 查看日志
  const goToLog = useCallback(async (id: string) => {
    if (await api.tasks.isRunning(id)) router.push(`/log?taskId=${id}`);
    else toast.error("没有找到对应的任务日志");
  }, [router]);

  // 清空目录
  const clearDirectory = async (targetPath: string) => {
    try {
      await api.system.clearDirectory(targetPath);
      toast.success(`目录 ${targetPath} 清空成功`);
    } catch (error: unknown) {
      toast.error(apiErrorBody(error).message || "清空目录失败");
    }
  };

  const columns = useMemo<ColumnDef<Task>[]>(() => {
    const isStarting = (task: Task) => startingTasks.has(task.id);
    const isBusy = (task: Task) => busyAccounts.has(task.account);
    // 检查任务是否应该被禁用
    const isDisabled = (task: Task) => isStarting(task) || task.status === "processing" || isBusy(task);
    // 获取任务显示状态
    const displayStatus = (task: Task) => {
      if (isStarting(task)) return { status: "processing" as const, label: STATUS_LABELS.starting };
      if (task.status === "processing") return { status: "processing" as const, label: STATUS_LABELS.running };
      return { status: task.status, label: getStatusConfig(task.status).label };
    };

    return [
      { 
        accessorKey: "id", 
        header: "任务ID",
        cell: ({ row }) => (
          <code className="text-xs bg-gray-100 px-2 py-1 rounded">
            {row.original.id.slice(0, 8)}...
          </code>
        )
      },
      { 
        accessorKey: "account", 
        header: "账户",
        cell: ({ row }) => {
          const task = row.original;
          const busy = isBusy(task);
          
          return (
            <div className="flex items-center gap-2">
              <Badge 
                variant="outline" 
                className={`text-xs ${
                  busy ? ACCOUNT_STYLES.busy : ACCOUNT_STYLES.normal
                }`}
              >
                {task.accountType}
              </Badge>
              <span className={`font-medium ${
                busy ? "text-orange-700" : ""
              }`}>
                {task.account}
                {busy && (
                  <span className="ml-1 text-xs text-orange-600">●</span>
                )}
              </span>
            </div>
          );
        }
      },
      { 
        accessorKey: "originPath", 
        header: "远程路径",
        cell: ({ row }) => (
          <span className="text-sm text-gray-600 max-w-xs truncate block">
            {row.original.originPath}
          </span>
        )
      },
      { 
        accessorKey: "targetPath", 
        header: "本地路径",
        cell: ({ row }) => {
          const task = row.original;
          return (
            <div className="group flex items-center gap-2 max-w-xs">
              <span className="text-sm text-gray-600 truncate flex-1">
                {task.targetPath}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-gray-400 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all duration-200 flex-shrink-0"
                title="清空目录"
                onClick={() => setClearTarget(task)}
              >
                <FolderX className="w-4 h-4" />
              </Button>
            </div>
          );
        }
      },
      { 
        accessorKey: "status", 
        header: "状态",
        cell: ({ row }) => {
          const { status, label } = displayStatus(row.original);
          const config = getStatusConfig(status);
          const Icon = config.icon;
          
          return (
            <Badge className={`${config.color} border-0`}>
              <Icon className="w-3 h-3 mr-1" />
              {label}
            </Badge>
          );
        }
      },
      {
        id: "actions",
        header: "操作",
        cell: ({ row }) => {
          const task = row.original;
          const starting = isStarting(task);
          const disabled = isDisabled(task);
          const running = task.status === "processing";
          
          return (
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => startTask(task.id)}
                disabled={disabled}
                className={`h-8 w-8 p-0 ${
                  disabled 
                    ? BUTTON_STYLES.disabled 
                    : running
                      ? "bg-blue-50 hover:bg-blue-100" 
                      : BUTTON_STYLES.enabled
                }`}
                title={
                  starting ? `${STATUS_LABELS.starting}...` :
                  running ? "任务运行中" :
                  isBusy(task) ? `账户 ${task.account} 有任务正在运行` :
                  "开始任务"
                }
              >
                {starting ? (
                  <Loader2 className={`w-4 h-4 animate-spin ${BUTTON_STYLES.loading}`} />
                ) : running ? (
                  <div className="w-4 h-4 flex items-center justify-center">
                    <div className="w-2 h-2 bg-blue-600 rounded-full animate-pulse"></div>
                  </div>
                ) : (
                  <Play className={`w-4 h-4 ${
                    disabled ? BUTTON_STYLES.icon.disabled : BUTTON_STYLES.icon.enabled
                  }`} />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => cancelTask(task.id)}
                disabled={!running}
                className="h-8 w-8 p-0"
                title={running ? "取消任务" : "任务未在运行"}
              >
                <Square className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => goToLog(task.id)}
                className="h-8 w-8 p-0"
                title="查看日志"
              >
                <FileText className="w-4 h-4" />
              </Button>
              <Button 
                variant="ghost" 
                size="sm"
                className="h-8 w-8 p-0"
                title="编辑任务"
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
                className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                title="删除任务"
                onClick={() => setDeleteTarget(task)}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          );
        },
      },
    ];
  }, [busyAccounts, startingTasks, startTask, cancelTask, goToLog]);

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="w-full h-full p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-semibold">任务管理</h1>
          <p className="text-gray-600 mt-1">管理和监控你的下载任务</p>
        </div>
        <div className="flex gap-2">
          <Button 
            variant="outline" 
            onClick={() => fetchTasks()}
            disabled={refreshing}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            刷新状态
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
        <div className="text-center py-12 bg-gray-50 rounded-lg">
          <AlertCircle className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-4 text-lg font-medium text-gray-900">暂无任务</h3>
          <p className="mt-2 text-gray-600">点击上方按钮创建你的第一个任务</p>
        </div>
      ) : (
        <DataTable columns={columns} data={data} getRowId={(t) => t.id} />
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
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              你确定要删除这个任务吗？此操作无法撤销。
              <br />
              <span className="text-sm text-gray-500 mt-2 block">
                任务ID: {deleteTarget?.id.slice(0, 8)}...
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (deleteTarget) void deleteTask(deleteTarget.id);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearTarget !== null} onOpenChange={(open) => !open && setClearTarget(null)}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>确认清空目录</AlertDialogTitle>
            <AlertDialogDescription>
              你确定要清空目标路径下的所有文件吗？此操作无法撤销。
              <br />
              <span className="text-sm text-gray-500 mt-2 block">
                目标路径: {clearTarget?.targetPath}
              </span>
              <br />
              <span className="text-sm text-red-600 mt-2 block font-medium">
                ⚠️ 这将删除该目录下的所有文件和子目录！
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (clearTarget) void clearDirectory(clearTarget.targetPath);
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

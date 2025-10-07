"use client";

import * as React from "react";
import { DataTable } from "@/components/data-table";
import { AddTaskDialog } from "./components/AddTaskDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ColumnDef } from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import axiosInstance from "@/lib/axios";
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

// Task 类型
export type Task = {
  id: string;
  accountType: string;
  account: string;
  originPath: string;
  targetPath: string;
  strmType: string;
  strmPrefix: string;
  removeExtraFiles?: boolean;
  name: string;
  path: string;
  status: "pending" | "processing" | "success" | "failed";
};

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

export default function Home() {
  const [data, setData] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState<string | null>(null);
  const [clearDialogOpen, setClearDialogOpen] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Array<{name: string, accountType: string}>>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [startingTasks, setStartingTasks] = useState<Set<string>>(new Set());
  const router = useRouter();

  // 检查账户是否有任务正在运行或启动
  const isAccountBusy = (accountName: string) => {
    return data.some(task => 
      task.account === accountName && 
      (task.status === "processing" || startingTasks.has(task.id))
    );
  };

  // 检查任务是否应该被禁用
  const isTaskDisabled = (task: Task) => {
    const isStarting = startingTasks.has(task.id);
    const isRunning = task.status === "processing";
    const hasSameAccountRunning = isAccountBusy(task.account);
    
    return isStarting || isRunning || hasSameAccountRunning;
  };

  // 获取任务显示状态
  const getTaskDisplayStatus = (task: Task) => {
    const isStarting = startingTasks.has(task.id);
    const isRunning = task.status === "processing";
    
    if (isStarting) {
      return { status: "processing" as const, label: STATUS_LABELS.starting };
    } else if (isRunning) {
      return { status: "processing" as const, label: STATUS_LABELS.running };
    } else {
      return { status: task.status, label: getStatusConfig(task.status).label };
    }
  };

  useEffect(() => {
    fetchTasks();
    fetchAccounts();
  }, []);

  // 获取任务列表
  const fetchTasks = async () => {
    try {
      setIsLoading(true);
      const res = await axiosInstance.get("/api/task");
      setData(res.data);
    } catch {
      toast.error("获取任务列表失败");
    } finally {
      setIsLoading(false);
    }
  };

  // 获取账户列表
  const fetchAccounts = async () => {
    try {
      setAccountsLoading(true);
      const res = await axiosInstance.get("/api/account");
      setAccounts(res.data.map((a: { name: string, accountType: string }) => ({ name: a.name, accountType: a.accountType })));
    } catch {
      toast.error("获取账户列表失败");
    } finally {
      setAccountsLoading(false);
    }
  };



  // 删除任务
  const deleteTask = async (id: string) => {
    try {
      await axiosInstance.delete(`/api/task?id=${id}`);
      toast.success("任务删除成功");
      fetchTasks();
    } catch {
      toast.error("删除失败");
    }
  };

  // 开始任务
  const startTask = async (id: string) => {
    // 添加到正在启动的任务集合
    setStartingTasks(prev => new Set(prev).add(id));
    
    try {
      const res = await axiosInstance.post("/api/startTask", { id }, {
        timeout: 180000 // 设置60秒超时
      });
      toast.success(`任务已开始: ${res.data.message}`);
      
      // 只有在API成功返回后才更新状态为processing
      setData(prevData => 
        prevData.map(task => 
          task.id === id ? { ...task, status: "processing" as const } : task
        )
      );
      
      // 移除自动刷新，让用户手动刷新或通过其他方式查看状态
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ECONNABORTED') {
        toast.error("任务启动超时，请稍后检查任务状态");
      } else if (error && typeof error === 'object' && 'response' in error) {
        // 处理API错误响应
        const apiError = error as { response?: { data?: { message?: string; error?: string } } };
        const message = apiError.response?.data?.message || "任务开始失败";
        const detail = apiError.response?.data?.error;
        const errorText = detail ? `${message}: ${detail}` : message;
        toast.error(errorText);
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
  };

  // 取消任务
  const cancelTask = async (id: string) => {
    try {
      await axiosInstance.post("/api/cancelTask", { id });
      toast.success("任务已取消");
    } catch {
      toast.error("任务取消失败");
    }
  };

  // 查看日志
  const goToLog = async (id: string) => {
    try {
      const logRes = await axiosInstance.get(`/api/taskLog/${id}`);
      if (logRes.data.taskId) router.push(`/log/${id}`);
      else toast.error("没有找到对应的任务日志");
    } catch {
      toast.error("没有找到对应的任务日志");
    }
  };

  // 清空目录
  const clearDirectory = async (targetPath: string) => {
    try {
      await axiosInstance.post("/api/clearDirectory", { targetPath });
      toast.success(`目录 ${targetPath} 清空成功`);
    } catch (error: unknown) {
      const errorMessage = (error as { response?: { data?: { error?: string } } })?.response?.data?.error || "清空目录失败";
      toast.error(errorMessage);
    }
  };

  const columns: ColumnDef<Task>[] = [
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
        const isBusy = isAccountBusy(task.account);
        
        return (
          <div className="flex items-center gap-2">
            <Badge 
              variant="outline" 
              className={`text-xs ${
                isBusy ? ACCOUNT_STYLES.busy : ACCOUNT_STYLES.normal
              }`}
            >
              {task.accountType}
            </Badge>
            <span className={`font-medium ${
              isBusy ? "text-orange-700" : ""
            }`}>
              {task.account}
              {isBusy && (
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
            <Dialog 
              open={clearDialogOpen === task.id} 
              onOpenChange={(open) => setClearDialogOpen(open ? task.id : null)}
            >
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-gray-400 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all duration-200 flex-shrink-0"
                  title="清空目录"
                >
                  <FolderX className="w-4 h-4" />
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle>确认清空目录</DialogTitle>
                  <DialogDescription>
                    你确定要清空目标路径下的所有文件吗？此操作无法撤销。
                    <br />
                    <span className="text-sm text-gray-500 mt-2 block">
                      目标路径: {task.targetPath}
                    </span>
                    <br />
                    <span className="text-sm text-red-600 mt-2 block font-medium">
                      ⚠️ 这将删除该目录下的所有文件和子目录！
                    </span>
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter className="gap-2">
                  <Button 
                    variant="outline"
                    onClick={() => setClearDialogOpen(null)}
                  >
                    取消
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      clearDirectory(task.targetPath);
                      setClearDialogOpen(null);
                    }}
                  >
                    确认清空
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        );
      }
    },
    { 
      accessorKey: "status", 
      header: "状态",
      cell: ({ row }) => {
        const task = row.original;
        const { status, label } = getTaskDisplayStatus(task);
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
        const isStarting = startingTasks.has(task.id);
        const isDisabled = isTaskDisabled(task);
        
        return (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => startTask(task.id)}
              disabled={isDisabled}
              className={`h-8 w-8 p-0 ${
                isDisabled 
                  ? BUTTON_STYLES.disabled 
                  : task.status === "processing"
                    ? "bg-blue-50 hover:bg-blue-100" 
                    : BUTTON_STYLES.enabled
              }`}
              title={
                isStarting ? `${STATUS_LABELS.starting}...` :
                task.status === "processing" ? "任务运行中" :
                isAccountBusy(task.account) ? `账户 ${task.account} 有任务正在运行` :
                "开始任务"
              }
            >
              {isStarting ? (
                <Loader2 className={`w-4 h-4 animate-spin ${BUTTON_STYLES.loading}`} />
              ) : task.status === "processing" ? (
                <div className="w-4 h-4 flex items-center justify-center">
                  <div className="w-2 h-2 bg-blue-600 rounded-full animate-pulse"></div>
                </div>
              ) : (
                <Play className={`w-4 h-4 ${
                  isDisabled ? BUTTON_STYLES.icon.disabled : BUTTON_STYLES.icon.enabled
                }`} />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => cancelTask(task.id)}
              className="h-8 w-8 p-0"
              title="取消任务"
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
            <AddTaskDialog
              task={task}
              accounts={accounts}
              accountsLoading={accountsLoading}
              trigger={
                <Button 
                  variant="ghost" 
                  size="sm"
                  className="h-8 w-8 p-0"
                  title="编辑任务"
                >
                  <Edit className="w-4 h-4" />
                </Button>
              }
              onSuccess={fetchTasks}
            />
            <Dialog 
              open={deleteDialogOpen === task.id} 
              onOpenChange={(open) => setDeleteDialogOpen(open ? task.id : null)}
            >
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                  title="删除任务"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle>确认删除</DialogTitle>
                  <DialogDescription>
                    你确定要删除这个任务吗？此操作无法撤销。
                    <br />
                    <span className="text-sm text-gray-500 mt-2 block">
                      任务ID: {task.id.slice(0, 8)}...
                    </span>
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter className="gap-2">
                  <Button 
                    variant="outline"
                    onClick={() => setDeleteDialogOpen(null)}
                  >
                    取消
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      deleteTask(task.id);
                      setDeleteDialogOpen(null);
                    }}
                  >
                    删除
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        );
      },
    },
  ];

  if (isLoading) {
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
            onClick={fetchTasks}
            disabled={isLoading}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            刷新状态
          </Button>
          <AddTaskDialog 
            onSuccess={fetchTasks}
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
        <DataTable columns={columns} data={data} />
      )}
    </div>
  );
}

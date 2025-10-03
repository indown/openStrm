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
  FolderX
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
  name: string;
  path: string;
  status: "pending" | "processing" | "success" | "failed";
};

// 状态图标和颜色映射
const getStatusConfig = (status: Task["status"]) => {
  const configs = {
    pending: { icon: AlertCircle, color: "bg-yellow-100 text-yellow-800", label: "待处理" },
    processing: { icon: AlertCircle, color: "bg-blue-100 text-blue-800", label: "处理中" },
    success: { icon: CheckCircle, color: "bg-green-100 text-green-800", label: "成功" },
    failed: { icon: XCircle, color: "bg-red-100 text-red-800", label: "失败" }
  };
  return configs[status] || { icon: AlertCircle, color: "bg-gray-100 text-gray-800", label: "未知" };
};

export default function Home() {
  const [data, setData] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState<string | null>(null);
  const [clearDialogOpen, setClearDialogOpen] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Array<{name: string, accountType: string}>>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const router = useRouter();

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
    try {
      const res = await axiosInstance.post("/api/startTask", { id });
      toast.success(`任务已开始: ${res.data.message}`);
    } catch {
      toast.error("任务开始失败");
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
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {row.original.accountType}
          </Badge>
          <span className="font-medium">{row.original.account}</span>
        </div>
      )
    },
    { 
      accessorKey: "originPath", 
      header: "源路径",
      cell: ({ row }) => (
        <span className="text-sm text-gray-600 max-w-xs truncate block">
          {row.original.originPath}
        </span>
      )
    },
    { 
      accessorKey: "targetPath", 
      header: "目标路径",
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
        const config = getStatusConfig(row.original.status);
        const Icon = config.icon;
        return (
          <Badge className={`${config.color} border-0`}>
            <Icon className="w-3 h-3 mr-1" />
            {config.label}
          </Badge>
        );
      }
    },
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => {
        const task = row.original;
        return (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => startTask(task.id)}
              className="h-8 w-8 p-0"
              title="开始任务"
            >
              <Play className="w-4 h-4" />
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

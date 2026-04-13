"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import axiosInstance from "@/lib/axios";
import { 
  Clock, 
  CheckCircle, 
  XCircle, 
  AlertCircle, 
  Trash2,
  Eye,
  Calendar,
  User,
  Folder,
  FileText,
  Download,
  Trash
} from "lucide-react";

interface TaskExecutionHistory {
  id: string;
  taskId: string;
  startTime: number;
  endTime?: number;
  status: "running" | "completed" | "failed" | "cancelled";
  logs: string[];
  summary: {
    totalFiles: number;
    downloadedFiles: number;
    deletedFiles: number;
    errorMessage?: string;
  };
  taskInfo: {
    account: string;
    originPath: string;
    targetPath: string;
    removeExtraFiles: boolean;
  };
}

// 状态图标和颜色映射
const getStatusConfig = (status: TaskExecutionHistory["status"]) => {
  const configs = {
    running: { icon: Clock, color: "bg-blue-100 text-blue-800", label: "运行中" },
    completed: { icon: CheckCircle, color: "bg-green-100 text-green-800", label: "已完成" },
    failed: { icon: XCircle, color: "bg-red-100 text-red-800", label: "失败" },
    cancelled: { icon: AlertCircle, color: "bg-yellow-100 text-yellow-800", label: "已取消" },
  };
  return configs[status];
};

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

export default function TaskHistoryPage() {
  const [history, setHistory] = useState<TaskExecutionHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    try {
      setLoading(true);
      const response = await axiosInstance.get("/api/taskHistory");
      setHistory(response.data);
    } catch (error) {
      console.error("Failed to fetch task history:", error);
      toast.error("获取任务历史失败");
    } finally {
      setLoading(false);
    }
  };

  const deleteHistory = async (executionId: string) => {
    try {
      await axiosInstance.delete(`/api/taskHistory?executionId=${executionId}`);
      setHistory(history.filter(h => h.id !== executionId));
      toast.success("删除成功");
    } catch (error) {
      console.error("Failed to delete history:", error);
      toast.error("删除失败");
    }
  };

  const deleteAllHistory = async () => {
    try {
      await axiosInstance.delete("/api/taskHistory?action=cleanup");
      toast.success("所有历史记录已删除");
      // 重新加载历史记录
      fetchHistory();
    } catch (error) {
      console.error("Failed to delete history:", error);
      toast.error("删除失败");
    }
  };

  const viewLogs = (execution: TaskExecutionHistory) => {
    // 跳转到日志查看页面
    window.open(`/log/${execution.taskId}?executionId=${execution.id}`, "_blank");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto"></div>
          <p className="mt-2 text-gray-600">加载中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">任务执行历史</h1>
          <p className="text-sm text-muted-foreground mt-1">
            查看所有任务的执行记录和状态
          </p>
        </div>
        <div className="flex space-x-2">
          <Button onClick={fetchHistory} variant="outline">
            刷新
          </Button>
          <Button onClick={deleteAllHistory} variant="outline">
            删除所有历史
          </Button>
        </div>
      </div>

      {history.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-center h-32">
            <div className="text-center">
              <FileText className="h-8 w-8 text-gray-400 mx-auto mb-2" />
              <p className="text-gray-600">暂无任务执行历史</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {history.map((execution) => {
            const statusConfig = getStatusConfig(execution.status);
            const StatusIcon = statusConfig.icon;
            
            return (
              <Card key={execution.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <StatusIcon className="h-5 w-5" />
                      <div>
                        <CardTitle className="text-lg">
                          任务 {execution.taskId}
                        </CardTitle>
                        <CardDescription className="flex items-center space-x-4 mt-1">
                          <span className="flex items-center space-x-1">
                            <User className="h-4 w-4" />
                            <span>{execution.taskInfo.account}</span>
                          </span>
                          <span className="flex items-center space-x-1">
                            <Folder className="h-4 w-4" />
                            <span>{execution.taskInfo.originPath}</span>
                          </span>
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Badge className={statusConfig.color}>
                        {statusConfig.label}
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => viewLogs(execution)}
                      >
                        <Eye className="h-4 w-4 mr-1" />
                        查看日志
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => deleteHistory(execution.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                
                <CardContent className="pt-0">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <div className="flex items-center space-x-2 text-sm">
                        <Calendar className="h-4 w-4 text-gray-500" />
                        <span className="font-medium">开始时间:</span>
                        <span>{formatTime(execution.startTime)}</span>
                      </div>
                      {execution.endTime && (
                        <div className="flex items-center space-x-2 text-sm">
                          <Clock className="h-4 w-4 text-gray-500" />
                          <span className="font-medium">执行时长:</span>
                          <span>{getDuration(execution.startTime, execution.endTime)}</span>
                        </div>
                      )}
                    </div>
                    
                    <div className="space-y-2">
                      <div className="flex items-center space-x-2 text-sm">
                        <Download className="h-4 w-4 text-gray-500" />
                        <span className="font-medium">下载文件:</span>
                        <span>{execution.summary.downloadedFiles}/{execution.summary.totalFiles}</span>
                      </div>
                      {execution.taskInfo.removeExtraFiles && (
                        <div className="flex items-center space-x-2 text-sm">
                          <Trash className="h-4 w-4 text-gray-500" />
                          <span className="font-medium">删除文件:</span>
                          <span>{execution.summary.deletedFiles}</span>
                        </div>
                      )}
                    </div>
                    
                    <div className="space-y-2">
                      <div className="text-sm">
                        <span className="font-medium">目标路径:</span>
                        <span className="ml-2 text-gray-600">{execution.taskInfo.targetPath}</span>
                      </div>
                      {execution.summary.errorMessage && (
                        <div className="text-sm text-red-600">
                          <span className="font-medium">错误信息:</span>
                          <span className="ml-2">{execution.summary.errorMessage}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

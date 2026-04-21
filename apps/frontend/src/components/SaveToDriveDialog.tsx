"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight, FolderOpen } from "lucide-react";
import axiosInstance from "@/lib/axios";
import { toast } from "sonner";

export interface TaskOption {
  id: string;
  account: string;
  originPath: string;
  targetPath: string;
  strmPrefix?: string;
}

export interface SaveToTaskChoice {
  taskId: string;
  subPath: string;
  mode: "sync" | "async";
}

interface SaveToDriveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (choice: SaveToTaskChoice) => void;
  selectedCount: number;
}

interface RemoteDir {
  name: string;
  id: number;
  isDir: boolean;
  hasChildren: boolean;
}

export function SaveToDriveDialog({
  open,
  onOpenChange,
  onConfirm,
  selectedCount,
}: SaveToDriveDialogProps) {
  const [tasks, setTasks] = useState<TaskOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [mode, setMode] = useState<"sync" | "async">("sync");
  const [subSegments, setSubSegments] = useState<string[]>([]);
  const [subdirs, setSubdirs] = useState<RemoteDir[]>([]);
  const [subdirLoading, setSubdirLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    axiosInstance
      .get<TaskOption[]>("/api/task")
      .then((res) => {
        const list = Array.isArray(res.data) ? res.data : [];
        setTasks(list);
        if (list.length > 0 && !selectedTaskId) setSelectedTaskId(list[0].id);
      })
      .catch(() => toast.error("加载任务列表失败"))
      .finally(() => setLoading(false));
  }, [open, selectedTaskId]);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId);
  const taskInvalid = selectedTask && (!selectedTask.targetPath || !selectedTask.strmPrefix);
  const subPath = subSegments.join("/");

  useEffect(() => {
    if (!open || !selectedTask) return;
    setSubSegments([]);
  }, [open, selectedTaskId, selectedTask]);

  useEffect(() => {
    if (!open || !selectedTask) return;
    const fullPath = subSegments.length
      ? `${selectedTask.originPath}/${subSegments.join("/")}`
      : selectedTask.originPath;
    setSubdirLoading(true);
    axiosInstance
      .post<{ code: number; data?: RemoteDir[] }>("/api/directory/remote/list", {
        account: selectedTask.account,
        path: fullPath,
      })
      .then((res) => {
        setSubdirs(res.data?.data ?? []);
      })
      .catch(() => {
        setSubdirs([]);
      })
      .finally(() => setSubdirLoading(false));
  }, [open, selectedTask, subSegments]);

  const handleOpenSubdir = (name: string) => {
    setSubSegments((prev) => [...prev, name]);
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index === subSegments.length) return;
    setSubSegments((prev) => prev.slice(0, index));
  };

  const handleConfirm = () => {
    if (!selectedTaskId) return;
    if (taskInvalid) {
      toast.error("所选任务缺少 targetPath 或 strmPrefix 配置");
      return;
    }
    onConfirm({ taskId: selectedTaskId, subPath, mode });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>保存到任务目录</DialogTitle>
          <DialogDescription>
            将已选中的 {selectedCount} 项保存到任务对应的 115 目录，并生成 strm 文件。
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto min-h-0 space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">目标任务</label>
            {loading ? (
              <div className="text-sm text-muted-foreground">加载中...</div>
            ) : tasks.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                暂无任务，请先到首页创建一个指向你希望保存到的 115 目录的任务。
              </div>
            ) : (
              <Select value={selectedTaskId} onValueChange={setSelectedTaskId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择任务" />
                </SelectTrigger>
                <SelectContent>
                  {tasks.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.originPath} → {t.targetPath || "(未配置)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {taskInvalid && (
              <div className="text-xs text-destructive">
                所选任务缺少 targetPath 或 strmPrefix
              </div>
            )}
          </div>

          {selectedTask && !taskInvalid && (
            <div className="space-y-2">
              <label className="text-sm font-medium">保存位置（可进入子目录）</label>
              <div className="border rounded-md overflow-hidden">
                <div className="flex items-center gap-1 px-3 py-2 text-xs bg-muted/40 border-b flex-wrap min-w-0">
                  <button
                    type="button"
                    onClick={() => handleBreadcrumbClick(0)}
                    className={`hover:text-foreground truncate max-w-[240px] ${
                      subSegments.length === 0
                        ? "font-medium text-foreground cursor-default"
                        : "underline cursor-pointer"
                    }`}
                    title={selectedTask.originPath}
                  >
                    {selectedTask.originPath}
                  </button>
                  {subSegments.map((seg, idx) => (
                    <span key={idx} className="flex items-center gap-1 min-w-0">
                      <ChevronRight className="h-3 w-3 shrink-0" />
                      <button
                        type="button"
                        onClick={() => handleBreadcrumbClick(idx + 1)}
                        className={`hover:text-foreground truncate max-w-[120px] ${
                          idx === subSegments.length - 1
                            ? "font-medium text-foreground cursor-default"
                            : "underline cursor-pointer"
                        }`}
                        title={seg}
                      >
                        {seg}
                      </button>
                    </span>
                  ))}
                </div>
                <div className="max-h-[180px] overflow-auto">
                  {subdirLoading ? (
                    <div className="p-3 text-center text-xs text-muted-foreground">加载中...</div>
                  ) : subdirs.length === 0 ? (
                    <div className="p-3 text-center text-xs text-muted-foreground">
                      此目录下没有子文件夹
                    </div>
                  ) : (
                    <ul className="py-1">
                      {subdirs.map((d) => (
                        <li key={d.id}>
                          <button
                            type="button"
                            onClick={() => handleOpenSubdir(d.name)}
                            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent text-left text-sm"
                          >
                            <FolderOpen className="h-4 w-4 text-amber-500 shrink-0" />
                            <span className="truncate">{d.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">生成方式</label>
            <div className="space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="strmMode"
                  value="sync"
                  checked={mode === "sync"}
                  onChange={() => setMode("sync")}
                  className="mt-1"
                />
                <div>
                  <div className="text-sm font-medium">同步</div>
                  <div className="text-xs text-muted-foreground">
                    立即生成所选项目的 strm。适合少量文件，接口返回时带上生成数量。
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="strmMode"
                  value="async"
                  checked={mode === "async"}
                  onChange={() => setMode("async")}
                  className="mt-1"
                />
                <div>
                  <div className="text-sm font-medium">后台</div>
                  <div className="text-xs text-muted-foreground">
                    保存后触发任务全量同步，会扫 task.originPath 下所有文件补齐 strm。可到日志页看进度。
                  </div>
                </div>
              </label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={!selectedTaskId || !!taskInvalid || loading}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

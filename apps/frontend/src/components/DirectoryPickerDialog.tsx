"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FolderOpen, ChevronRight } from "lucide-react";
import axiosInstance from "@/lib/axios";
import { toast } from "sonner";

interface DirectoryItem {
  cid: number;
  n: string;
  fc: number;
}

interface BreadcrumbItem {
  cid: number;
  name: string;
}

interface DirectoryPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (cid: number) => void;
}

export function DirectoryPickerDialog({
  open,
  onOpenChange,
  onSelect,
}: DirectoryPickerDialogProps) {
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([
    { cid: 0, name: "根目录" },
  ]);
  const [directories, setDirectories] = useState<DirectoryItem[]>([]);
  const [loading, setLoading] = useState(false);

  const currentCid = breadcrumb[breadcrumb.length - 1].cid;

  useEffect(() => {
    if (open) {
      fetchDirectories(0);
    }
  }, [open]);

  const fetchDirectories = async (cid: number) => {
    setLoading(true);
    try {
      const res = await axiosInstance.post("/api/115/files", { cid });
      if (res.data.code === 200) {
        const dirs = (res.data.data || []).filter((item: DirectoryItem) => item.fc === 0);
        setDirectories(dirs);
      } else {
        toast.error("加载目录失败");
      }
    } catch {
      toast.error("加载目录失败");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenFolder = (dir: DirectoryItem) => {
    setBreadcrumb((prev) => [...prev, { cid: dir.cid, name: dir.n }]);
    fetchDirectories(dir.cid);
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index === breadcrumb.length - 1) return;
    const item = breadcrumb[index];
    setBreadcrumb((prev) => prev.slice(0, index + 1));
    fetchDirectories(item.cid);
  };

  const handleConfirm = () => {
    onSelect(currentCid);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>选择保存位置</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap mb-4">
          {breadcrumb.map((item, index) => (
            <span key={item.cid} className="flex items-center gap-1">
              {index > 0 && <ChevronRight className="h-4 w-4 shrink-0" />}
              <button
                type="button"
                onClick={() => handleBreadcrumbClick(index)}
                className={`hover:text-foreground truncate max-w-[120px] ${
                  index === breadcrumb.length - 1
                    ? "font-medium text-foreground cursor-default"
                    : "underline cursor-pointer"
                }`}
                title={item.name}
              >
                {item.name}
              </button>
            </span>
          ))}
        </div>
        <div className="border rounded-md min-h-[300px] max-h-[400px] overflow-auto">
          {loading ? (
            <div className="p-6 text-center text-muted-foreground">加载中...</div>
          ) : directories.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">此目录下没有子文件夹</div>
          ) : (
            <div className="p-2">
              {directories.map((dir) => (
                <button
                  key={dir.cid}
                  onClick={() => handleOpenFolder(dir)}
                  className="w-full flex items-center gap-2 p-2 hover:bg-accent rounded-md text-left"
                >
                  <FolderOpen className="h-4 w-4 text-amber-500 shrink-0" />
                  <span className="truncate">{dir.n}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleConfirm}>
            保存到此位置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

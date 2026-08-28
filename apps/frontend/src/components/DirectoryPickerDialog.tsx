"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FolderOpen, ChevronRight } from "lucide-react";
import { api, type Drive115Item } from "@/lib/api";
import { toast } from "sonner";

type DirectoryItem = Drive115Item;

interface BreadcrumbItem {
  cid: number;
  name: string;
}

interface DirectoryPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (cid: number) => void;
}

const ROOT_CRUMB: BreadcrumbItem = { cid: 0, name: "根目录" };

export function DirectoryPickerDialog({
  open,
  onOpenChange,
  onSelect,
}: DirectoryPickerDialogProps) {
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([ROOT_CRUMB]);
  const [directories, setDirectories] = useState<DirectoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  // 连续点目录时只认最后一次请求，慢的旧响应不能盖掉新目录
  const seqRef = useRef(0);

  const currentCid = breadcrumb[breadcrumb.length - 1].cid;

  const fetchDirectories = useCallback(async (cid: number) => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const list = ((await api.drive115.list(cid)) || []).filter((item) => item.fc === 0);
      if (seq !== seqRef.current) return;
      setDirectories(list);
    } catch {
      if (seq !== seqRef.current) return;
      toast.error("加载目录失败");
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  // 每次打开都从根目录开始：面包屑不重置的话，"保存到此位置"会指向上次逛到的目录
  useEffect(() => {
    if (!open) return;
    setBreadcrumb([ROOT_CRUMB]);
    fetchDirectories(0);
  }, [open, fetchDirectories]);

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

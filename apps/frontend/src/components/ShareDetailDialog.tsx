"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { File, ChevronRight, FolderOpen, Download } from "lucide-react";
import axiosInstance from "@/lib/axios";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DirectoryPickerDialog } from "@/components/DirectoryPickerDialog";

export interface ShareFileItem {
  id: number;
  name: string;
  is_dir: boolean;
  parent_id: number;
  size?: number;
  [k: string]: unknown;
}

interface BreadcrumbItem {
  id: string;
  name: string;
}

interface ShareDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shareInfo: Record<string, unknown> | null;
  fileList: ShareFileItem[];
  shareLink: string;
  loading?: boolean;
}

function formatSize(bytes?: number): string {
  if (bytes == null || bytes === 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function ShareDetailDialog({
  open,
  onOpenChange,
  shareInfo,
  fileList: initialFileList,
  shareLink,
  loading: initialLoading = false,
}: ShareDetailDialogProps) {
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([{ id: "0", name: "根目录" }]);
  const [currentList, setCurrentList] = useState<ShareFileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [targetCid, setTargetCid] = useState(0);

  const shareInfoData = shareInfo?.share_info as Record<string, unknown> | undefined;
  const title = (shareInfoData?.name ?? shareInfoData?.share_name ?? "115 分享") as string;
  const createTime =
    shareInfoData?.create_time != null
      ? new Date(Number(shareInfoData.create_time) * 1000).toLocaleString()
      : "";

  // 弹框打开时用根目录列表初始化；关闭时重置面包屑和列表
  useEffect(() => {
    if (open) {
      setBreadcrumb([{ id: "0", name: "根目录" }]);
      setCurrentList(initialFileList);
      setSelectedIds(new Set());
    }
  }, [open, initialFileList]);

  const fetchList = async (cid: string) => {
    if (!shareLink.trim()) return;
    setLoading(true);
    try {
      const res = await axiosInstance.post<{ code: number; data?: ShareFileItem[] }>(
        "/api/115/share",
        { action: "list", url: shareLink.trim(), cid }
      );
      if (res.data.code !== 200) {
        toast.error("加载目录失败");
        return;
      }
      setCurrentList(res.data.data ?? []);
    } catch {
      toast.error("加载目录失败");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenFolder = (item: ShareFileItem) => {
    if (!item.is_dir) return;
    const cid = String(item.cid);
    setBreadcrumb((prev) => [...prev, { id: cid, name: item.name }]);
    fetchList(cid);
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index === breadcrumb.length - 1) return;
    const item = breadcrumb[index];
    setBreadcrumb((prev) => prev.slice(0, index + 1));
    fetchList(item.id);
  };

  const toggleSelect = (item: ShareFileItem) => {
    const itemId = item.is_dir ? String(item.cid) : String(item.id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const handleSaveToMyDrive = async () => {
    if (selectedIds.size === 0) {
      toast.error("请先选择要保存的文件");
      return;
    }
    setShowDirPicker(true);
  };

  const handleDirSelected = async (cid: number) => {
    setSaving(true);
    try {
      const res = await axiosInstance.post("/api/115/share", {
        action: "receive",
        url: shareLink.trim(),
        fileIds: Array.from(selectedIds),
        toPid: String(cid),
      });
      if (res.data.code === 200) {
        if (res.data.strmGenerated) {
          toast.success(`保存成功并生成了 ${res.data.generatedCount} 个 strm 文件`);
        } else {
          toast.success("保存成功");
        }
        setSelectedIds(new Set());
      } else {
        toast.error("保存失败");
      }
    } catch {
      toast.error("保存失败");
    } finally {
      setSaving(false);
    }
  };

  const displayList = open ? currentList : [];
  const isLoading = initialLoading || loading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {createTime && (
            <DialogDescription>创建时间：{createTime}</DialogDescription>
          )}
        </DialogHeader>
        {/* 面包屑 */}
        <div className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
          {breadcrumb.map((item, index) => (
            <span key={item.id} className="flex items-center gap-1">
              {index > 0 && <ChevronRight className="h-4 w-4 shrink-0" />}
              <button
                type="button"
                onClick={() => handleBreadcrumbClick(index)}
                className={`hover:text-foreground truncate max-w-[120px] ${index === breadcrumb.length - 1 ? "font-medium text-foreground cursor-default" : "underline cursor-pointer"}`}
                title={item.name}
              >
                {item.name}
              </button>
            </span>
          ))}
        </div>
        <div className="flex-1 overflow-auto border rounded-md min-h-0">
          {isLoading ? (
            <div className="p-6 text-center text-muted-foreground">加载中...</div>
          ) : displayList.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">暂无文件</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40px]" />
                  <TableHead className="w-[40px]" />
                  <TableHead>名称</TableHead>
                  <TableHead className="text-right">大小</TableHead>
                  <TableHead className="w-[80px]">类型</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayList.map((item) => {
                  const itemId = item.is_dir ? String(item.cid) : String(item.id);
                  const isSelected = selectedIds.has(itemId);
                  return (
                    <TableRow key={itemId}>
                      <TableCell className="py-1">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleSelect(item)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </TableCell>
                      <TableCell
                        className="py-1 cursor-pointer"
                        onClick={() => handleOpenFolder(item)}
                      >
                        {item.is_dir ? (
                          <FolderOpen className="h-4 w-4 text-amber-500" />
                        ) : (
                          <File className="h-4 w-4 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell
                        className="font-medium truncate max-w-[200px] cursor-pointer"
                        title={item.name}
                        onClick={() => handleOpenFolder(item)}
                      >
                        {item.name}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {item.is_dir ? "-" : formatSize(item.size)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.is_dir ? "文件夹" : "文件"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
        {selectedIds.size > 0 && (
          <div className="flex items-center justify-between pt-4 border-t">
            <span className="text-sm text-muted-foreground">
              已选择 {selectedIds.size} 项
            </span>
            <Button onClick={handleSaveToMyDrive} disabled={saving}>
              <Download className="h-4 w-4 mr-2" />
              {saving ? "保存中..." : "保存到我的网盘"}
            </Button>
          </div>
        )}
      </DialogContent>
      <DirectoryPickerDialog
        open={showDirPicker}
        onOpenChange={setShowDirPicker}
        onSelect={handleDirSelected}
      />
    </Dialog>
  );
}

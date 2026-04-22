"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
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
import { File, ChevronRight, FolderOpen, Download, ChevronLeft, ChevronsLeft, ChevronsRight, BookmarkPlus } from "lucide-react";
import axiosInstance from "@/lib/axios";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DirectoryPickerDialog } from "@/components/DirectoryPickerDialog";
import { SaveToDriveDialog, type SaveToTaskChoice } from "@/components/SaveToDriveDialog";
import { AddToLibraryDialog, type AddToLibraryInitial } from "@/components/AddToLibraryDialog";

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
  fileCount: number;
  shareLink: string;
  loading?: boolean;
}

const PAGE_SIZE = 32;

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
  fileCount: initialFileCount,
  shareLink,
  loading: initialLoading = false,
}: ShareDetailDialogProps) {
  const router = useRouter();
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([{ id: "0", name: "根目录" }]);
  const [currentList, setCurrentList] = useState<ShareFileItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Map<string, { name: string; isDir: boolean }>>(new Map());
  const [saving, setSaving] = useState(false);
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [showSaveToTask, setShowSaveToTask] = useState(false);
  const [showAddToLibrary, setShowAddToLibrary] = useState(false);

  const shareInfoData = shareInfo?.share_info as Record<string, unknown> | undefined;
  const title = (shareInfoData?.name ?? shareInfoData?.share_name ?? "115 分享") as string;
  const createTime =
    shareInfoData?.create_time != null
      ? new Date(Number(shareInfoData.create_time) * 1000).toLocaleString()
      : "";

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // 弹框打开时用根目录列表初始化；关闭时重置面包屑和列表
  useEffect(() => {
    if (open) {
      setBreadcrumb([{ id: "0", name: "根目录" }]);
      setCurrentList(initialFileList);
      setTotalCount(initialFileCount);
      setPage(1);
      setSelectedItems(new Map());
    }
  }, [open, initialFileList, initialFileCount]);

  const fetchList = async (cid: string, nextPage: number) => {
    if (!shareLink.trim()) return;
    setLoading(true);
    try {
      const res = await axiosInstance.post<{
        code: number;
        data?: { list: ShareFileItem[]; count: number };
      }>("/api/115/share", {
        action: "list",
        url: shareLink.trim(),
        cid,
        limit: PAGE_SIZE,
        offset: (nextPage - 1) * PAGE_SIZE,
      });
      if (res.data.code !== 200) {
        toast.error("加载目录失败");
        return;
      }
      setCurrentList(res.data.data?.list ?? []);
      setTotalCount(res.data.data?.count ?? 0);
      setPage(nextPage);
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
    fetchList(cid, 1);
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index === breadcrumb.length - 1) return;
    const item = breadcrumb[index];
    setBreadcrumb((prev) => prev.slice(0, index + 1));
    fetchList(item.id, 1);
  };

  const handlePageChange = (nextPage: number) => {
    if (nextPage < 1 || nextPage > totalPages || nextPage === page) return;
    const currentCid = breadcrumb[breadcrumb.length - 1].id;
    fetchList(currentCid, nextPage);
  };

  const toggleSelect = (item: ShareFileItem) => {
    const itemId = item.is_dir ? String(item.cid) : String(item.id);
    setSelectedItems((prev) => {
      const next = new Map(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.set(itemId, { name: item.name, isDir: item.is_dir });
      }
      return next;
    });
  };

  const handleOpenSaveToTask = () => {
    if (selectedItems.size === 0) {
      toast.error("请先选择要保存的文件");
      return;
    }
    setShowSaveToTask(true);
  };

  const handleOpenCustomDir = () => {
    if (selectedItems.size === 0) {
      toast.error("请先选择要保存的文件");
      return;
    }
    setShowDirPicker(true);
  };

  const handleTaskSaveChoice = async (choice: SaveToTaskChoice) => {
    setShowSaveToTask(false);
    setSaving(true);
    try {
      const items = Array.from(selectedItems.entries()).map(([, v]) => ({ name: v.name, isDir: v.isDir }));
      const res = await axiosInstance.post("/api/115/share", {
        action: "receive",
        url: shareLink.trim(),
        fileIds: Array.from(selectedItems.keys()),
        taskId: choice.taskId,
        subPath: choice.subPath,
        mode: choice.mode,
        selectedItems: items,
      });
      if (res.data.code === 200) {
        const data = res.data.data || {};
        if (data.mode === "async" && data.taskId) {
          const asyncTaskId = data.taskId as string;
          toast.success("已触发后台同步", {
            action: {
              label: "查看进度",
              onClick: () => router.push(`/log/${asyncTaskId}`),
            },
          });
        } else if (typeof data.generatedCount === "number") {
          toast.success(`保存成功，生成 ${data.generatedCount} 个 strm（跳过 ${data.skippedCount ?? 0} 个）`);
        } else {
          toast.success("保存成功");
        }
        setSelectedItems(new Map());
      } else {
        toast.error(res.data.message || "保存失败");
      }
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDirSelected = async (cid: number) => {
    setSaving(true);
    try {
      const res = await axiosInstance.post("/api/115/share", {
        action: "receive",
        url: shareLink.trim(),
        fileIds: Array.from(selectedItems.keys()),
        toPid: String(cid),
      });
      if (res.data.code === 200) {
        toast.success("保存成功");
        setSelectedItems(new Map());
      } else {
        toast.error(res.data.message || "保存失败");
      }
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "保存失败");
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
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <DialogTitle className="truncate">{title}</DialogTitle>
              {createTime && (
                <DialogDescription>创建时间：{createTime}</DialogDescription>
              )}
            </div>
            {shareLink.trim() && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowAddToLibrary(true)}
                className="shrink-0 mr-6"
              >
                <BookmarkPlus className="h-4 w-4 mr-1" />
                加入影库
              </Button>
            )}
          </div>
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
                  const isSelected = selectedItems.has(itemId);
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
        {totalCount > 0 && (
          <div className="flex items-center justify-between pt-2 text-sm text-muted-foreground">
            <span>
              共 {totalCount} 项 · 第 {page} / {totalPages} 页
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={() => handlePageChange(1)}
                disabled={loading || page <= 1}
                aria-label="首页"
              >
                <ChevronsLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={() => handlePageChange(page - 1)}
                disabled={loading || page <= 1}
                aria-label="上一页"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={() => handlePageChange(page + 1)}
                disabled={loading || page >= totalPages}
                aria-label="下一页"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={() => handlePageChange(totalPages)}
                disabled={loading || page >= totalPages}
                aria-label="末页"
              >
                <ChevronsRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
        {selectedItems.size > 0 && (
          <div className="flex items-center justify-between pt-4 border-t gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">
              已选择 {selectedItems.size} 项
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={handleOpenCustomDir} disabled={saving}>
                保存到自定义目录
              </Button>
              <Button onClick={handleOpenSaveToTask} disabled={saving}>
                <Download className="h-4 w-4 mr-2" />
                {saving ? "保存中..." : "保存到任务目录"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
      <DirectoryPickerDialog
        open={showDirPicker}
        onOpenChange={setShowDirPicker}
        onSelect={handleDirSelected}
      />
      <SaveToDriveDialog
        open={showSaveToTask}
        onOpenChange={setShowSaveToTask}
        onConfirm={handleTaskSaveChoice}
        selectedCount={selectedItems.size}
      />
      <AddToLibraryDialog
        open={showAddToLibrary}
        onOpenChange={setShowAddToLibrary}
        initial={buildLibraryInitial(shareLink, shareInfo, initialFileCount)}
        onSaved={() => setShowAddToLibrary(false)}
      />
    </Dialog>
  );
}

function buildLibraryInitial(
  shareLink: string,
  shareInfo: Record<string, unknown> | null,
  fileCount: number,
): AddToLibraryInitial | null {
  const url = shareLink.trim();
  if (!url) return null;
  const info = (shareInfo?.share_info ?? {}) as Record<string, unknown>;
  const title = (info.share_title ?? info.name ?? "") as string;
  return {
    shareUrl: url,
    title: title || "",
    coverUrl: "",
    tags: [],
    notes: fileCount ? `共 ${fileCount} 项` : "",
  };
}

"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import { toast } from "sonner";
import { api, type ShareFileItem } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { notifyFollowResult, notifySaveToTaskResult } from "@/lib/save-result";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DirectoryPickerDialog } from "@/components/DirectoryPickerDialog";
import { SaveToDriveDialog, type SaveToTaskChoice } from "@/components/SaveToDriveDialog";

export type { ShareFileItem } from "@/lib/api";

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
  startCid?: string | number;
  startCrumbs?: BreadcrumbItem[];
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
  startCid,
  startCrumbs,
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
  const [addingToLibrary, setAddingToLibrary] = useState(false);

  const shareInfoData = shareInfo?.share_info as Record<string, unknown> | undefined;
  const title = (shareInfoData?.name ?? shareInfoData?.share_name ?? "115 分享") as string;
  const createTime =
    shareInfoData?.create_time != null
      ? new Date(Number(shareInfoData.create_time) * 1000).toLocaleString()
      : "";

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // 定位用的面包屑按内容比较：每次 load 都传新数组，按引用比较会把弹框多初始化一次
  const startKey = useMemo(() => (startCrumbs ?? []).map((c) => `${c.id}:${c.name}`).join("/"), [startCrumbs]);
  const startCrumbsRef = useRef(startCrumbs);
  useEffect(() => {
    startCrumbsRef.current = startCrumbs;
  });
  // 连续进目录 / 翻页时只认最后一次请求，慢的旧响应不能盖掉新列表
  const seqRef = useRef(0);

  const fetchList = useCallback(
    async (cid: string, nextPage: number) => {
      const link = shareLink.trim();
      if (!link) return;
      const seq = ++seqRef.current;
      setLoading(true);
      try {
        const page = await api.share.list(link, cid, { limit: PAGE_SIZE, offset: (nextPage - 1) * PAGE_SIZE });
        if (seq !== seqRef.current) return;
        setCurrentList(page.list ?? []);
        setTotalCount(page.count ?? 0);
        setPage(nextPage);
      } catch {
        if (seq !== seqRef.current) return;
        toast.error("加载目录失败");
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [shareLink],
  );

  // 弹框打开时用根目录列表初始化；带 startCid 时直接拉那一层
  useEffect(() => {
    if (!open) return;
    setSelectedItems(new Map());
    setPage(1);
    const startCidStr = startCid != null ? String(startCid) : "";
    const crumbs = startCrumbsRef.current;
    if (startCidStr && startCidStr !== "0" && crumbs && crumbs.length > 0) {
      setBreadcrumb([{ id: "0", name: "根目录" }, ...crumbs]);
      setCurrentList([]);
      setTotalCount(0);
      fetchList(startCidStr, 1);
    } else {
      setBreadcrumb([{ id: "0", name: "根目录" }]);
      setCurrentList(initialFileList);
      setTotalCount(initialFileCount);
    }
  }, [open, initialFileList, initialFileCount, startCid, startKey, fetchList]);

  const handleOpenFolder = (item: ShareFileItem) => {
    if (!item.is_dir) return;
    const cid = String(item.cid);
    setBreadcrumb((prev) => [...prev, { id: cid, name: item.name }]);
    fetchList(cid, 1);
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index === breadcrumb.length - 1) return;
    const item = breadcrumb[index];
    if (!item.id) return;
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
      const current = breadcrumb[breadcrumb.length - 1];
      const watchPath = breadcrumb.slice(1).map((b) => b.name).join("/");
      const result = await api.share.receive({
        url: shareLink.trim(),
        fileIds: Array.from(selectedItems.keys()),
        taskId: choice.taskId,
        subPath: choice.subPath,
        mode: choice.mode,
        selectedItems: items,
        // 追更盯的是当前浏览的这一层目录
        ...(choice.follow
          ? { follow: choice.follow, cid: current.id, watchPath, name: watchPath ? `${title} / ${watchPath}` : title }
          : {}),
      });
      notifySaveToTaskResult(result, router);
      notifyFollowResult(choice, result);
      setSelectedItems(new Map());
    } catch (err) {
      toast.error(apiErrorMessage(err, "保存失败"));
    } finally {
      setSaving(false);
    }
  };

  const handleAddToLibrary = async () => {
    const url = shareLink.trim();
    if (!url) return;
    setAddingToLibrary(true);
    try {
      const selectedDirs: Array<{ cid: string; name: string }> = [];
      for (const [id, v] of selectedItems.entries()) {
        if (!v.isDir) continue;
        const t = id.trim();
        if (t && t !== "0") selectedDirs.push({ cid: t, name: v.name });
      }

      // 情况 1：勾选了子目录 — 每个子目录作为一条子目录条目入库
      if (selectedDirs.length > 0) {
        const parentSegments = breadcrumb.slice(1).map((b) => b.name);
        const results = await Promise.allSettled(
          selectedDirs.map((d) =>
            api.library.create({
              shareUrl: url,
              cid: d.cid,
              rawName: d.name,
              sharePath: [...parentSegments, d.name].join("/"),
            }),
          ),
        );
        let ok = 0;
        let dup = 0;
        let fail = 0;
        for (const r of results) {
          if (r.status === "fulfilled") {
            ok += 1;
          } else {
            const status = (r.reason as { response?: { status?: number } })?.response?.status;
            if (status === 409) dup += 1;
            else fail += 1;
          }
        }
        const parts: string[] = [];
        if (ok > 0) parts.push(`新增 ${ok} 条`);
        if (dup > 0) parts.push(`${dup} 条已在库`);
        if (fail > 0) parts.push(`${fail} 条失败`);
        const msg = parts.join("，");
        if (ok > 0) {
          toast.success(`${msg}，后台刮削中`);
          setSelectedItems(new Map());
        } else if (fail === 0) {
          toast.info(msg);
          setSelectedItems(new Map());
        } else {
          toast.error(msg);
        }
        return;
      }

      // 情况 2：按面包屑当前层级（根目录 → 后端自动判断合集/单片；子目录 → 入这一条）
      const atRoot = breadcrumb.length <= 1;
      const current = breadcrumb[breadcrumb.length - 1];
      const data = await api.library.create(
        atRoot
          ? { shareUrl: url }
          : {
              shareUrl: url,
              cid: current.id,
              rawName: current.name,
              sharePath: breadcrumb.slice(1).map((b) => b.name).join("/"),
              fileCount: totalCount,
            },
      );
      toast.success(`已加入影库：${data.entry.title || data.entry.rawName || data.entry.shareCode}`);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      toast.error(apiErrorMessage(err, status === 409 ? "该内容已在影库中" : "加入影库失败"));
    } finally {
      setAddingToLibrary(false);
    }
  };

  const handleDirSelected = async (cid: number) => {
    setSaving(true);
    try {
      await api.share.receive({ url: shareLink.trim(), fileIds: Array.from(selectedItems.keys()), toPid: String(cid) });
      toast.success("保存成功");
      setSelectedItems(new Map());
    } catch (err) {
      toast.error(apiErrorMessage(err, "保存失败"));
    } finally {
      setSaving(false);
    }
  };

  const displayList = open ? currentList : [];
  const isLoading = initialLoading || loading;
  const selectedValues = Array.from(selectedItems.values());
  const selectedDirCount = selectedValues.filter((v) => v.isDir).length;
  // 和后端 scopeFromSelection 一致：勾了文件（或没勾）追当前目录，只勾目录就只追那些目录
  const followScope =
    selectedValues.some((v) => !v.isDir) || selectedDirCount === 0
      ? `「${breadcrumb[breadcrumb.length - 1].name}」这一层`
      : selectedDirCount === 1
        ? `「${selectedValues.find((v) => v.isDir)?.name}」目录`
        : `勾选的 ${selectedDirCount} 个目录`;
  const followHint = `之后定期检查${followScope}里新增的文件，自动转存到同一位置并生成 strm；这次没勾的现有文件不会补转存。`;

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
              <div className="flex items-center gap-2 shrink-0 mr-6">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAddToLibrary}
                  disabled={addingToLibrary}
                  title={
                    selectedDirCount > 0
                      ? `加入选中的 ${selectedDirCount} 个文件夹`
                      : breadcrumb.length > 1
                        ? `加入「${breadcrumb[breadcrumb.length - 1].name}」`
                        : "自动判断合集/单片并入库"
                  }
                >
                  <BookmarkPlus className="h-4 w-4 mr-1" />
                  {addingToLibrary
                    ? "加入中..."
                    : selectedDirCount > 0
                      ? `加入影库（${selectedDirCount}）`
                      : "加入影库"}
                </Button>
              </div>
            )}
          </div>
        </DialogHeader>
        {/* 面包屑 */}
        <div className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
          {breadcrumb.map((item, index) => {
            const isLast = index === breadcrumb.length - 1;
            const isClickable = !isLast && Boolean(item.id);
            return (
              <span key={`${index}-${item.name}`} className="flex items-center gap-1">
                {index > 0 && <ChevronRight className="h-4 w-4 shrink-0" />}
                <button
                  type="button"
                  onClick={() => handleBreadcrumbClick(index)}
                  disabled={!isClickable}
                  className={`hover:text-foreground truncate max-w-[120px] ${isLast ? "font-medium text-foreground cursor-default" : isClickable ? "underline cursor-pointer" : "cursor-default"}`}
                  title={item.name}
                >
                  {item.name}
                </button>
              </span>
            );
          })}
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
        followHint={followHint}
      />
    </Dialog>
  );
}

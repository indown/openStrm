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
import { File, ChevronRight, FolderOpen, Download, ChevronLeft, BookmarkPlus } from "lucide-react";
import { toast } from "sonner";
import { api, type ShareEntry, type ShareInfo, type ShareReceiveItem } from "@/lib/api";
import { SHARE_PAGE_SIZE } from "@/hooks/use-share-detail";
import { apiErrorMessage } from "@/lib/axios";
import { notifyFollowResult, notifySaveToTaskResult } from "@/lib/save-result";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DirectoryPickerDialog } from "@/components/DirectoryPickerDialog";
import { SaveToDriveDialog, type SaveToTaskChoice } from "@/components/SaveToDriveDialog";

export type { ShareEntry } from "@/lib/api";

interface BreadcrumbItem {
  id: string;
  name: string;
}

interface ShareDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shareInfo: ShareInfo | null;
  fileList: ShareEntry[];
  fileCount: number;
  /** 根目录第一页之后还有没有：有就是下一页的游标 */
  nextCursor?: string;
  shareLink: string;
  loading?: boolean;
  startCid?: string | number;
  startCrumbs?: BreadcrumbItem[];
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
  fileCount: initialFileCount,
  nextCursor: initialNext,
  shareLink,
  loading: initialLoading = false,
  startCid,
  startCrumbs,
}: ShareDetailDialogProps) {
  const router = useRouter();
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([{ id: "0", name: "根目录" }]);
  const [currentList, setCurrentList] = useState<ShareEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  // 翻页靠游标：cursors[i] 是第 i+1 页的游标（第一页没有），next 是当前页之后那一页的
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Map<string, ShareReceiveItem>>(new Map());
  const [saving, setSaving] = useState(false);
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [showSaveToTask, setShowSaveToTask] = useState(false);
  const [addingToLibrary, setAddingToLibrary] = useState(false);

  const title = shareInfo?.title || "分享";
  const kindLabel = shareInfo?.kind === "quark" ? "夸克网盘" : shareInfo?.kind === "115" ? "115 网盘" : "";

  // 定位用的面包屑按内容比较：每次 load 都传新数组，按引用比较会把弹框多初始化一次
  const startKey = useMemo(() => (startCrumbs ?? []).map((c) => `${c.id}:${c.name}`).join("/"), [startCrumbs]);
  const startCrumbsRef = useRef(startCrumbs);
  useEffect(() => {
    startCrumbsRef.current = startCrumbs;
  });
  // 连续进目录 / 翻页时只认最后一次请求，慢的旧响应不能盖掉新列表
  const seqRef = useRef(0);

  const fetchList = useCallback(
    async (dirId: string, nextPage: number, cursor?: string, crumbs?: BreadcrumbItem[]): Promise<boolean> => {
      const link = shareLink.trim();
      if (!link) return false;
      const seq = ++seqRef.current;
      setLoading(true);
      try {
        const result = await api.share.list(link, dirId, cursor, SHARE_PAGE_SIZE);
        if (seq !== seqRef.current) return false;
        // 面包屑等目录真的拉到了再换：失败时列表还是原来那层，面包屑不能先跑到子目录去
        if (crumbs) setBreadcrumb(crumbs);
        setCurrentList(result.entries ?? []);
        setTotalCount(result.total ?? result.entries?.length ?? 0);
        setNext(result.next);
        setPage(nextPage);
        setCursors((prev) => {
          const copy = nextPage === 1 ? [undefined] : prev.slice(0, nextPage - 1);
          copy[nextPage - 1] = cursor;
          return copy;
        });
        return true;
      } catch (err) {
        if (seq !== seqRef.current) return false;
        toast.error(apiErrorMessage(err, "加载目录失败"));
        return false;
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [shareLink],
  );

  // 弹框打开时用根目录列表初始化；带 startCid 时直接拉那一层
  useEffect(() => {
    if (!open) return;
    // 上一次打开时还没回来的目录请求作废，别让它带着面包屑落到这次的分享上
    seqRef.current++;
    setSelectedItems(new Map());
    setPage(1);
    setCursors([undefined]);
    const startCidStr = startCid != null ? String(startCid) : "";
    const crumbs = startCrumbsRef.current;
    if (startCidStr && startCidStr !== "0" && crumbs && crumbs.length > 0) {
      setBreadcrumb([{ id: "0", name: "根目录" }, ...crumbs]);
      setCurrentList([]);
      setTotalCount(0);
      setNext(undefined);
      fetchList(startCidStr, 1);
    } else {
      setBreadcrumb([{ id: "0", name: "根目录" }]);
      setCurrentList(initialFileList);
      setTotalCount(initialFileCount);
      setNext(initialNext);
    }
  }, [open, initialFileList, initialFileCount, initialNext, startCid, startKey, fetchList]);

  /**
   * 勾选只对当前目录有效，换目录就清空。
   * 勾选项只记名字不记层级：后端按当前浏览的这一层拼 strm 路径，网盘的转存也是把每个 id 平铺复制进目标目录，
   * 父目录和它里面的条目一起提交只会得到重复和错位的文件。
   */
  const leaveFolder = () => {
    if (selectedItems.size === 0) return;
    setSelectedItems(new Map());
    toast.info("换了目录，之前的勾选已清空；勾选只对当前目录有效");
  };

  // 勾选等目录真的换成功了再清：加载失败时列表还是原来那层，勾选也该还在
  const handleOpenFolder = async (item: ShareEntry) => {
    if (!item.isDir) return;
    if (await fetchList(item.id, 1, undefined, [...breadcrumb, { id: item.id, name: item.name }])) leaveFolder();
  };

  const handleBreadcrumbClick = async (index: number) => {
    if (index === breadcrumb.length - 1) return;
    const item = breadcrumb[index];
    if (!item.id) return;
    if (await fetchList(item.id, 1, undefined, breadcrumb.slice(0, index + 1))) leaveFolder();
  };

  const currentDirId = breadcrumb[breadcrumb.length - 1].id;
  const handlePrevPage = () => {
    if (loading || page <= 1) return;
    fetchList(currentDirId, page - 1, cursors[page - 2]);
  };
  const handleNextPage = () => {
    if (loading || !next) return;
    fetchList(currentDirId, page + 1, next);
  };

  const toggleSelect = (item: ShareEntry) => {
    setSelectedItems((prev) => {
      const copy = new Map(prev);
      if (copy.has(item.id)) {
        copy.delete(item.id);
      } else {
        copy.set(item.id, { id: item.id, name: item.name, isDir: item.isDir, token: item.token });
      }
      return copy;
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
      const items = Array.from(selectedItems.values());
      const current = breadcrumb[breadcrumb.length - 1];
      const watchPath = breadcrumb.slice(1).map((b) => b.name).join("/");
      const result = await api.share.receive({
        url: shareLink.trim(),
        items,
        taskId: choice.taskId,
        subPath: choice.subPath,
        mode: choice.mode,
        // 追更盯的是当前浏览的这一层目录
        ...(choice.follow
          ? { follow: choice.follow, watchDirId: current.id, watchPath, name: watchPath ? `${title} / ${watchPath}` : title }
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
      await api.share.receive({ url: shareLink.trim(), items: Array.from(selectedItems.values()), toDirId: String(cid) });
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
              {kindLabel && <DialogDescription>{kindLabel}的分享{shareInfo?.account ? `，用账号「${shareInfo.account}」打开` : ""}</DialogDescription>}
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
                  const isSelected = selectedItems.has(item.id);
                  return (
                    <TableRow key={item.id}>
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
                        {item.isDir ? (
                          <FolderOpen className="h-4 w-4 text-warning" />
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
                        {item.isDir ? "-" : formatSize(item.size)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.isDir ? "文件夹" : "文件"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
        {(totalCount > 0 || page > 1 || next) && (
          <div className="flex items-center justify-between pt-2 text-sm text-muted-foreground">
            <span className="tabular-nums">
              {totalCount > 0 ? `共 ${totalCount} 项 · ` : ""}第 {page} 页
            </span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="h-7 w-7" onClick={handlePrevPage} disabled={loading || page <= 1} aria-label="上一页">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" className="h-7 w-7" onClick={handleNextPage} disabled={loading || !next} aria-label="下一页">
                <ChevronRight className="h-4 w-4" />
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
              {/* 「保存到自定义目录」走 115 的目录接口，夸克的分享只能存到任务目录 */}
              {shareInfo?.kind === "115" && (
                <Button variant="outline" onClick={handleOpenCustomDir} disabled={saving}>
                  保存到自定义目录
                </Button>
              )}
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
        kind={shareInfo?.kind}
      />
    </Dialog>
  );
}

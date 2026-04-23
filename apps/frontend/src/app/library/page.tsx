"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Film, Edit, Trash2, Search, FileText, Loader2, AlertCircle, CloudUpload } from "lucide-react";
import { useRouter } from "next/navigation";
import axiosInstance from "@/lib/axios";
import { toast } from "sonner";
import type { MediaLibraryEntry } from "@openstrm/shared";
import { ShareDetailDialog, type ShareFileItem } from "@/components/ShareDetailDialog";
import { AddToLibraryDialog, type AddToLibraryInitial } from "@/components/AddToLibraryDialog";
import { SaveToDriveDialog, type SaveToTaskChoice } from "@/components/SaveToDriveDialog";

export default function LibraryPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<MediaLibraryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const [editing, setEditing] = useState<AddToLibraryInitial | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MediaLibraryEntry | null>(null);

  const [saveToTaskEntry, setSaveToTaskEntry] = useState<MediaLibraryEntry | null>(null);
  const [saveToTaskOpen, setSaveToTaskOpen] = useState(false);
  const [savingToTask, setSavingToTask] = useState(false);

  const [shareDetailOpen, setShareDetailOpen] = useState(false);
  const [shareInfo, setShareInfo] = useState<Record<string, unknown> | null>(null);
  const [shareFileList, setShareFileList] = useState<ShareFileItem[]>([]);
  const [shareFileCount, setShareFileCount] = useState(0);
  const [shareLink, setShareLink] = useState("");
  const [shareLoading, setShareLoading] = useState(false);
  const [shareStartCid, setShareStartCid] = useState<string | number | undefined>(undefined);
  const [shareStartCrumbs, setShareStartCrumbs] = useState<{ id: string; name: string }[] | undefined>(undefined);

  const fetchEntries = async () => {
    setLoading(true);
    try {
      const res = await axiosInstance.get<MediaLibraryEntry[]>("/api/library");
      setEntries(Array.isArray(res.data) ? res.data : []);
    } catch {
      toast.error("加载影库失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEntries();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inField =
        tag === "INPUT" || tag === "TEXTAREA" || (target?.isContentEditable ?? false);
      if (e.key === "/" && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape" && document.activeElement === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const hasPending = entries.some((e) => e.scrapeStatus === "pending");
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  });
  useEffect(() => {
    if (!hasPending) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await axiosInstance.get<{
          code: number;
          data?: { pendingIds: string[]; pendingCount: number };
        }>("/api/library/scrape-status");
        if (cancelled) return;
        const currentPending = new Set(
          entriesRef.current.filter((e) => e.scrapeStatus === "pending").map((e) => e.id),
        );
        const serverPending = new Set(res.data.data?.pendingIds ?? []);
        let changed = currentPending.size !== serverPending.size;
        if (!changed) {
          for (const id of currentPending) {
            if (!serverPending.has(id)) {
              changed = true;
              break;
            }
          }
        }
        if (changed) fetchEntries();
      } catch {
        // transient; ignore
      }
    };
    const interval = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [hasPending]);

  const filtered = query.trim()
    ? entries.filter((e) => {
        const q = query.trim().toLowerCase();
        const bag = [
          e.title,
          e.rawName,
          e.sharePath,
          e.notes,
          e.year,
          e.shareCode,
          ...(e.tags ?? []),
        ]
          .filter(Boolean)
          .map((s) => String(s).toLowerCase());
        return bag.some((v) => v.includes(q));
      })
    : entries;

  const openEntry = async (entry: MediaLibraryEntry) => {
    setShareLink(entry.shareUrl);
    setShareLoading(true);
    setShareDetailOpen(true);
    setShareInfo(null);
    setShareFileList([]);
    setShareFileCount(0);
    if (entry.shareRootCid && entry.shareRootCid !== "0") {
      setShareStartCid(entry.shareRootCid);
      const segments = (entry.sharePath || "")
        .replace(/^\/+/, "")
        .split("/")
        .filter(Boolean);
      const crumbs =
        segments.length > 0
          ? segments.map((name, i) => ({
              id: i === segments.length - 1 ? entry.shareRootCid : "",
              name,
            }))
          : [{ id: entry.shareRootCid, name: entry.title || entry.rawName || "子目录" }];
      setShareStartCrumbs(crumbs);
    } else {
      setShareStartCid(undefined);
      setShareStartCrumbs(undefined);
    }
    try {
      const [infoRes, listRes] = await Promise.all([
        axiosInstance.post<{ code: number; data?: Record<string, unknown> }>("/api/115/share", {
          action: "info",
          url: entry.shareUrl,
        }),
        axiosInstance.post<{ code: number; data?: { list: ShareFileItem[]; count: number } }>("/api/115/share", {
          action: "list",
          url: entry.shareUrl,
          cid: 0,
        }),
      ]);
      if (infoRes.data.code !== 200 || listRes.data.code !== 200) {
        toast.error(infoRes.data.code !== 200 ? "获取分享信息失败" : "获取文件列表失败");
        setShareDetailOpen(false);
        return;
      }
      setShareInfo(infoRes.data.data ?? null);
      setShareFileList(listRes.data.data?.list ?? []);
      setShareFileCount(listRes.data.data?.count ?? 0);
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "打开分享失败");
      setShareDetailOpen(false);
    } finally {
      setShareLoading(false);
    }
  };

  const openEditor = (entry: MediaLibraryEntry) => {
    setEditing({
      id: entry.id,
      shareUrl: entry.shareUrl,
      title: entry.title,
      coverUrl: entry.coverUrl,
      tags: entry.tags,
      notes: entry.notes,
      scrapeStatus: entry.scrapeStatus,
    });
    setEditorOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await axiosInstance.delete(`/api/library/${deleteTarget.id}`);
      toast.success("已删除");
      setEntries((prev) => prev.filter((e) => e.id !== deleteTarget.id));
    } catch {
      toast.error("删除失败");
    } finally {
      setDeleteTarget(null);
    }
  };

  const openSaveToTask = (entry: MediaLibraryEntry) => {
    setSaveToTaskEntry(entry);
    setSaveToTaskOpen(true);
  };

  const handleSaveToTaskChoice = async (choice: SaveToTaskChoice) => {
    if (!saveToTaskEntry) return;
    setSaveToTaskOpen(false);
    setSavingToTask(true);
    try {
      const res = await axiosInstance.post<{ code: number; data?: Record<string, unknown>; message?: string }>(
        `/api/library/${saveToTaskEntry.id}/save-to-task`,
        { taskId: choice.taskId, subPath: choice.subPath, mode: choice.mode },
      );
      if (res.data.code !== 200) {
        toast.error(res.data.message || "保存失败");
        return;
      }
      const data = res.data.data ?? {};
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
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "保存失败");
    } finally {
      setSavingToTask(false);
      setSaveToTaskEntry(null);
    }
  };

  const handleSaved = (entry: MediaLibraryEntry) => {
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === entry.id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = entry;
        return next;
      }
      return [entry, ...prev];
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold">影库</h1>
        <div className="flex items-center gap-2 min-w-[240px]">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            ref={searchRef}
            placeholder="搜索标题、原名、路径、标签、备注、年份…  按 / 聚焦"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 text-sm"
          />
        </div>
      </div>

      {loading ? (
        <div className="text-muted-foreground p-8 text-center">加载中...</div>
      ) : filtered.length === 0 ? (
        <div className="text-muted-foreground p-8 text-center border rounded-md">
          {entries.length === 0
            ? "影库为空，从分享详情中点击「加入影库」或「批量入库」开始收藏。"
            : "没有匹配的结果。"}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((entry) => (
            <LibraryCard
              key={entry.id}
              entry={entry}
              savingToTask={savingToTask && saveToTaskEntry?.id === entry.id}
              onOpen={() => openEntry(entry)}
              onEdit={() => openEditor(entry)}
              onSaveToTask={() => openSaveToTask(entry)}
              onDelete={() => setDeleteTarget(entry)}
            />
          ))}
        </div>
      )}

      <AddToLibraryDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        initial={editing}
        onSaved={handleSaved}
        onBulkSaved={fetchEntries}
      />

      <ShareDetailDialog
        open={shareDetailOpen}
        onOpenChange={setShareDetailOpen}
        shareInfo={shareInfo}
        fileList={shareFileList}
        fileCount={shareFileCount}
        shareLink={shareLink}
        loading={shareLoading}
        startCid={shareStartCid}
        startCrumbs={shareStartCrumbs}
      />

      <SaveToDriveDialog
        open={saveToTaskOpen}
        onOpenChange={(open) => {
          setSaveToTaskOpen(open);
          if (!open && !savingToTask) setSaveToTaskEntry(null);
        }}
        onConfirm={handleSaveToTaskChoice}
        selectedCount={1}
      />

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              确定要从影库中移除 {deleteTarget?.title || deleteTarget?.shareCode} 吗？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="destructive" onClick={confirmDelete}>删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface LibraryCardProps {
  entry: MediaLibraryEntry;
  savingToTask: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onSaveToTask: () => void;
  onDelete: () => void;
}

function LibraryCard({ entry, savingToTask, onOpen, onEdit, onSaveToTask, onDelete }: LibraryCardProps) {
  const label = entry.title || entry.rawName || entry.shareCode;
  const pathLabel = entry.sharePath ? entry.sharePath.replace(/^\//, "") : "整个分享";
  const pending = entry.scrapeStatus === "pending";
  const failed = entry.scrapeStatus === "failed";

  return (
    <div className="group relative rounded-lg border bg-card overflow-hidden flex flex-col hover:shadow-md transition-shadow">
      <button
        type="button"
        onClick={onOpen}
        className="relative aspect-[2/3] bg-gradient-to-br from-muted to-muted/60 block w-full"
        title={label}
      >
        {entry.coverUrl ? (
          <Image
            src={entry.coverUrl}
            alt={label}
            fill
            className="object-cover"
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
            unoptimized
          />
        ) : (
          <div className="flex items-center justify-center w-full h-full text-muted-foreground">
            <Film className="h-10 w-10" />
          </div>
        )}
        {pending && (
          <div className="absolute top-2 left-2 bg-background/80 rounded px-1.5 py-0.5 flex items-center gap-1 text-[10px]">
            <Loader2 className="h-3 w-3 animate-spin" />
            刮削中
          </div>
        )}
        {failed && (
          <div className="absolute top-2 left-2 bg-red-100 text-red-700 rounded px-1.5 py-0.5 flex items-center gap-1 text-[10px]">
            <AlertCircle className="h-3 w-3" />
            未匹配
          </div>
        )}
        {entry.year && (
          <Badge variant="secondary" className="absolute top-2 right-2 text-[10px]">
            {entry.year}
          </Badge>
        )}
        {entry.fileCount > 0 && (
          <Badge
            variant="secondary"
            className="absolute bottom-2 right-2 text-[10px]"
          >
            <FileText className="h-3 w-3 mr-1" />
            {entry.fileCount}
          </Badge>
        )}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity text-white text-xs">
          点击打开分享
        </div>
      </button>

      <div className="p-2 space-y-1 flex-1 flex flex-col">
        <button
          type="button"
          onClick={onOpen}
          className="text-sm font-medium line-clamp-2 text-left hover:underline"
          title={label}
        >
          {label}
        </button>
        <div className="text-[11px] text-muted-foreground truncate" title={pathLabel}>
          {pathLabel}
        </div>
        {entry.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {entry.tags.slice(0, 4).map((tag) => (
              <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">
                {tag}
              </Badge>
            ))}
          </div>
        )}
        <div className="mt-auto flex items-center justify-end gap-1 pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onSaveToTask}
            disabled={savingToTask}
            title="保存到任务目录并生成 strm"
          >
            {savingToTask ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CloudUpload className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onEdit}
            title="编辑"
          >
            <Edit className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
            onClick={onDelete}
            title="删除"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

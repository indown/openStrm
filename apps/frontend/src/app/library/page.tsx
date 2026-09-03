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
import { StatusBadge } from "@/components/status-badge";
import { Film, Edit, Trash2, Search, FileText, Loader2, AlertCircle, CloudUpload } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { MediaLibraryEntry, ShareFollowSummary } from "@openstrm/shared";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { notifyFollowResult, notifySaveToTaskResult } from "@/lib/save-result";
import { useShareDetail } from "@/hooks/use-share-detail";
import { ShareDetailDialog } from "@/components/ShareDetailDialog";
import { AddToLibraryDialog, type AddToLibraryInitial } from "@/components/AddToLibraryDialog";
import { SaveToDriveDialog, type SaveToTaskChoice } from "@/components/SaveToDriveDialog";

export default function LibraryPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<MediaLibraryEntry[]>([]);
  // 只有首次加载显示"加载中"；之后的刷新（含刮削轮询触发的）不把已有卡片清掉
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const [editing, setEditing] = useState<AddToLibraryInitial | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MediaLibraryEntry | null>(null);

  const [follows, setFollows] = useState<ShareFollowSummary[]>([]);
  const [saveToTaskEntry, setSaveToTaskEntry] = useState<MediaLibraryEntry | null>(null);
  const [saveToTaskOpen, setSaveToTaskOpen] = useState(false);
  const [savingToTask, setSavingToTask] = useState(false);

  const share = useShareDetail();

  const fetchEntries = async () => {
    try {
      const list = await api.library.list();
      setEntries(Array.isArray(list) ? list : []);
    } catch (err) {
      toast.error(apiErrorMessage(err, "加载影库失败"));
    } finally {
      setLoaded(true);
    }
  };

  const fetchFollows = async () => {
    try {
      setFollows((await api.follow.list()).follows);
    } catch {
      // 追更列表拿不到不影响影库本身
    }
  };

  useEffect(() => {
    fetchEntries();
    void fetchFollows();
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
        const status = await api.library.scrapeStatus();
        if (cancelled) return;
        const currentPending = new Set(
          entriesRef.current.filter((e) => e.scrapeStatus === "pending").map((e) => e.id),
        );
        const serverPending = new Set(status.pendingIds ?? []);
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

  // 卡片上的「追更中」徽标：按 (shareCode, 被盯目录) 对上号
  const followedKeys = new Set(follows.map((f) => `${f.shareCode}:${f.watchCid}`));
  const followKeyOf = (entry: MediaLibraryEntry) =>
    `${entry.shareCode}:${entry.shareRootCid && entry.shareRootCid !== "0" ? entry.shareRootCid : "0"}`;

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

  const openEntry = (entry: MediaLibraryEntry) => {
    // 子目录条目：直接定位到入库时记的那一层
    const isSubdir = Boolean(entry.shareRootCid && entry.shareRootCid !== "0");
    const segments = (entry.sharePath || "").replace(/^\/+/, "").split("/").filter(Boolean);
    const startCrumbs = !isSubdir
      ? undefined
      : segments.length > 0
        ? segments.map((name, i) => ({ id: i === segments.length - 1 ? entry.shareRootCid : "", name }))
        : [{ id: entry.shareRootCid, name: entry.title || entry.rawName || "子目录" }];
    void share.load(entry.shareUrl, {
      openImmediately: true,
      startCid: isSubdir ? entry.shareRootCid : undefined,
      startCrumbs,
      failMessage: "打开分享失败",
    });
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
      await api.library.remove(deleteTarget.id);
      toast.success("已删除");
      setEntries((prev) => prev.filter((e) => e.id !== deleteTarget.id));
    } catch (err) {
      toast.error(apiErrorMessage(err, "删除失败"));
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
      const result = await api.library.saveToTask(saveToTaskEntry.id, choice);
      notifySaveToTaskResult(result, router);
      notifyFollowResult(choice, result);
      if (choice.follow) void fetchFollows();
    } catch (err) {
      toast.error(apiErrorMessage(err, "保存失败"));
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

      {!loaded ? (
        <div className="text-muted-foreground p-8 text-center">加载中...</div>
      ) : filtered.length === 0 ? (
        <div className="text-muted-foreground p-8 text-center border rounded-md">
          {entries.length === 0
            ? "影库为空，从分享详情中点击「加入影库」开始收藏。"
            : "没有匹配的结果。"}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((entry) => (
            <LibraryCard
              key={entry.id}
              entry={entry}
              followed={followedKeys.has(followKeyOf(entry))}
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
      />

      <ShareDetailDialog {...share.dialogProps} />

      <SaveToDriveDialog
        open={saveToTaskOpen}
        onOpenChange={(open) => {
          setSaveToTaskOpen(open);
          if (!open && !savingToTask) setSaveToTaskEntry(null);
        }}
        onConfirm={handleSaveToTaskChoice}
        selectedCount={1}
        followHint={`之后定期检查「${saveToTaskEntry?.title || saveToTaskEntry?.rawName || "该分享"}」对应的分享目录里新增的文件，自动转存到同一位置并生成 strm。`}
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
  followed: boolean;
  savingToTask: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onSaveToTask: () => void;
  onDelete: () => void;
}

function LibraryCard({ entry, followed, savingToTask, onOpen, onEdit, onSaveToTask, onDelete }: LibraryCardProps) {
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
          <div className="absolute top-2 left-2 bg-background/80 rounded px-1.5 py-0.5 flex items-center gap-1 text-xs">
            <Loader2 className="h-3 w-3 animate-spin" />
            刮削中
          </div>
        )}
        {failed && (
          <StatusBadge tone="danger" className="absolute top-2 left-2 backdrop-blur-sm">
            <AlertCircle />
            未匹配
          </StatusBadge>
        )}
        {entry.year && (
          <Badge variant="secondary" className="absolute top-2 right-2 text-xs">
            {entry.year}
          </Badge>
        )}
        {followed && (
          <Badge className="absolute bottom-2 left-2 text-xs" variant="default">
            追更中
          </Badge>
        )}
        {entry.fileCount > 0 && (
          <Badge
            variant="secondary"
            className="absolute bottom-2 right-2 text-xs"
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
        <div className="text-xs text-muted-foreground truncate" title={pathLabel}>
          {pathLabel}
        </div>
        {entry.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {entry.tags.slice(0, 4).map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs px-1.5 py-0">
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
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
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

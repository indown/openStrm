"use client";

import { useEffect, useState } from "react";
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
import { Film, Edit, Trash2, Search, FileText } from "lucide-react";
import axiosInstance from "@/lib/axios";
import { toast } from "sonner";
import type { MediaLibraryEntry } from "@openstrm/shared";
import { ShareDetailDialog, type ShareFileItem } from "@/components/ShareDetailDialog";
import { AddToLibraryDialog, type AddToLibraryInitial } from "@/components/AddToLibraryDialog";

export default function LibraryPage() {
  const [entries, setEntries] = useState<MediaLibraryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const [editing, setEditing] = useState<AddToLibraryInitial | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MediaLibraryEntry | null>(null);

  const [shareDetailOpen, setShareDetailOpen] = useState(false);
  const [shareInfo, setShareInfo] = useState<Record<string, unknown> | null>(null);
  const [shareFileList, setShareFileList] = useState<ShareFileItem[]>([]);
  const [shareFileCount, setShareFileCount] = useState(0);
  const [shareLink, setShareLink] = useState("");
  const [shareLoading, setShareLoading] = useState(false);

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

  const filtered = query.trim()
    ? entries.filter((e) => {
        const q = query.trim().toLowerCase();
        return (
          e.title.toLowerCase().includes(q) ||
          e.shareCode.toLowerCase().includes(q) ||
          e.notes.toLowerCase().includes(q) ||
          e.tags.some((t) => t.toLowerCase().includes(q))
        );
      })
    : entries;

  const openEntry = async (entry: MediaLibraryEntry) => {
    setShareLink(entry.shareUrl);
    setShareLoading(true);
    setShareDetailOpen(true);
    setShareInfo(null);
    setShareFileList([]);
    setShareFileCount(0);
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
            placeholder="搜索标题、标签、备注…"
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
            ? "影库为空，从分享详情中点击「加入影库」开始收藏。"
            : "没有匹配的结果。"}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((entry) => (
            <LibraryCard
              key={entry.id}
              entry={entry}
              onOpen={() => openEntry(entry)}
              onEdit={() => openEditor(entry)}
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

      <ShareDetailDialog
        open={shareDetailOpen}
        onOpenChange={setShareDetailOpen}
        shareInfo={shareInfo}
        fileList={shareFileList}
        fileCount={shareFileCount}
        shareLink={shareLink}
        loading={shareLoading}
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
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function LibraryCard({ entry, onOpen, onEdit, onDelete }: LibraryCardProps) {
  const label = entry.title || entry.shareCode;

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
        {entry.fileCount > 0 && (
          <Badge variant="secondary" className="absolute top-2 right-2 text-[10px]">
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

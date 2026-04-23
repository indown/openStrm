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
import { Textarea } from "@/components/ui/textarea";
import { Search, Film, RefreshCw } from "lucide-react";
import axiosInstance from "@/lib/axios";
import { toast } from "sonner";
import type { MediaLibraryEntry, ScrapeStatus } from "@openstrm/shared";

export interface AddToLibraryInitial {
  id?: string;
  shareUrl: string;
  title?: string;
  coverUrl?: string;
  tags?: string[];
  notes?: string;
  scrapeStatus?: ScrapeStatus;
}

interface AddToLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: AddToLibraryInitial | null;
  onSaved: (entry: MediaLibraryEntry) => void;
  onBulkSaved?: () => void;
}

export type AddResponse =
  | { mode: "single"; entry: MediaLibraryEntry }
  | { mode: "split"; inserted: number; skipped: number }
  | { mode: "subdir"; entry: MediaLibraryEntry };

interface TmdbSearchResult {
  id: number;
  mediaType: string;
  title: string;
  year: string;
  posterUrl: string;
  overview: string;
}

function splitTags(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

export function AddToLibraryDialog({ open, onOpenChange, initial, onSaved, onBulkSaved }: AddToLibraryDialogProps) {
  const [title, setTitle] = useState("");
  const [coverUrl, setCoverUrl] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const [tmdbEnabled, setTmdbEnabled] = useState(false);
  const [tmdbQuery, setTmdbQuery] = useState("");
  const [tmdbLoading, setTmdbLoading] = useState(false);
  const [tmdbResults, setTmdbResults] = useState<TmdbSearchResult[]>([]);
  const [rescraping, setRescraping] = useState(false);

  const isEdit = Boolean(initial?.id);

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? "");
    setCoverUrl(initial?.coverUrl ?? "");
    setTagsInput((initial?.tags ?? []).join(", "));
    setNotes(initial?.notes ?? "");
    setTmdbQuery(initial?.title ?? "");
    setTmdbResults([]);
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    axiosInstance
      .get<{ tmdb?: { apiKey?: string } } | Record<string, unknown>>("/api/settings")
      .then((res) => {
        if (cancelled) return;
        const data = res.data as { tmdb?: { apiKey?: string } };
        setTmdbEnabled(Boolean(data?.tmdb?.apiKey?.trim()));
      })
      .catch(() => setTmdbEnabled(false));
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleTmdbSearch = async () => {
    const q = tmdbQuery.trim();
    if (!q) {
      toast.error("请输入搜索关键词");
      return;
    }
    setTmdbLoading(true);
    try {
      const res = await axiosInstance.post<{ code: number; data?: TmdbSearchResult[]; message?: string }>(
        "/api/library/tmdb/search",
        { query: q },
      );
      if (res.data.code !== 200) {
        toast.error(res.data.message || "TMDB 搜索失败");
        return;
      }
      setTmdbResults(res.data.data ?? []);
      if ((res.data.data ?? []).length === 0) {
        toast.info("没有找到相关结果");
      }
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "TMDB 搜索失败");
    } finally {
      setTmdbLoading(false);
    }
  };

  const pickTmdb = (item: TmdbSearchResult) => {
    const label = item.year ? `${item.title} (${item.year})` : item.title;
    setTitle(label);
    if (item.posterUrl) setCoverUrl(item.posterUrl);
  };

  const handleRescrape = async () => {
    if (!initial?.id) return;
    if (!tmdbEnabled) {
      toast.error("TMDB 未配置，请先在设置中填入 API Key");
      return;
    }
    setRescraping(true);
    try {
      const res = await axiosInstance.post<{ code: number; data?: { id: string; status: string }; message?: string }>(
        `/api/library/${initial.id}/scrape`,
      );
      if (res.data.code !== 200) {
        toast.error(res.data.message || "触发重新刮削失败");
        return;
      }
      toast.success("已加入刮削队列，稍后刷新查看");
      onOpenChange(false);
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "触发重新刮削失败");
    } finally {
      setRescraping(false);
    }
  };

  const handleConfirm = async () => {
    if (!initial) return;
    setSaving(true);
    try {
      const payload = {
        shareUrl: initial.shareUrl,
        title: title.trim(),
        coverUrl: coverUrl.trim(),
        tags: splitTags(tagsInput),
        notes: notes.trim(),
      };
      if (isEdit && initial.id) {
        const res = await axiosInstance.put<MediaLibraryEntry>(`/api/library/${initial.id}`, payload);
        onSaved(res.data);
        toast.success("已更新");
        onOpenChange(false);
        return;
      }
      const res = await axiosInstance.post<AddResponse>("/api/library", payload);
      if (res.data.mode === "split") {
        const { inserted, skipped } = res.data;
        if (inserted === 0 && skipped > 0) {
          toast.info(`全部 ${skipped} 条已在库`);
        } else if (skipped > 0) {
          toast.success(`已自动拆分为 ${inserted} 条，后台刮削中（跳过 ${skipped} 条已在库）`);
        } else {
          toast.success(`已自动拆分为 ${inserted} 条，后台刮削中`);
        }
        onBulkSaved?.();
        onOpenChange(false);
      } else {
        onSaved(res.data.entry);
        toast.success("已加入影库");
        onOpenChange(false);
      }
    } catch (err) {
      const anyErr = err as { response?: { status?: number; data?: { message?: string; data?: MediaLibraryEntry } } };
      if (anyErr.response?.status === 409) {
        toast.error(anyErr.response.data?.message || "该分享已在影库中");
        if (anyErr.response.data?.data) onSaved(anyErr.response.data.data);
        onOpenChange(false);
      } else {
        toast.error(anyErr.response?.data?.message || "保存失败");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑影库条目" : "加入影库"}</DialogTitle>
          <DialogDescription className="truncate">{initial?.shareUrl}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto space-y-4">
          {tmdbEnabled && (
            <div className="space-y-2 rounded-md border p-3 bg-muted/30">
              <div className="text-sm font-medium">从 TMDB 搜索</div>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="影片名称"
                  value={tmdbQuery}
                  onChange={(e) => setTmdbQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleTmdbSearch()}
                  className="h-8"
                />
                <Button size="sm" onClick={handleTmdbSearch} disabled={tmdbLoading}>
                  <Search className="h-4 w-4 mr-1" />
                  {tmdbLoading ? "搜索中..." : "搜索"}
                </Button>
              </div>
              {tmdbResults.length > 0 && (
                <div className="grid grid-cols-5 gap-2">
                  {tmdbResults.slice(0, 10).map((item) => (
                    <button
                      type="button"
                      key={`${item.mediaType}-${item.id}`}
                      onClick={() => pickTmdb(item)}
                      className="group text-left rounded-md border overflow-hidden hover:ring-2 hover:ring-primary transition"
                      title={item.overview || item.title}
                    >
                      <div className="relative aspect-[2/3] bg-muted">
                        {item.posterUrl ? (
                          <Image src={item.posterUrl} alt={item.title} fill className="object-cover" unoptimized />
                        ) : (
                          <div className="flex items-center justify-center w-full h-full text-muted-foreground">
                            <Film className="h-6 w-6" />
                          </div>
                        )}
                      </div>
                      <div className="p-1 text-[11px] leading-tight truncate">{item.title}</div>
                      {item.year && <div className="px-1 pb-1 text-[10px] text-muted-foreground">{item.year}</div>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-1">
            <label className="text-sm font-medium">标题</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="留空将使用分享码" />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">封面 URL</label>
            <Input
              value={coverUrl}
              onChange={(e) => setCoverUrl(e.target.value)}
              placeholder="https://..."
            />
            {coverUrl && (
              <div className="relative w-24 aspect-[2/3] mt-2 rounded overflow-hidden border bg-muted">
                <Image src={coverUrl} alt="cover" fill className="object-cover" unoptimized />
              </div>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">标签</label>
            <Input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="用逗号分隔，如：动作, 2024"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">备注</label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="可选"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row sm:justify-between gap-2">
          {isEdit ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRescrape}
              disabled={rescraping || saving || !tmdbEnabled}
              title={tmdbEnabled ? "触发 TMDB 重新刮削" : "TMDB 未配置，请先去设置页填入 API Key"}
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${rescraping ? "animate-spin" : ""}`} />
              重新刮削
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={handleConfirm} disabled={saving || !initial}>
              {saving ? "保存中..." : isEdit ? "保存修改" : "加入影库"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

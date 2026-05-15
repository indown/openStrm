"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Film, Tv, Lock, CheckCircle2 } from "lucide-react";

export interface HdhiveTmdbItem {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  year: string;
  posterUrl: string;
  overview: string;
}

export interface HdhiveResourceItem {
  slug: string;
  title: string | null;
  pan_type: string | null;
  share_size: string | null;
  video_resolution: string[];
  source: string[];
  subtitle_language: string[];
  subtitle_type: string[];
  unlock_points: number | null;
  is_unlocked: boolean;
  user: Record<string, unknown> | null;
  remark?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  query: string;
  tmdb: HdhiveTmdbItem | null;
  alternatives: HdhiveTmdbItem[];
  resources: HdhiveResourceItem[];
  total: number;
  errorMessage?: string | null;
  onPickAlternative: (item: HdhiveTmdbItem) => void;
}

function MediaTypeBadge({ type }: { type: "movie" | "tv" }) {
  const Icon = type === "movie" ? Film : Tv;
  return (
    <Badge variant="outline" className="gap-1 text-[10px]">
      <Icon className="h-3 w-3" />
      {type === "movie" ? "电影" : "剧集"}
    </Badge>
  );
}

const UNKNOWN_PAN_TYPE = "其他";
const ALL_TAB = "__all__";

function panTypeOf(resource: HdhiveResourceItem): string {
  const raw = (resource.pan_type ?? "").toString().trim();
  return raw || UNKNOWN_PAN_TYPE;
}

function ResourceCard({ res }: { res: HdhiveResourceItem }) {
  const remark = (res.remark ?? "").toString().trim();
  return (
    <div className="break-inside-avoid mb-3 border rounded-md p-3 flex flex-col gap-1.5 bg-card hover:bg-muted/40 transition-colors">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-sm break-words">
          {res.title || "资源"}
        </span>
        {res.share_size && (
          <Badge variant="outline" className="text-[10px]">{res.share_size}</Badge>
        )}
        {res.is_unlocked ? (
          <Badge className="bg-green-100 text-green-700 hover:bg-green-100 text-[10px] gap-1">
            <CheckCircle2 className="h-3 w-3" />
            已解锁
          </Badge>
        ) : res.unlock_points != null && res.unlock_points > 0 ? (
          <Badge variant="outline" className="text-[10px] gap-1">
            <Lock className="h-3 w-3" />
            {res.unlock_points} 积分
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">免费</Badge>
        )}
      </div>
      {remark && (
        <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
          {remark}
        </div>
      )}
      <div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
        {res.video_resolution?.map((r) => (
          <span key={`r-${r}`} className="px-1.5 py-0.5 rounded bg-muted">{r}</span>
        ))}
        {res.source?.map((s) => (
          <span key={`s-${s}`} className="px-1.5 py-0.5 rounded bg-muted">{s}</span>
        ))}
        {res.subtitle_language?.map((l) => (
          <span key={`sl-${l}`} className="px-1.5 py-0.5 rounded bg-muted">字幕:{l}</span>
        ))}
        {res.subtitle_type?.map((t) => (
          <span key={`st-${t}`} className="px-1.5 py-0.5 rounded bg-muted">{t}</span>
        ))}
      </div>
    </div>
  );
}

export function HdhiveSearchDialog({
  open,
  onOpenChange,
  loading,
  query,
  tmdb,
  alternatives,
  resources,
  total,
  errorMessage,
  onPickAlternative,
}: Props) {
  const panTypes = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const r of resources) {
      const k = panTypeOf(r);
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
    return order;
  }, [resources]);

  const countByPanType = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of resources) {
      const k = panTypeOf(r);
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  }, [resources]);

  const showAllTab = panTypes.length > 1;
  const [activeTab, setActiveTab] = useState<string>(ALL_TAB);

  useEffect(() => {
    if (resources.length === 0) {
      setActiveTab(ALL_TAB);
      return;
    }
    setActiveTab((prev) => {
      if (prev === ALL_TAB) {
        return showAllTab ? ALL_TAB : panTypes[0] ?? ALL_TAB;
      }
      return panTypes.includes(prev) ? prev : showAllTab ? ALL_TAB : panTypes[0] ?? ALL_TAB;
    });
  }, [resources, panTypes, showAllTab]);

  const filteredResources = useMemo(() => {
    if (activeTab === ALL_TAB) return resources;
    return resources.filter((r) => panTypeOf(r) === activeTab);
  }, [resources, activeTab]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px] lg:max-w-[1100px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>HDHive 资源搜索</DialogTitle>
          <DialogDescription>
            通过关键词「{query || "—"}」查询 TMDB ID，再在 HDHive 查找网盘资源。
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            搜索中...
          </div>
        ) : errorMessage ? (
          <div className="text-sm text-red-600 py-4">{errorMessage}</div>
        ) : !tmdb ? (
          <div className="text-sm text-muted-foreground py-6">
            没有找到匹配的 TMDB 影视。可以换一个关键词，或者补充年份/原名再试。
          </div>
        ) : (
          <div className="space-y-4">
            <section className="flex gap-3 items-start border rounded-md p-3 bg-muted/30">
              <div className="relative w-20 h-28 flex-shrink-0 bg-muted rounded overflow-hidden">
                {tmdb.posterUrl ? (
                  <Image
                    src={tmdb.posterUrl}
                    alt={tmdb.title}
                    fill
                    sizes="80px"
                    unoptimized
                    className="object-cover"
                  />
                ) : (
                  <div className="flex items-center justify-center w-full h-full text-muted-foreground">
                    <Film className="h-6 w-6" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{tmdb.title || `TMDB #${tmdb.id}`}</span>
                  {tmdb.year && <Badge variant="secondary">{tmdb.year}</Badge>}
                  <MediaTypeBadge type={tmdb.mediaType} />
                  <Badge variant="outline" className="text-[10px]">TMDB {tmdb.id}</Badge>
                </div>
                {tmdb.overview && (
                  <p className="text-xs text-muted-foreground line-clamp-3">{tmdb.overview}</p>
                )}
              </div>
            </section>

            {alternatives.length > 0 && (
              <section>
                <div className="text-xs text-muted-foreground mb-1">其他可能的 TMDB 匹配</div>
                <div className="flex flex-wrap gap-2">
                  {alternatives.slice(0, 8).map((item) => (
                    <Button
                      key={`${item.mediaType}-${item.id}`}
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => onPickAlternative(item)}
                      title={item.overview || item.title}
                    >
                      {item.title || `#${item.id}`}
                      {item.year && <span className="ml-1 text-muted-foreground">({item.year})</span>}
                      <span className="ml-1 opacity-60">{item.mediaType === "movie" ? "电影" : "剧集"}</span>
                    </Button>
                  ))}
                </div>
              </section>
            )}

            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium">HDHive 资源</h3>
                <span className="text-xs text-muted-foreground">共 {total} 条</span>
              </div>

              {resources.length === 0 ? (
                <div className="text-sm text-muted-foreground py-6 text-center border rounded-md">
                  HDHive 暂无该影视的可用资源。
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-1 border-b">
                    {showAllTab && (
                      <TabButton
                        active={activeTab === ALL_TAB}
                        onClick={() => setActiveTab(ALL_TAB)}
                        label="全部"
                        count={resources.length}
                      />
                    )}
                    {panTypes.map((pt) => (
                      <TabButton
                        key={pt}
                        active={activeTab === pt}
                        onClick={() => setActiveTab(pt)}
                        label={pt}
                        count={countByPanType.get(pt) ?? 0}
                      />
                    ))}
                  </div>

                  {filteredResources.length === 0 ? (
                    <div className="text-sm text-muted-foreground py-6 text-center border rounded-md">
                      当前分类下暂无资源。
                    </div>
                  ) : (
                    <div className="columns-1 sm:columns-2 lg:columns-3 gap-3">
                      {filteredResources.map((res) => (
                        <ResourceCard key={res.slug} res={res} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "relative -mb-px px-3 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5 " +
        (active
          ? "text-foreground border-b-2 border-foreground"
          : "text-muted-foreground hover:text-foreground border-b-2 border-transparent")
      }
    >
      {label}
      <span
        className={
          "rounded px-1.5 py-0.5 text-[10px] " +
          (active ? "bg-foreground text-background" : "bg-muted text-muted-foreground")
        }
      >
        {count}
      </span>
    </button>
  );
}

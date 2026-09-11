"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Film, Loader2, Search, Tv } from "lucide-react";
import { toast } from "sonner";
import type { OrganizeCandidate, OrganizeUnit } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, type TmdbSearchResult } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";

type Pick = { mediaType: "movie" | "tv"; tmdbId: number; title: string; year: string; posterUrl: string };

function Poster({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="relative aspect-[2/3] w-full overflow-hidden rounded-md bg-muted">
      {url && !broken ? (
        <Image src={url} alt="" fill className="object-cover" unoptimized onError={() => setBroken(true)} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <Film className="size-6" />
        </div>
      )}
    </div>
  );
}

function PickButton({ item, current, onPick }: { item: Pick; current: boolean; onPick: (p: Pick) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(item)}
      className={`group overflow-hidden rounded-md border text-left transition hover:ring-2 hover:ring-brand ${current ? "ring-2 ring-brand" : ""}`}
      title={item.title}
    >
      <Poster url={item.posterUrl} />
      <div className="space-y-0.5 p-1.5">
        <div className="truncate text-xs font-medium">{item.title}</div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {item.mediaType === "tv" ? <Tv className="size-3" /> : <Film className="size-3" />}
          <span>{item.year || "年份未知"}</span>
          <span className="ml-auto tabular-nums">#{item.tmdbId}</span>
        </div>
      </div>
    </button>
  );
}

/** 换匹配：先列识别时的备选，再可以按关键词搜 TMDB，点一个就换 */
export function MatchDialog({
  unit,
  onOpenChange,
  onPick,
}: {
  unit: OrganizeUnit | null;
  onOpenChange: (open: boolean) => void;
  onPick: (pick: { mediaType: "movie" | "tv"; tmdbId: number }) => Promise<void>;
}) {
  const open = unit != null;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TmdbSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!unit) return;
    setQuery(unit.parsedTitle || unit.rawName);
    setResults([]);
  }, [unit]);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      const list = await api.tmdb.search(q);
      setResults(list.filter((r) => r.mediaType === "movie" || r.mediaType === "tv"));
      if (list.length === 0) toast.info("没有找到相关结果");
    } catch (err) {
      toast.error(apiErrorMessage(err, "TMDB 搜索失败"));
    } finally {
      setSearching(false);
    }
  };

  const pick = async (p: Pick) => {
    setPicking(true);
    try {
      await onPick({ mediaType: p.mediaType, tmdbId: p.tmdbId });
      onOpenChange(false);
    } finally {
      setPicking(false);
    }
  };

  const candidates: Pick[] = (unit?.match?.candidates ?? []).map((c: OrganizeCandidate) => ({
    mediaType: c.mediaType,
    tmdbId: c.tmdbId,
    title: c.title,
    year: c.year,
    posterUrl: c.posterUrl,
  }));
  const searched: Pick[] = results.map((r) => ({ mediaType: r.mediaType === "tv" ? "tv" : "movie", tmdbId: r.id, title: r.title, year: r.year, posterUrl: r.posterUrl }));
  const currentId = unit?.match ? `${unit.match.mediaType}:${unit.match.tmdbId}` : "";

  return (
    <Dialog open={open} onOpenChange={(o) => !picking && onOpenChange(o)}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>换匹配</DialogTitle>
          <DialogDescription className="break-all">
            「{unit?.rawName}」现在识别为 {unit?.match ? `${unit.match.title} (${unit.match.year})` : "（没识别出来）"}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <div className="flex items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void search()}
              placeholder="片名，中文或英文"
            />
            <Button onClick={() => void search()} disabled={searching}>
              {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              搜索
            </Button>
          </div>
          {picking && <div className="text-xs text-muted-foreground">正在按新的匹配重新规划…</div>}
          {searched.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">搜索结果</h3>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {searched.map((p) => (
                  <PickButton key={`s-${p.mediaType}-${p.tmdbId}`} item={p} current={currentId === `${p.mediaType}:${p.tmdbId}`} onPick={(x) => void pick(x)} />
                ))}
              </div>
            </section>
          )}
          {candidates.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">识别时的备选</h3>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {candidates.map((p) => (
                  <PickButton key={`c-${p.mediaType}-${p.tmdbId}`} item={p} current={currentId === `${p.mediaType}:${p.tmdbId}`} onPick={(x) => void pick(x)} />
                ))}
              </div>
            </section>
          )}
          {searched.length === 0 && candidates.length === 0 && <p className="text-sm text-muted-foreground">输入片名搜一下，点海报就换。</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Film, Loader2, Search, Tv } from "lucide-react";
import { toast } from "sonner";
import type { OrganizeCandidate, OrganizeMediaType, OrganizeUnit } from "@openstrm/shared";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";

type Choice = Pick<OrganizeCandidate, "mediaType" | "tmdbId" | "title" | "year" | "posterUrl">;
type Kind = "" | OrganizeMediaType;

const KINDS: Array<{ key: Kind; label: string }> = [
  { key: "", label: "全部" },
  { key: "movie", label: "电影" },
  { key: "tv", label: "剧集" },
];

/** 关键词是 TMDB 编号、TMDB 链接或 id 标签（tmdbid=123、tmdb-123、{tmdb-123}）时按编号查；链接自带类型 */
function parseTmdbRef(text: string): { id: number; type?: OrganizeMediaType } | null {
  const q = text.trim();
  const url = /themoviedb\.org\/(movie|tv)\/(\d+)/i.exec(q);
  if (url) return { id: Number(url[2]), type: url[1].toLowerCase() === "tv" ? "tv" : "movie" };
  const tag = /^[[{]?\s*tmdb(?:id)?\s*[=:-]\s*(\d+)\s*[\]}]?$/i.exec(q);
  if (tag) return { id: Number(tag[1]) };
  if (/^\d{1,9}$/.test(q)) return { id: Number(q) };
  return null;
}

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

function PickButton({ item, current, onPick }: { item: Choice; current: boolean; onPick: (p: Choice) => void }) {
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

/** 换匹配：先列识别时的备选；可以按关键词搜（限定类型、年份），也可以直接填 TMDB 编号或贴 TMDB 链接 */
export function MatchDialog({
  unit,
  onOpenChange,
  onPick,
}: {
  unit: OrganizeUnit | null;
  onOpenChange: (open: boolean) => void;
  /** 成功返回 true 才关弹框；失败的提示由调用方给 */
  onPick: (pick: { mediaType: OrganizeMediaType; tmdbId: number }) => Promise<boolean>;
}) {
  const open = unit != null;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("");
  const [year, setYear] = useState("");
  const [results, setResults] = useState<Choice[]>([]);
  const [byId, setById] = useState(false);
  const [searching, setSearching] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!unit) return;
    setQuery(unit.parsedTitle || unit.rawName);
    setKind(unit.match?.mediaType ?? "");
    setYear(unit.parsedYear);
    setResults([]);
    setById(false);
  }, [unit]);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      const ref = parseTmdbRef(q);
      if (ref) {
        // 编号不带类型：电影、剧集都查一遍（同一个编号两边可能都有）
        const types: OrganizeMediaType[] = ref.type ? [ref.type] : kind ? [kind] : ["movie", "tv"];
        const settled = await Promise.allSettled(types.map((t) => api.organize.tmdbLookup(t, ref.id)));
        const found = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
        setResults(found);
        setById(true);
        if (found.length === 0) toast.info(`TMDB 上没有编号 ${ref.id}${types.length === 1 ? `的${types[0] === "movie" ? "电影" : "剧集"}` : ""}`);
      } else {
        const y = year.trim();
        const r = await api.organize.tmdbSearch({ query: q, type: kind || undefined, year: /^\d{4}$/.test(y) ? y : undefined });
        setResults(r.results);
        setById(false);
        if (r.results.length === 0) toast.info("没有找到相关结果：换个关键词，或者去掉年份 / 类型再试");
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, "TMDB 搜索失败"));
    } finally {
      setSearching(false);
    }
  };

  const pick = async (p: Choice) => {
    setPicking(true);
    try {
      if (await onPick({ mediaType: p.mediaType, tmdbId: p.tmdbId })) onOpenChange(false);
    } finally {
      setPicking(false);
    }
  };

  const candidates: Choice[] = unit?.match?.candidates ?? [];
  const currentId = unit?.match ? `${unit.match.mediaType}:${unit.match.tmdbId}` : "";

  return (
    <Dialog open={open} onOpenChange={(o) => !picking && onOpenChange(o)}>
      <DialogContent size="lg" className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle>换匹配</DialogTitle>
          <DialogDescription className="break-all">
            「{unit?.rawName}」现在识别为 {unit?.match ? `${unit.match.title}${unit.match.year ? ` (${unit.match.year})` : ""}` : "（没识别出来）"}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-md border p-0.5 text-xs">
                {KINDS.map((k) => (
                  <button
                    key={k.key || "all"}
                    type="button"
                    onClick={() => setKind(k.key)}
                    className={`rounded px-2 py-1 ${kind === k.key ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              <Input className="h-8 w-24 text-xs" value={year} onChange={(e) => setYear(e.target.value)} placeholder="年份" inputMode="numeric" maxLength={4} />
            </div>
            <InputGroup>
              <InputGroupInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void search()}
                placeholder="片名（中文或原名），或 TMDB 编号 / 链接"
              />
              <InputGroupButton onClick={() => void search()} disabled={searching}>
                {searching ? <Loader2 className="animate-spin" /> : <Search />}
                搜索
              </InputGroupButton>
            </InputGroup>
            <p className="text-xs text-muted-foreground">直接填编号（如 693134）或贴 TMDB 链接就按编号查；片名搜不到时限定类型、年份更准。</p>
          </div>
          {picking && <div className="text-xs text-muted-foreground">正在按新的匹配重新规划…</div>}
          {results.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">{byId ? "按编号查到" : "搜索结果"}</h3>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {results.map((p) => (
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
          {results.length === 0 && candidates.length === 0 && <p className="text-sm text-muted-foreground">搜一下，点海报就换。</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

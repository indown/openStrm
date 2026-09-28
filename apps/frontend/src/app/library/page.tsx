"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { ProgressBar } from "@/components/progress-bar";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/loading";
import { LibraryHits, ShareHealthBadge } from "@/components/LibraryHits";
import {
  CloudUpload,
  Edit,
  FolderOpen,
  KeyRound,
  Library,
  Link2,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { MediaLibraryEntry, ShareFollowSummary } from "@openstrm/shared";
import { api } from "@/lib/api";
import { apiErrorBody, apiErrorMessage } from "@/lib/axios";
import { formatSize, fmtWhen } from "@/lib/format";
import { LIBRARY_CHANGED_EVENT } from "@/lib/library";
import { notifyFollowResult, notifySaveToTaskResult } from "@/lib/save-result";
import { useShareDetail } from "@/hooks/use-share-detail";
import { shareKindOf } from "@/lib/share";
import { cn } from "@/lib/utils";
import { ShareDetailDialog } from "@/components/ShareDetailDialog";
import { AddToLibraryDialog, type AddToLibraryInitial } from "@/components/AddToLibraryDialog";
import { SaveToDriveDialog, type SaveToTaskChoice } from "@/components/SaveToDriveDialog";

const DESCRIPTION = "收藏的分享都抄下目录树建了索引：中文名、英文名、年份都能搜到里面的每一部，点一条就能打开或转存";

/** 从下拉菜单里打开弹框要等菜单先关掉，否则菜单还回焦点时会把弹框顶掉 */
const afterMenuClosed = (fn: () => void) => setTimeout(fn, 0);

/** 卡片、确认框上怎么称呼一条 */
const labelOf = (e: MediaLibraryEntry) => e.title || e.shareTitle || e.rawName || e.shareCode;
const isWhole = (e: MediaLibraryEntry) => (!e.shareRootCid || e.shareRootCid === "0") && !e.sharePath.replace(/^\/+/, "");
const indexing = (e: MediaLibraryEntry) => e.indexStatus === "pending" || e.indexStatus === "indexing";

type View = "all" | "indexing" | "expired" | "locked";

export default function LibraryPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-6">
          <PageHeader icon={Library} title="影库" description={DESCRIPTION} />
          <TableSkeleton rows={5} />
        </div>
      }
    >
      <LibraryContent />
    </Suspense>
  );
}

function LibraryContent() {
  const router = useRouter();
  const params = useSearchParams();
  const urlQ = params.get("q") ?? "";
  const [input, setInput] = useState(urlQ);
  const [query, setQuery] = useState(urlQ);
  const [view, setView] = useState<View>(params.get("view") === "expired" ? "expired" : "all");
  const searchRef = useRef<HTMLInputElement>(null);

  const [entries, setEntries] = useState<MediaLibraryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [follows, setFollows] = useState<ShareFollowSummary[]>([]);

  const [editing, setEditing] = useState<AddToLibraryInitial | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MediaLibraryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [relinkTarget, setRelinkTarget] = useState<MediaLibraryEntry | null>(null);
  const [codeTarget, setCodeTarget] = useState<MediaLibraryEntry | null>(null);
  const [saveToTaskEntry, setSaveToTaskEntry] = useState<MediaLibraryEntry | null>(null);
  const [savingToTask, setSavingToTask] = useState(false);
  const share = useShareDetail();

  // 地址里的词变了（⌘K「在影库里搜」、首页「在影库里看全部」）：跟上
  useEffect(() => {
    setInput(urlQ);
    setQuery(urlQ);
  }, [urlQ]);

  // 打字停一会儿再搜，词同步进地址（刷新、分享链接都还在）
  useEffect(() => {
    const t = setTimeout(() => {
      const q = input.trim();
      if (q === query.trim()) return;
      setQuery(q);
      router.replace(q ? `/library?q=${encodeURIComponent(q)}` : "/library", { scroll: false });
    }, 300);
    return () => clearTimeout(t);
  }, [input, query, router]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA" || (target?.isContentEditable ?? false);
      if (e.key === "/" && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape" && document.activeElement === searchRef.current) {
        setInput("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // 轮询、广播、重试、操作后刷新可能交错：只认最后一次
  const seqRef = useRef(0);
  const fetchEntries = useCallback(async (silent = false) => {
    const seq = ++seqRef.current;
    if (!silent) setRefreshing(true);
    try {
      const list = await api.library.list();
      if (seq !== seqRef.current) return;
      setEntries(Array.isArray(list) ? list : []);
      setError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      const msg = apiErrorMessage(err, "加载影库失败");
      setError(msg);
      if (!silent) toast.error(msg);
    } finally {
      if (seq === seqRef.current) {
        setLoaded(true);
        setRefreshing(false);
      }
    }
  }, []);

  const fetchFollows = useCallback(async () => {
    try {
      setFollows((await api.follow.list()).follows);
    } catch {
      // 追更列表拿不到不影响影库本身
    }
  }, []);

  useEffect(() => {
    void fetchEntries();
    void fetchFollows();
  }, [fetchEntries, fetchFollows]);

  // 分享详情里「加入影库」成功了（这页自己的弹框、顶栏的弹框都算）：悄悄重拉
  useEffect(() => {
    const onChanged = () => void fetchEntries(true);
    window.addEventListener(LIBRARY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(LIBRARY_CHANGED_EVENT, onChanged);
  }, [fetchEntries]);

  // 有来源在建索引 / 刮海报：每 3 秒刷一次进度
  const busy = entries.some((e) => indexing(e) || e.scrapeStatus === "pending");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void fetchEntries(true), 3000);
    return () => clearInterval(t);
  }, [busy, fetchEntries]);

  const followedKeys = useMemo(() => new Set(follows.map((f) => `${f.shareCode}:${f.watchCid}`)), [follows]);
  const followKeyOf = (e: MediaLibraryEntry) => `${e.shareCode}:${e.shareRootCid && e.shareRootCid !== "0" ? e.shareRootCid : "0"}`;

  const counts = useMemo(
    () => ({
      all: entries.length,
      indexing: entries.filter(indexing).length,
      expired: entries.filter((e) => e.health?.status === "expired").length,
      locked: entries.filter((e) => e.health?.status === "locked").length,
    }),
    [entries],
  );
  const expiredShares = useMemo(() => new Set(entries.filter((e) => e.health?.status === "expired").map((e) => e.shareCode)).size, [entries]);
  const shown = entries.filter((e) =>
    view === "indexing" ? indexing(e) : view === "expired" ? e.health?.status === "expired" : view === "locked" ? e.health?.status === "locked" : true,
  );
  // 筛选下已经没东西了（清理完、恢复了）：回到全部
  useEffect(() => {
    if (loaded && view !== "all" && counts[view] === 0) setView("all");
  }, [loaded, view, counts]);

  const openEntry = (entry: MediaLibraryEntry) => {
    const isSubdir = !isWhole(entry);
    const segments = (entry.sharePath || "").replace(/^\/+/, "").split("/").filter(Boolean);
    const startCrumbs = !isSubdir
      ? undefined
      : segments.length > 0
        ? segments.map((name, i) => ({ id: i === segments.length - 1 ? entry.shareRootCid : "", name }))
        : [{ id: entry.shareRootCid, name: entry.rawName || entry.title || "子目录" }];
    void share
      .load(entry.shareUrl, { openImmediately: true, startCid: isSubdir ? entry.shareRootCid : undefined, startCrumbs, failMessage: "打开分享失败" })
      .then((r) => {
        // 打不开：后端顺带记了这个分享的死活，刷一下列表就能看到
        if (!r.ok && !r.superseded) void fetchEntries(true);
      });
  };

  const openEditor = (entry: MediaLibraryEntry) => {
    setEditing({ id: entry.id, shareUrl: entry.shareUrl, title: entry.title, coverUrl: entry.coverUrl, tags: entry.tags, notes: entry.notes, scrapeStatus: entry.scrapeStatus });
    setEditorOpen(true);
  };

  // 失效 / 提取码不对的是「再查一次」：后端真去问一次网盘，好了停下的接着抄
  const refreshIndex = async (entry: MediaLibraryEntry) => {
    const recheck = isRecheck(entry);
    try {
      const r = await api.library.refresh(entry.id);
      if (!recheck) toast.success(`开始重新建索引：${labelOf(entry)}`);
      else toast.success(r.indexStatus === "done" ? `分享又能打开了：${labelOf(entry)}` : `分享又能打开了，接着建索引：${labelOf(entry)}`);
      void fetchEntries(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, recheck ? "没查成" : "没能开始重新建索引"));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.library.remove(deleteTarget.id);
      toast.success(`已从影库移除「${labelOf(deleteTarget)}」`);
      setEntries((prev) => prev.filter((e) => e.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, "移除失败"));
    } finally {
      setDeleting(false);
    }
  };

  const confirmCleanup = async () => {
    setCleaning(true);
    try {
      const r = await api.library.removeExpired();
      toast.success(r.sources > 0 ? `已清理 ${r.shares} 个失效的分享（${r.sources} 处收藏）` : "没有要清理的");
      setCleanupOpen(false);
      void fetchEntries(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, "清理失败"));
    } finally {
      setCleaning(false);
    }
  };

  const handleSaveToTaskChoice = async (choice: SaveToTaskChoice) => {
    if (!saveToTaskEntry) return;
    const entry = saveToTaskEntry;
    setSavingToTask(true);
    setSaveToTaskEntry(null);
    try {
      const result = await api.library.saveToTask(entry.id, choice);
      notifySaveToTaskResult(result, router);
      notifyFollowResult(choice, result);
      if (choice.follow) void fetchFollows();
    } catch (err) {
      toast.error(apiErrorMessage(err, "保存失败"));
    } finally {
      setSavingToTask(false);
    }
  };

  const handleSaved = (entry: MediaLibraryEntry) => {
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === entry.id);
      if (idx < 0) return [entry, ...prev];
      const next = prev.slice();
      next[idx] = { ...prev[idx], ...entry };
      return next;
    });
  };

  const searching = query.trim().length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Library}
        title="影库"
        description={DESCRIPTION}
        actionsClassName="w-full sm:w-auto"
        actions={
          <>
            <div className="relative min-w-0 flex-1 sm:w-80 sm:flex-none">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                placeholder="片名、英文名、年份…（按 / 聚焦）"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="pl-8"
              />
            </div>
            <Button variant="outline" onClick={() => setAddOpen(true)}>
              <Plus />
              添加分享
            </Button>
          </>
        }
      />

      {searching ? (
        <LibraryHits query={query} variant="page" pageSize={30} />
      ) : !loaded ? (
        <TableSkeleton rows={5} />
      ) : entries.length === 0 ? (
        error ? (
          <EmptyState
            icon={Library}
            title="影库加载失败"
            description={error}
            action={
              <Button variant="outline" onClick={() => void fetchEntries()} disabled={refreshing}>
                <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
                重试
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={Library}
            title="影库是空的"
            description="贴一个 115 / 夸克分享链接加进来，整个分享的目录树会抄下来建索引；也可以在分享详情里点「加入影库」只收其中一个目录。"
            action={
              <Button onClick={() => setAddOpen(true)}>
                <Plus />
                添加分享
              </Button>
            }
          />
        )
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <ViewChip active={view === "all"} onClick={() => setView("all")} label="全部" count={counts.all} />
            {counts.indexing > 0 && <ViewChip active={view === "indexing"} onClick={() => setView("indexing")} label="建索引中" count={counts.indexing} />}
            {counts.locked > 0 && <ViewChip active={view === "locked"} onClick={() => setView("locked")} label="提取码不对" count={counts.locked} tone="danger" />}
            {counts.expired > 0 && <ViewChip active={view === "expired"} onClick={() => setView("expired")} label="已失效" count={counts.expired} tone="danger" />}
            {view === "expired" && counts.expired > 0 && (
              <Button variant="outline" size="sm" className="ml-auto text-destructive hover:text-destructive" onClick={() => setCleanupOpen(true)}>
                <Trash2 />
                清理全部失效的分享
              </Button>
            )}
          </div>
          {view === "expired" && (
            <p className="text-xs text-muted-foreground">
              这些分享已经打不开了，里面的资源转存不了。上传者发了新链接的用「更新链接」接上；觉得只是一时打不开（比如分享在审核）的点「再查一次」；不要了就清理掉。搜索时它们折叠在最后，不和能用的混在一起。
            </p>
          )}
          <div className="divide-y overflow-hidden rounded-xl border bg-card">
            {shown.map((entry) => (
              <SourceRow
                key={entry.id}
                entry={entry}
                followed={followedKeys.has(followKeyOf(entry))}
                savingToTask={savingToTask && saveToTaskEntry?.id === entry.id}
                onOpen={() => openEntry(entry)}
                onSave={() => setSaveToTaskEntry(entry)}
                onEdit={() => openEditor(entry)}
                onRefresh={() => void refreshIndex(entry)}
                onRelink={() => setRelinkTarget(entry)}
                onCode={() => setCodeTarget(entry)}
                onDelete={() => setDeleteTarget(entry)}
              />
            ))}
          </div>
        </div>
      )}

      <AddToLibraryDialog open={editorOpen} onOpenChange={setEditorOpen} initial={editing} onSaved={handleSaved} />

      <ShareDetailDialog
        {...share.dialogProps}
        onOpenChange={(open) => {
          share.setOpen(open);
          // 在分享里「保存到任务目录」时可能顺手开了追更：关上时刷一下「追更中」
          if (!open) void fetchFollows();
        }}
      />

      <SaveToDriveDialog
        open={saveToTaskEntry != null}
        onOpenChange={(open) => !open && setSaveToTaskEntry(null)}
        onConfirm={handleSaveToTaskChoice}
        selectedCount={1}
        kind={shareKindOf(saveToTaskEntry?.shareUrl) ?? undefined}
        followHint={`之后定期检查「${saveToTaskEntry ? labelOf(saveToTaskEntry) : "该分享"}」对应的分享目录里新增的文件，自动转存到同一位置并生成 strm。`}
      />

      <AddShareDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => {
          setView("all");
          void fetchEntries(true);
        }}
      />

      <RelinkDialog target={relinkTarget} onOpenChange={(o) => !o && setRelinkTarget(null)} onDone={() => void fetchEntries(true)} />
      <ReceiveCodeDialog target={codeTarget} onOpenChange={(o) => !o && setCodeTarget(null)} onDone={() => void fetchEntries(true)} />

      <AlertDialog open={deleteTarget != null} onOpenChange={(o) => !o && !deleting && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>从影库移除</AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              移除「{deleteTarget ? labelOf(deleteTarget) : ""}」这条收藏和它的索引。分享本身、已经转存的文件、生成的 strm 和追更订阅都不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : "移除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cleanupOpen} onOpenChange={(o) => !o && !cleaning && setCleanupOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清理失效的分享</AlertDialogTitle>
            <AlertDialogDescription>
              从影库移除 {expiredShares} 个已失效的分享（{counts.expired} 处收藏）和它们的索引。只删影库里的记录，网盘上的文件、生成的 strm 和追更订阅都不动；「可能已失效」的还在复查，不在这次清理里。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cleaning}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                void confirmCleanup();
              }}
              disabled={cleaning}
            >
              {cleaning ? <Loader2 className="size-4 animate-spin" /> : "清理"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ViewChip({ active, onClick, label, count, tone }: { active: boolean; onClick: () => void; label: string; count: number; tone?: "danger" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors",
        active ? "border-brand/50 bg-brand/10 font-medium text-brand" : "text-muted-foreground hover:text-foreground",
        tone === "danger" && !active && "text-destructive/80",
      )}
    >
      {label}
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

interface SourceRowProps {
  entry: MediaLibraryEntry;
  followed: boolean;
  savingToTask: boolean;
  onOpen: () => void;
  onSave: () => void;
  onEdit: () => void;
  onRefresh: () => void;
  onRelink: () => void;
  onCode: () => void;
  onDelete: () => void;
}

/** 一个来源（收藏的分享或其中一个目录）：封面、名字、在哪、索引进度 / 统计 / 分享死活，操作收在菜单里 */
/** 分享本身打不开（失效、提取码不对）：「重新建索引」换成「再查一次」 */
const isRecheck = (entry: MediaLibraryEntry) => entry.health?.status === "expired" || entry.health?.status === "locked";

function SourceRow({ entry, followed, savingToTask, onOpen, onSave, onEdit, onRefresh, onRelink, onCode, onDelete }: SourceRowProps) {
  const label = labelOf(entry);
  const whole = isWhole(entry);
  const where = whole ? "整个分享" : entry.sharePath.replace(/^\/+/, "");
  const status = entry.health?.status ?? "unknown";
  const dead = status === "expired";
  const recheck = isRecheck(entry);
  const pct = entry.dirsTotal > 0 ? (entry.dirsListed / entry.dirsTotal) * 100 : 0;
  return (
    <div className={cn("flex gap-3 px-4 py-3", dead && "opacity-70")}>
      <button type="button" onClick={onOpen} className="relative h-[4.5rem] w-12 shrink-0 overflow-hidden rounded-md border bg-muted" title="打开分享" disabled={dead}>
        {entry.coverUrl ? (
          <Image src={entry.coverUrl} alt="" fill className="object-cover" sizes="48px" unoptimized />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Share2 className="size-5" />
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <button type="button" onClick={onOpen} disabled={dead} className="min-w-0 text-left text-sm font-medium [overflow-wrap:anywhere] hover:underline disabled:no-underline">
            {label}
          </button>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="outline" size="sm" className="hidden sm:inline-flex" onClick={onOpen} disabled={dead}>
              <FolderOpen />
              打开
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-9 md:size-8" aria-label="更多操作">
                  {savingToTask ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onOpen} disabled={dead}>
                  <FolderOpen />
                  打开分享
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => afterMenuClosed(onSave)} disabled={dead || savingToTask}>
                  <CloudUpload />
                  {whole ? "整个分享" : "这个目录"}保存到任务目录{entry.totalSize > 0 ? `（${formatSize(entry.totalSize)}）` : ""}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onRefresh}>
                  <RefreshCw />
                  {recheck ? "再查一次" : "重新建索引"}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => afterMenuClosed(onRelink)}>
                  <Link2 />
                  更新链接
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => afterMenuClosed(onCode)}>
                  <KeyRound />
                  改提取码
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => afterMenuClosed(onEdit)}>
                  <Edit />
                  编辑名字、封面、标签
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => afterMenuClosed(onDelete)}>
                  <Trash2 />
                  从影库移除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <p className="truncate text-xs text-muted-foreground" title={`${entry.shareTitle ? `${entry.shareTitle} · ` : ""}${where}`}>
          {entry.shareTitle && !whole ? `${entry.shareTitle} · ` : ""}
          {where}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <ShareHealthBadge health={entry.health ?? { status: "unknown", reason: "", checkedAt: null, expiredAt: null }} />
          {followed && <StatusBadge tone="info">追更中</StatusBadge>}
          {entry.indexStatus === "pending" && !dead && <span>排队建索引</span>}
          {entry.indexStatus === "indexing" && !dead && !entry.indexError && (
            <span className="flex min-w-[10rem] items-center gap-2">
              <ProgressBar percent={pct} indeterminate={entry.dirsTotal === 0} running className="w-24" />
              <span className="tabular-nums">
                建索引 {entry.dirsListed}/{entry.dirsTotal} 个目录
              </span>
            </span>
          )}
          {entry.indexStatus === "failed" && !dead && <span className="text-destructive">没抄完：{entry.indexError}</span>}
          {entry.indexStatus === "indexing" && entry.indexError && (
            <span className="text-warning">
              暂停（已抄 {entry.dirsListed}/{entry.dirsTotal} 个目录）：{entry.indexError}
            </span>
          )}
          {entry.indexStatus === "done" && (
            <span className="tabular-nums" title={entry.indexedAt ? `索引于 ${new Date(entry.indexedAt * 1000).toLocaleString("zh-CN", { hour12: false })}` : undefined}>
              {entry.videoCount} 个视频 · {formatSize(entry.totalSize)}
              {entry.indexedAt ? ` · ${fmtWhen(entry.indexedAt * 1000)}索引` : ""}
            </span>
          )}
          {entry.truncated && <span className="text-warning">{entry.indexError || "太大了，只抄了一部分"}</span>}
          {entry.tags.slice(0, 4).map((tag) => (
            <Badge key={tag} variant="outline" className="px-1.5 py-0 text-xs">
              {tag}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 添加分享：贴链接（整段「链接：… 提取码：…」也行），整个分享加进来抄目录树 */
function AddShareDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setText("");
  }, [open]);
  const submit = async () => {
    const shareUrl = text.trim();
    if (!shareUrl) return;
    setSaving(true);
    try {
      const r = await api.library.create({ shareUrl });
      toast.success(
        `已加入影库：${r.entry.title || r.entry.shareCode}。正在建索引，大的分享要几分钟到几十分钟，抄到的部分已经能搜${r.absorbed ? `；之前单独收的 ${r.absorbed} 个子目录并进来了` : ""}`,
      );
      onOpenChange(false);
      onAdded();
    } catch (err) {
      toast.error(apiErrorMessage(err, "加入影库失败"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加分享到影库</DialogTitle>
          <DialogDescription>
            整个分享的目录树会抄下来建索引，之后按片名、英文名、年份都能搜到里面的每一部。只想收其中一个目录的，在分享详情里进到那一层再点「加入影库」。
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"https://115cdn.com/s/xxxx?password=xxxx\n或者整段「链接：… 提取码：…」"}
          rows={3}
          className="font-mono text-xs"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={saving || !text.trim()}>
            {saving && <Loader2 className="animate-spin" />}
            加入影库
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 更新链接：上传者重发了新链接。内容和原来差很多时先问一句 */
function RelinkDialog({ target, onOpenChange, onDone }: { target: MediaLibraryEntry | null; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [mismatch, setMismatch] = useState<string | null>(null);
  // 关的时候 target 先变成 null：标题留着上一个，淡出时别闪成「」
  const [label, setLabel] = useState("");
  useEffect(() => {
    if (target) {
      setText("");
      setMismatch(null);
      setLabel(labelOf(target));
    }
  }, [target]);
  const submit = async (confirm: boolean) => {
    if (!target || !text.trim()) return;
    setSaving(true);
    try {
      await api.library.relink(target.id, text.trim(), confirm);
      toast.success("链接已更新，正在重新建索引");
      onOpenChange(false);
      onDone();
    } catch (err) {
      const body = apiErrorBody(err) as { code?: string; message?: string };
      if (body.code === "RELINK_MISMATCH") setMismatch(body.message ?? "新链接里的内容和原来的对不上几条");
      else toast.error(apiErrorMessage(err, "更新链接失败"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={target != null} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>更新链接</DialogTitle>
          <DialogDescription className="break-all">
            「{label}」换成新的分享链接：会换成整个新分享、重新建索引，标签和备注保留。
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setMismatch(null);
          }}
          placeholder="新的分享链接（整段「链接：… 提取码：…」也行）"
          rows={3}
          className="font-mono text-xs"
        />
        {mismatch && <p className="text-sm text-warning">{mismatch}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          {mismatch ? (
            <Button variant="destructive" onClick={() => void submit(true)} disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              仍然换
            </Button>
          ) : (
            <Button onClick={() => void submit(false)} disabled={saving || !text.trim()}>
              {saving && <Loader2 className="animate-spin" />}
              更新
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 改提取码：同一个分享收了几处的一起改，改完马上查一次 */
function ReceiveCodeDialog({ target, onOpenChange, onDone }: { target: MediaLibraryEntry | null; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState("");
  useEffect(() => {
    if (target) {
      setCode(target.receiveCode);
      setLabel(labelOf(target));
    }
  }, [target]);
  const submit = async () => {
    if (!target) return;
    setSaving(true);
    try {
      const r = (await api.library.update(target.id, { receiveCode: code.trim() })) as MediaLibraryEntry;
      const st = r.health?.status;
      if (st === "locked") toast.error("提取码还是不对");
      else if (st === "expired") toast.error("分享已经失效了");
      else toast.success("提取码已更新");
      onOpenChange(false);
      onDone();
    } catch (err) {
      toast.error(apiErrorMessage(err, "改提取码失败"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={target != null} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>改提取码</DialogTitle>
          <DialogDescription className="break-all">「{label}」所在的分享；同一个分享收了几处的会一起改。</DialogDescription>
        </DialogHeader>
        <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="提取码" className="font-mono" onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void submit()} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bookmark, FolderOpen, FolderTree, History, Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";
import type { OrganizeRun } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/loading";
import { TreeSelectDialog } from "@/components/TreeSelectDialog";
import { api, type TaskRow } from "@/lib/api";
import { accountLabel } from "@/lib/drive";
import { apiErrorMessage } from "@/lib/axios";
import { notifyOrganizeChanged } from "@/lib/organize";
import { AttentionList } from "./components/AttentionList";
import { HistoryDialog } from "./components/HistoryDialog";
import { MemoryDialog } from "./components/MemoryDialog";
import { RunView } from "./components/RunView";
import { toastRunError } from "./components/helpers";

const DESCRIPTION = "识别网盘里的影视文件，按 TMDB 规范命名并归到标准目录；先预览再执行，做过的能撤销";

const trimSlashes = (p: string) => p.replace(/^\/+|\/+$/g, "");

/**
 * 手输的范围换成相对任务目录的路径：以 / 开头的当网盘绝对路径，在任务目录下就去掉前缀、不在就报错；
 * 其余当相对路径。path 为空串是整个任务
 */
function toScope(input: string, originPath: string): { ok: true; path: string } | { ok: false; error: string } {
  const raw = input.trim();
  const origin = trimSlashes(originPath);
  if (raw.startsWith("/")) {
    const abs = trimSlashes(raw);
    if (abs === origin) return { ok: true, path: "" };
    if (!origin) return { ok: true, path: abs };
    if (abs.startsWith(`${origin}/`)) return { ok: true, path: abs.slice(origin.length + 1) };
    return { ok: false, error: `「${raw}」不在任务目录 /${origin} 里；范围要在任务目录之内（也可以直接写相对路径）` };
  }
  return { ok: true, path: trimSlashes(raw.replace(/^\.\//, "")) };
}

/** 加一组范围：去重；套在别的范围里面的去掉（已经整个包含了） */
function addScopes(prev: string[], more: string[]): string[] {
  const all = [...new Set([...prev, ...more].filter(Boolean))];
  return all.filter((p) => !all.some((o) => o !== p && p.startsWith(`${o}/`)));
}

export default function OrganizePage() {
  return (
    <React.Suspense
      fallback={
        <div className="space-y-6">
          <PageHeader icon={FolderTree} title="整理" description={DESCRIPTION} />
          <TableSkeleton rows={4} />
        </div>
      }
    >
      <OrganizeContent />
    </React.Suspense>
  );
}

function OrganizeContent() {
  const router = useRouter();
  const search = useSearchParams();
  const runId = search.get("run") ?? "";
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [taskId, setTaskId] = useState(search.get("task") ?? "");
  /** 范围：相对任务目录的一组目录；空的是整个任务 */
  const [scopes, setScopes] = useState<string[]>(() => {
    const p = trimSlashes(search.get("path") ?? "");
    return p ? [p] : [];
  });
  /** 输入框里还没加进范围的那条 */
  const [draft, setDraft] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

  useEffect(() => {
    api.tasks
      .list()
      .then((rows) => {
        setTasks(rows);
        setTaskId((prev) => (prev && rows.some((t) => t.id === prev) ? prev : (rows[0]?.id ?? "")));
      })
      .catch((err) => {
        setTasks([]);
        toast.error(apiErrorMessage(err, "读取任务列表失败"));
      });
  }, []);

  const task = useMemo(() => tasks?.find((t) => t.id === taskId) ?? null, [tasks, taskId]);
  const origin = task ? trimSlashes(task.originPath) : "";

  /** 打开一次整理（null 关掉）；runTaskId 是那次整理所属的任务，和当前选的不一样时顺手切过去 */
  const openRun = useCallback(
    (id: string | null, runTaskId?: string) => {
      const t = runTaskId || taskId;
      if (runTaskId && runTaskId !== taskId) {
        setTaskId(runTaskId);
        setScopes([]);
        setDraft("");
      }
      const params = new URLSearchParams();
      if (t) params.set("task", t);
      if (id) params.set("run", id);
      router.replace(`/organize${params.size ? `?${params}` : ""}`);
    },
    [router, taskId],
  );

  /** 打开的整理读到了：任务下拉框和范围切到它的（自动整理的新增路径不往范围框里填，那是另一种范围） */
  const syncFromRun = useCallback((run: OrganizeRun) => {
    setTaskId(run.taskId);
    setScopes(run.trigger !== "manual" ? [] : run.scopePaths.length > 0 ? run.scopePaths : run.scopePath ? [run.scopePath] : []);
    setDraft("");
  }, []);

  /** 换任务：正在看的整理属于原来的任务，关掉 */
  const changeTask = (v: string) => {
    setTaskId(v);
    setScopes([]);
    setDraft("");
    if (runId) router.replace(`/organize?${new URLSearchParams({ task: v })}`);
  };

  /** 把输入框里的那条加进范围；不合法返回 null（已经提示过） */
  const takeDraft = (): string[] | null => {
    if (!draft.trim() || !task) return scopes;
    const r = toScope(draft, task.originPath);
    if (!r.ok) {
      toast.error(r.error);
      return null;
    }
    const next = r.path === "" ? [] : addScopes(scopes, [r.path]);
    setScopes(next);
    setDraft("");
    return next;
  };

  const loadUnderOrigin = useCallback(
    (p: string) => (task ? api.directory.remote(task.account, origin ? (p ? `${origin}/${p}` : origin) : p) : Promise.resolve([])),
    [task, origin],
  );

  const createRun = async () => {
    if (!taskId) return;
    const list = takeDraft();
    if (!list) return;
    setCreating(true);
    try {
      const run = await api.organize.createRun(list.length > 1 ? { taskId, paths: list } : { taskId, subPath: list[0] ?? "" });
      openRun(run.id);
      toast.success("开始识别，请稍候");
      notifyOrganizeChanged();
    } catch (err) {
      toastRunError(err, "预览失败", openRun);
    } finally {
      setCreating(false);
    }
  };

  return (
    // relative z-0：RunView 里的海报背景挂在这层里面（自己是 -z-10）。用 z-0 不用 z-10，
    // 这样侧栏（fixed z-10）和顶栏（sticky z-20）还盖在它上面
    <div className="relative z-0 space-y-6">
      <PageHeader
        icon={FolderTree}
        title="整理"
        description={DESCRIPTION}
        actions={
          <>
            <Button variant="outline" onClick={() => setMemoryOpen(true)}>
              <Bookmark className="size-4" />
              识别记忆
            </Button>
            <Button variant="outline" onClick={() => setHistoryOpen(true)} disabled={!taskId}>
              <History className="size-4" />
              历史
            </Button>
          </>
        }
      />

      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">任务</label>
            {tasks === null ? (
              <div className="text-sm text-muted-foreground">加载中…</div>
            ) : tasks.length === 0 ? (
              <div className="text-sm text-muted-foreground">还没有任务，先到「任务」页建一个。</div>
            ) : (
              <Select value={taskId} onValueChange={changeTask}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择任务" />
                </SelectTrigger>
                <SelectContent>
                  {tasks.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {accountLabel(t.account, t.accountType)} · {t.originPath} → {t.targetPath}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">范围（任务目录里的目录，可以多个；不填就是整个任务）</label>
            <InputGroup>
              <InputGroupInput
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    takeDraft();
                  }
                }}
                placeholder={task ? `相对 /${origin} 的路径，回车添加` : ""}
                disabled={!task}
              />
              <InputGroupButton onClick={() => setBrowsing(true)} disabled={!task} title="从任务目录里选（可以多选）">
                <FolderOpen />
              </InputGroupButton>
            </InputGroup>
            {scopes.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {scopes.map((s) => (
                  <span key={s} className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5 text-xs">
                    <span className="break-all">{s}</span>
                    <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setScopes((prev) => prev.filter((x) => x !== s))} aria-label={`去掉 ${s}`}>
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
                {scopes.length > 1 && (
                  <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setScopes([])}>
                    清空
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="flex items-end">
            <Button onClick={() => void createRun()} disabled={!taskId || creating} className="w-full md:w-auto">
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              预览
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">预览只读网盘和 TMDB，不改任何东西；确认清单后点「执行」才会在网盘上改名 / 移动，本地 strm 会跟着走。</p>
      </section>

      {runId ? (
        <RunView key={runId} runId={runId} tasks={tasks} onClose={() => openRun(null)} onOpenRun={openRun} onLoaded={syncFromRun} />
      ) : (
        <>
          <AttentionList tasks={tasks} onOpen={(run) => openRun(run.id, run.taskId)} />
          <EmptyState icon={FolderTree} title="还没有预览" description="选好任务和范围，点「预览」；或者从「历史」里打开之前的整理记录。" />
        </>
      )}

      {task && (
        <TreeSelectDialog
          open={browsing}
          onOpenChange={setBrowsing}
          title="选择范围"
          description={<>从任务目录 /{origin} 里选，可以多选；一个都不选就是整个任务</>}
          load={loadUnderOrigin}
          multiple
          onConfirmMany={(paths) => setScopes((prev) => addScopes(prev, paths.map(trimSlashes)))}
        />
      )}
      <HistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        taskId={taskId}
        onPick={(id) => {
          setHistoryOpen(false);
          openRun(id);
        }}
      />
      <MemoryDialog open={memoryOpen} onOpenChange={setMemoryOpen} />
    </div>
  );
}

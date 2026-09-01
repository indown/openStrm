"use client";

import * as React from "react";
import { useEffect, useMemo, useReducer, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  History,
  Loader2,
  Square,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import type { TaskExecutionHistory } from "@openstrm/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { apiErrorMessage, getToken } from "@/lib/axios";
import {
  applyEvents,
  countFiles,
  createLogState,
  normalizeEvent,
  type FileRow,
  type LogEvent,
  type LogState,
  type RunStatus,
} from "./events";

/** 列表最多渲染最近这么多行：任务动辄几千个文件，全部渲染会把页面拖死 */
const MAX_ROWS = 500;
/** 事件攒一批再渲染：几万个文件时每条事件都 setState 会把页面卡死 */
const FLUSH_MS = 200;
const RECONNECT_MS = 2000;
const MAX_RECONNECTS = 5;

type Connection = "connecting" | "live" | "reconnecting" | "closed" | "history" | "not-running";
type Filter = "all" | "active" | "failed";
type TaskInfo = { originPath: string; targetPath: string; account: string };

type Action = { type: "apply"; events: LogEvent[] } | { type: "reset" };

function reducer(state: LogState, action: Action): LogState {
  if (action.type === "reset") return createLogState();
  return applyEvents(state, action.events);
}

const STATUS_META: Record<RunStatus, { label: string; className: string }> = {
  running: { label: "运行中", className: "bg-blue-100 text-blue-800 hover:bg-blue-100" },
  completed: { label: "已完成", className: "bg-green-100 text-green-800 hover:bg-green-100" },
  failed: { label: "失败", className: "bg-red-100 text-red-800 hover:bg-red-100" },
  cancelled: { label: "已取消", className: "bg-yellow-100 text-yellow-800 hover:bg-yellow-100" },
};

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: "连接中…",
  live: "实时",
  reconnecting: "连接断了，重连中…",
  closed: "连接已关闭",
  history: "历史记录",
  "not-running": "任务未运行",
};

function fmtTime(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

/**
 * 静态导出没有运行时的动态路由段，任务 id 和执行记录 id 都走查询串：
 * /log?taskId=…（实时）或 /log?taskId=…&executionId=…（历史）。
 * useSearchParams 在静态渲染时必须包在 Suspense 里，否则 next build 直接报错。
 */
export default function LogPage() {
  return (
    <React.Suspense fallback={<div className="p-6 text-muted-foreground">加载中...</div>}>
      <LogRouter />
    </React.Suspense>
  );
}

function LogRouter() {
  const search = useSearchParams();
  const taskId = search.get("taskId") ?? "";
  const executionId = search.get("executionId") ?? undefined;
  if (!taskId) return <div className="p-6 text-muted-foreground">缺少 taskId 参数</div>;
  // 参数变了整个视图重来，省得在效果里处理"半路换任务"
  return <TaskLogView key={`${taskId}:${executionId ?? ""}`} taskId={taskId} executionId={executionId} />;
}

function TaskLogView({ taskId, executionId }: { taskId: string; executionId?: string }) {
  const router = useRouter();
  const [state, dispatch] = useReducer(reducer, undefined, createLogState);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [taskInfo, setTaskInfo] = useState<TaskInfo | null>(null);
  const [execution, setExecution] = useState<TaskExecutionHistory | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // 任务路径：实时模式从任务列表里找；历史模式用记录里存的（任务可能已经删了）
  useEffect(() => {
    if (executionId) return;
    let cancelled = false;
    api.tasks
      .list()
      .then((rows) => {
        if (cancelled) return;
        const t = rows.find((r) => r.id === taskId);
        if (t) setTaskInfo({ originPath: t.originPath, targetPath: t.targetPath, account: t.account });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [taskId, executionId]);

  // 历史模式：一次取回记录（带日志行），按路径归并
  useEffect(() => {
    if (!executionId) return;
    let cancelled = false;
    (async () => {
      try {
        const ex = await api.history.get(executionId);
        if (cancelled) return;
        // 记录还在跑（从历史页点进来的）：改看实时
        if (ex.status === "running") {
          router.replace(`/log?taskId=${encodeURIComponent(taskId)}`);
          return;
        }
        setExecution(ex);
        setTaskInfo({ originPath: ex.taskInfo.originPath, targetPath: ex.taskInfo.targetPath, account: ex.taskInfo.account });
        const events = ex.logs.map(normalizeEvent).filter((e): e is LogEvent => e !== null);
        // 旧记录没有开始事件：总数和开始时间从记录本身补
        if (!events.some((e) => e.type === "start")) {
          events.unshift({ type: "start", total: ex.summary.totalFiles, strmTotal: 0, downloadTotal: 0, at: ex.startTime });
        }
        // 记录本身的结论优先于日志行：旧记录可能没有结束事件，启动阶段失败的记录一行日志都没有
        events.push({
          type: "done",
          status: ex.status,
          finished: ex.summary.downloadedFiles,
          failed: ex.summary.failedFiles ?? null,
          total: ex.summary.totalFiles,
          overall: null,
          message: ex.summary.errorMessage ?? null,
          at: ex.endTime ?? null,
        });
        dispatch({ type: "reset" });
        dispatch({ type: "apply", events });
        setConnection("history");
      } catch (err) {
        if (cancelled) return;
        const status = (err as { response?: { status?: number } } | null)?.response?.status;
        setConnection(status === 404 ? "not-running" : "closed");
        toast.error(status === 404 ? "这条执行记录不存在" : apiErrorMessage(err, "加载执行记录失败"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, executionId, router]);

  // 实时模式：SSE，断了自动重连；任务没在跑就跳到最近一次执行记录
  useEffect(() => {
    if (executionId) return;
    let cancelled = false;
    let controller: AbortController | null = null;
    const pending: LogEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (pending.length === 0) return;
      dispatch({ type: "apply", events: pending.splice(0) });
    };
    const queue = (ev: LogEvent) => {
      pending.push(ev);
      if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    (async () => {
      let attempts = 0;
      while (!cancelled) {
        controller = new AbortController();
        setConnection(attempts === 0 ? "connecting" : "reconnecting");
        let finished = false;
        try {
          const res = await fetch(`/api/taskLog/${encodeURIComponent(taskId)}`, {
            headers: { Accept: "text/event-stream", Authorization: `Bearer ${getToken() ?? ""}` },
            signal: controller.signal,
          });
          if (res.status === 404) {
            // 没在跑：有历史就看最近一次，让 /log?taskId= 永远有东西可看
            const list = await api.history.list(taskId).catch(() => []);
            if (cancelled) return;
            if (list[0]) {
              router.replace(`/log?taskId=${encodeURIComponent(taskId)}&executionId=${encodeURIComponent(list[0].id)}`);
              return;
            }
            setConnection("not-running");
            return;
          }
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          setConnection("live");
          // 服务端每次连上都把已有日志整个回放一遍：先清掉再合并，重连不会重复
          dispatch({ type: "reset" });
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue; // 心跳是注释行
              const ev = normalizeEvent(line.slice(6));
              if (!ev) continue;
              queue(ev);
              if (ev.type === "done") finished = true;
            }
          }
          flush();
        } catch (err) {
          if (cancelled || controller.signal.aborted) return;
          console.error("task log stream error", err);
        }
        if (cancelled) return;
        if (finished) {
          setConnection("closed");
          return;
        }
        // 流没带结束事件就断了：多半是反代掐了空闲连接，任务还在跑；重连几次
        attempts += 1;
        if (attempts > MAX_RECONNECTS) {
          setConnection("closed");
          return;
        }
        await sleep(RECONNECT_MS);
      }
    })();

    return () => {
      cancelled = true;
      controller?.abort();
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [taskId, executionId, router]);

  // 用时每秒走一下
  const running = state.status === "running" && connection !== "history" && connection !== "not-running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const cancelTask = async () => {
    setCancelling(true);
    try {
      await api.tasks.cancel(taskId);
      toast.success("已发出取消");
    } catch (err) {
      toast.error(apiErrorMessage(err, "取消任务失败"));
    } finally {
      setCancelling(false);
    }
  };

  const counts = useMemo(() => countFiles(state), [state]);
  const startedAt = state.startedAt ?? execution?.startTime ?? null;
  const endedAt = state.endedAt ?? execution?.endTime ?? null;
  const duration = startedAt ? (endedAt ?? now) - startedAt : null;
  const kindKnown = (state.strmTotal ?? 0) + (state.downloadTotal ?? 0) > 0;

  const rows = useMemo(() => {
    const all = [...state.files.values()];
    const picked =
      filter === "failed"
        ? all.filter((f) => f.error)
        : filter === "active"
          ? all.filter((f) => !f.error && f.percent < 100)
          : all;
    return picked.slice(-MAX_ROWS).reverse();
  }, [state.files, filter]);

  const statusMeta = connection === "not-running" ? null : STATUS_META[state.status];
  const title = taskInfo?.originPath || `任务 ${taskId.slice(0, 8)}…`;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 space-y-1">
          <Link href="/home" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3 w-3" />
            返回任务列表
          </Link>
          <h1 className="text-xl font-semibold break-all" title={taskId}>
            {title}
          </h1>
          {taskInfo && (
            <p className="text-sm text-muted-foreground break-all">
              → {taskInfo.targetPath} · 账户 {taskInfo.account}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {statusMeta ? (
            <Badge className={`border-0 ${statusMeta.className}`}>
              {running && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              {state.starting ? "启动中" : statusMeta.label}
            </Badge>
          ) : (
            <Badge variant="outline">未运行</Badge>
          )}
          {running && state.starting && <span className="text-xs text-muted-foreground">读取目录阶段暂不能取消</span>}
          {running && !state.starting && (
            <Button variant="destructive" size="sm" onClick={cancelTask} disabled={cancelling}>
              {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
              <span className="ml-1">取消任务</span>
            </Button>
          )}
          <Button variant="outline" size="sm" asChild>
            <Link href={`/history?taskId=${encodeURIComponent(taskId)}`}>
              <History className="h-4 w-4" />
              <span className="ml-1">执行历史</span>
            </Link>
          </Button>
        </div>
      </div>

      {connection === "not-running" ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          这个任务没在运行，也还没有执行记录。到任务列表点「开始」跑一次。
        </div>
      ) : (
        <>
          <div className="rounded-lg border p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:grid-cols-7">
              <Stat label="总文件" value={counts.total ?? "—"} hint={kindKnown ? `strm ${state.strmTotal} · 下载 ${state.downloadTotal}` : undefined} />
              <Stat label="已完成" value={counts.done} />
              <Stat label="失败" value={counts.failed} tone={counts.failed > 0 ? "bad" : undefined} />
              <Stat label="进行中" value={counts.active} />
              <Stat label="未开始" value={counts.pending ?? "—"} />
              <Stat label="用时" value={duration != null ? fmtDuration(duration) : "—"} hint={startedAt ? `开始于 ${fmtTime(startedAt)}` : undefined} />
              <Stat label="连接" value={CONNECTION_LABEL[connection]} tone={connection === "reconnecting" ? "warn" : undefined} />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>总进度</span>
                <span className="font-medium text-foreground">{counts.percent.toFixed(2)}%</span>
              </div>
              <div className="h-2 rounded bg-muted overflow-hidden">
                <div
                  className={`h-full transition-[width] duration-300 ${
                    state.status === "failed" ? "bg-destructive" : state.status === "cancelled" ? "bg-yellow-500" : "bg-primary"
                  }`}
                  style={{ width: `${Math.min(100, counts.percent)}%` }}
                />
              </div>
            </div>
            {execution && execution.summary.deletedFiles > 0 && (
              <p className="text-xs text-muted-foreground">这次同步清理了 {execution.summary.deletedFiles} 个本地多余文件</p>
            )}
          </div>

          {state.fatalError && (
            <Banner tone="bad" icon={<XCircle className="h-4 w-4" />}>
              任务出错：{state.fatalError}
            </Banner>
          )}
          {!state.fatalError && state.status === "failed" && state.finalMessage && (
            <Banner tone="bad" icon={<AlertTriangle className="h-4 w-4" />}>
              {state.finalMessage}
              {counts.failed > 0 && (
                <button type="button" className="ml-2 underline" onClick={() => setFilter("failed")}>
                  只看失败的
                </button>
              )}
            </Banner>
          )}
          {state.status === "cancelled" && (
            <Banner tone="warn" icon={<Square className="h-4 w-4" />}>
              {state.finalMessage ?? "任务已取消"}
            </Banner>
          )}
          {/* 启动阶段就结束的"无事可做"：正常跑完的结束事件不带 message */}
          {state.status === "completed" && state.finalMessage && (
            <Banner tone="info" icon={<CheckCircle2 className="h-4 w-4" />}>
              {state.finalMessage}
            </Banner>
          )}

          <div className="rounded-lg border overflow-hidden">
            <div className="flex items-center gap-1 border-b bg-muted/40 px-3 py-2 text-xs">
              <FilterTab active={filter === "all"} onClick={() => setFilter("all")}>
                全部 {state.files.size}
              </FilterTab>
              <FilterTab active={filter === "active"} onClick={() => setFilter("active")}>
                进行中 {counts.active}
              </FilterTab>
              <FilterTab active={filter === "failed"} onClick={() => setFilter("failed")}>
                失败 {counts.failed}
              </FilterTab>
              {state.files.size > MAX_ROWS && (
                <span className="ml-auto text-muted-foreground">只显示最近 {MAX_ROWS} 条</span>
              )}
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {rows.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  {connection === "connecting"
                    ? "连接中…"
                    : filter !== "all"
                      ? "没有这一类的文件"
                      : connection === "history"
                        ? "这条记录没有文件级日志"
                        : state.starting
                          ? (
                            <span className="inline-flex items-center gap-2">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              正在读取远端目录，拿到文件清单后开始处理…
                            </span>
                          )
                          : "还没有文件开始处理"}
                </div>
              ) : (
                rows.map((f) => <FileLine key={f.path} file={f} running={running} />)
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: "bad" | "warn" }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`font-medium truncate ${tone === "bad" ? "text-destructive" : tone === "warn" ? "text-yellow-700" : ""}`} title={hint}>
        {value}
      </div>
      {hint && <div className="text-[11px] text-muted-foreground truncate">{hint}</div>}
    </div>
  );
}

function Banner({ tone, icon, children }: { tone: "bad" | "warn" | "info"; icon: React.ReactNode; children: React.ReactNode }) {
  const cls =
    tone === "bad"
      ? "border-destructive/40 bg-destructive/5 text-destructive"
      : tone === "warn"
        ? "border-yellow-300 bg-yellow-50 text-yellow-800"
        : "border-border bg-muted/40 text-muted-foreground";
  return (
    <div className={`flex items-start gap-2 rounded-md border p-3 text-sm break-all ${cls}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div>{children}</div>
    </div>
  );
}

function FilterTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-1 ${active ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

function FileLine({ file, running }: { file: FileRow; running: boolean }) {
  const failed = Boolean(file.error);
  const done = !failed && file.percent >= 100;
  // 任务已经结束（取消 / 出错）时还没到 100% 的文件不会再动了，别让它一直转圈
  const interrupted = !failed && !done && !running;
  return (
    <div className="flex items-center gap-3 border-b px-4 py-2 last:border-b-0">
      <span className="shrink-0">
        {failed ? (
          <XCircle className="h-4 w-4 text-destructive" />
        ) : done ? (
          <CheckCircle2 className="h-4 w-4 text-green-600" />
        ) : interrupted ? (
          <Square className="h-4 w-4 text-muted-foreground" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm break-all">{file.path}</div>
        {file.error && <div className="text-xs text-destructive break-all">{file.error}</div>}
      </div>
      {file.kind !== "unknown" && (
        <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0 font-normal text-muted-foreground">
          {file.kind === "strm" ? "strm" : "下载"}
        </Badge>
      )}
      <div className="w-28 shrink-0 text-right text-xs">
        {failed ? (
          <span className="text-destructive">失败</span>
        ) : done ? (
          <span className="text-muted-foreground">完成</span>
        ) : interrupted ? (
          <span className="text-muted-foreground">中断于 {Math.floor(file.percent)}%</span>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <div className="h-1.5 w-16 rounded bg-muted overflow-hidden">
              <div className="h-full bg-blue-600" style={{ width: `${file.percent}%` }} />
            </div>
            <span className="w-9 text-muted-foreground tabular-nums">{Math.floor(file.percent)}%</span>
          </div>
        )}
      </div>
    </div>
  );
}


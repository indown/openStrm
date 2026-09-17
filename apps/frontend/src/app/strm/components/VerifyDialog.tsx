"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { StrmVerifyProgress, StrmVerifyResult } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/empty-state";
import { ProgressBar } from "@/components/progress-bar";
import { StatusBadge } from "@/components/status-badge";
import { api } from "@/lib/api";
import { PARSE_REASON_LABEL, baseName, strmErrorMessage, type RequestDelete } from "@/lib/strm";

type Phase = "idle" | "running" | "done" | "error";
type Missing = StrmVerifyResult["missing"][number];

/** 缺失项可能上千，列表只铺这么多行（「删除全部缺失」删的还是全部） */
const LIST_CAP = 300;

const PHASE_LABEL: Record<StrmVerifyProgress["phase"], string> = {
  collect: "收集本地 strm",
  read: "读取 strm",
  remote: "到网盘确认",
};

type Props = {
  /** 要校验的目录或文件；null = 关着 */
  target: string | null;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  onDelete: RequestDelete;
};

/** 逐个到网盘确认 strm 指向的文件还在不在；缺失的可以就地删掉 */
export function VerifyDialog({ target, onOpenChange, taskId, onDelete }: Props) {
  const open = target != null;
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<StrmVerifyResult | null>(null);
  // 删掉之后从清单里划掉，所以单独存一份
  const [missing, setMissing] = useState<Missing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [progress, setProgress] = useState<StrmVerifyProgress | null>(null);
  /** 在跑的那一轮：关弹框、离开页面、点「停止」都靠它掐断，后端那边跟着停 */
  const abortRef = useRef<AbortController | null>(null);

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  useEffect(() => {
    if (!open) return;
    setPhase("idle");
    setResult(null);
    setMissing([]);
    setError(null);
    setProgress(null);
  }, [open, target]);

  // 弹框关掉 / 组件卸载：别把校验留在后台接着打网盘
  useEffect(() => {
    if (!open) cancel();
  }, [open]);
  useEffect(() => cancel, []);

  const start = async () => {
    if (target == null) return;
    cancel();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("running");
    setError(null);
    setProgress(null);
    // 收在一个对象里：闭包里赋值的局部变量，类型收窄会跟着乱
    const outcome: { result?: StrmVerifyResult; error?: string } = {};
    try {
      await api.strm.verifyStream(taskId, target, {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "progress") setProgress(event.progress);
          else if (event.type === "done") outcome.result = event.result;
          else outcome.error = event.message;
        },
      });
    } catch (err) {
      // 自己点的「停止」不算失败
      if (controller.signal.aborted) return;
      outcome.error = strmErrorMessage(err, "校验失败");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
    if (controller.signal.aborted) return;
    if (outcome.result) {
      const res = outcome.result;
      setResult(res);
      setMissing(res.missing);
      setPhase("done");
      toast.success(res.missing.length > 0 ? `校验完成：${res.missing.length} 个缺失` : "校验完成：全部存在");
      return;
    }
    // 流断在半路却没有结论：多半是反代掐了连接
    const msg = outcome.error ?? "校验没有给出结论，连接可能被中断了，请重试";
    setError(msg);
    setPhase("error");
    toast.error(msg);
  };

  const stop = () => {
    cancel();
    setPhase("idle");
    setProgress(null);
  };

  const removeMissing = async (paths: string[]) => {
    setRemoving(true);
    try {
      const res = await onDelete(paths, paths.length === 1 ? `「${baseName(paths[0])}」` : `网盘上已不存在的 ${paths.length} 个 strm`);
      if (!res) return;
      const failed = new Set(res.failed.map((f) => f.path));
      const removed = new Set(paths.filter((p) => !failed.has(p)));
      setMissing((prev) => prev.filter((m) => !removed.has(m.path)));
    } finally {
      setRemoving(false);
    }
  };

  const running = phase === "running";

  return (
    // 跑着的时候 Esc / 点外面不关：一轮大目录校验要几分钟，手滑关掉就白跑了，要停得按「停止校验」
    <Dialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <DialogContent size="lg" className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle>校验网盘路径</DialogTitle>
          <DialogDescription className="break-all">范围：{target ? target : "整个任务目录"}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {phase === "idle" && (
            <p className="text-sm text-muted-foreground">
              会到网盘确认 strm 指向的文件还在不在。目录少时逐个目录问，目录多时改成一次读取整棵目录树再比对，大库可能要几分钟——过程中有进度，随时可以停。
            </p>
          )}
          {running && (
            <div className="space-y-2 py-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span>{progress ? PHASE_LABEL[progress.phase] : "准备中"}</span>
                <span className="tabular-nums text-muted-foreground">
                  {progress && progress.total > 0 ? `${progress.done} / ${progress.total}` : "…"}
                </span>
              </div>
              <ProgressBar
                percent={progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0}
                indeterminate={!progress || progress.total === 0}
                running
                size="md"
              />
              <p className="text-xs text-muted-foreground">{progress?.message ?? "正在准备…"}</p>
            </div>
          )}
          {phase === "error" && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>没能完成</AlertTitle>
              <AlertDescription className="break-all">{error}</AlertDescription>
            </Alert>
          )}
          {phase === "done" && result && (
            <>
              <p className="text-sm tabular-nums">
                检查了 {result.checked} 个 strm、{result.dirs} 个网盘目录。
              </p>
              {missing.length === 0 ? (
                <EmptyState className="py-8" icon={CheckCircle2} title="全部存在" description="这些 strm 指向的文件都还在网盘上。" />
              ) : (
                <div className="overflow-hidden rounded-xl border">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2 text-xs">
                    <span className="tabular-nums">网盘上已不存在（{missing.length}）</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-destructive hover:text-destructive"
                      onClick={() => void removeMissing(missing.map((m) => m.path))}
                      disabled={removing}
                    >
                      <Trash2 className="size-3.5" />
                      删除全部缺失（{missing.length}）
                    </Button>
                  </div>
                  <div className="max-h-[40vh] divide-y overflow-y-auto">
                    {missing.slice(0, LIST_CAP).map((m) => (
                      <div key={m.path} className="flex items-start gap-2 px-3 py-2">
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="break-all font-mono text-xs">{m.path}</div>
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusBadge tone="danger">{m.reason === "dir-missing" ? "整个目录不在了" : "文件不在了"}</StatusBadge>
                            <span className="break-all text-xs text-muted-foreground">{m.remotePath}</span>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0 text-destructive hover:text-destructive"
                          title="删除"
                          onClick={() => void removeMissing([m.path])}
                          disabled={removing}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                    {missing.length > LIST_CAP && (
                      <p className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                        还有 {missing.length - LIST_CAP} 个没列出来，「删除全部缺失」会一起删。
                      </p>
                    )}
                  </div>
                </div>
              )}
              {result.unparsable.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  <p className="tabular-nums">{result.unparsable.length} 个无法解析出网盘路径，没有校验（用「修正内容」或「重新生成」处理）：</p>
                  <ul className="mt-0.5 space-y-0.5 font-mono">
                    {result.unparsable.slice(0, 5).map((u) => (
                      <li key={u.path} className="break-all">
                        {u.path}
                        <span className="font-sans">（{PARSE_REASON_LABEL[u.reason]}）</span>
                      </li>
                    ))}
                    {result.unparsable.length > 5 && <li className="font-sans">…等 {result.unparsable.length} 个</li>}
                  </ul>
                </div>
              )}
              {result.errors.length > 0 && (
                <div className="text-xs text-destructive">
                  <p className="tabular-nums">{result.errors.length} 个网盘目录没查成功，里面的文件既不算缺失也不算存在：</p>
                  <ul className="mt-0.5 space-y-0.5">
                    {result.errors.slice(0, 5).map((e) => (
                      <li key={e.remoteDir} className="break-all">
                        <span className="font-mono">{e.remoteDir}</span>：{e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {result.note && <p className="text-xs text-muted-foreground">{result.note}</p>}
            </>
          )}
        </div>
        <DialogFooter className="gap-2">
          {phase === "idle" || phase === "error" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button onClick={() => void start()}>
                <ShieldCheck className="size-4" />
                {phase === "error" ? "重试" : "开始校验"}
              </Button>
            </>
          ) : running ? (
            <Button variant="outline" onClick={stop}>
              <XCircle className="size-4" />
              停止校验
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

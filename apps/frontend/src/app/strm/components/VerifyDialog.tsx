"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { StrmVerifyResult } from "@openstrm/shared";
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
import { Spinner } from "@/components/loading";
import { StatusBadge } from "@/components/status-badge";
import { api } from "@/lib/api";
import { PARSE_REASON_LABEL, baseName, strmErrorMessage, type RequestDelete } from "@/lib/strm";

type Phase = "idle" | "running" | "done" | "error";
type Missing = StrmVerifyResult["missing"][number];

type Props = {
  /** 要校验的目录或文件；null = 关着 */
  target: string | null;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  onDelete: RequestDelete;
};

/** 逐个到 115 确认 strm 指向的文件还在不在；缺失的可以就地删掉 */
export function VerifyDialog({ target, onOpenChange, taskId, onDelete }: Props) {
  const open = target != null;
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<StrmVerifyResult | null>(null);
  // 删掉之后从清单里划掉，所以单独存一份
  const [missing, setMissing] = useState<Missing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPhase("idle");
    setResult(null);
    setMissing([]);
    setError(null);
  }, [open, target]);

  const start = async () => {
    if (target == null) return;
    setPhase("running");
    setError(null);
    try {
      const res = await api.strm.verify(taskId, target);
      setResult(res);
      setMissing(res.missing);
      setPhase("done");
      toast.success(res.missing.length > 0 ? `校验完成：${res.missing.length} 个缺失` : "校验完成：全部存在");
    } catch (err) {
      const msg = strmErrorMessage(err, "校验失败");
      setError(msg);
      setPhase("error");
      toast.error(msg);
    }
  };

  const removeMissing = async (paths: string[]) => {
    setRemoving(true);
    try {
      const res = await onDelete(paths, paths.length === 1 ? `「${baseName(paths[0])}」` : `115 上已不存在的 ${paths.length} 个 strm`);
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
    <Dialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>校验网盘路径</DialogTitle>
          <DialogDescription className="break-all">范围：{target ? target : "整个任务目录"}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {phase === "idle" && (
            <p className="text-sm text-muted-foreground">
              会逐个到 115 确认 strm 指向的文件还在不在。目录大时要两三分钟；115 的目录缓存可能有几分钟延迟，刚转存或刚删除的文件可能误报。范围太大时会被拒绝，进更小的子目录再试。
            </p>
          )}
          {running && <Spinner label="正在向 115 逐个确认，请不要关闭页面…" />}
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
                <EmptyState className="py-8" icon={CheckCircle2} title="全部存在" description="这些 strm 指向的文件都还在 115 上。" />
              ) : (
                <div className="overflow-hidden rounded-xl border">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2 text-xs">
                    <span className="tabular-nums">115 上已不存在（{missing.length}）</span>
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
                    {missing.map((m) => (
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
                  </div>
                </div>
              )}
              {result.unparsable.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  <p className="tabular-nums">{result.unparsable.length} 个无法解析出 115 路径，没有校验（用「修正内容」或「重新生成」处理）：</p>
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
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
              {running ? <Loader2 className="size-4 animate-spin" /> : null}
              {running ? "校验中…" : "关闭"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

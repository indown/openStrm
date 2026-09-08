"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { StrmRewriteResult } from "@openstrm/shared";
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
import { Spinner } from "@/components/loading";
import { api } from "@/lib/api";
import { PARSE_REASON_LABEL, strmErrorMessage } from "@/lib/strm";

type Phase = "previewing" | "preview" | "applying" | "done" | "error";

type Props = {
  /** 要修正的目录（"" 是整个任务目录）；null = 关着 */
  target: string | null;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  onDone: () => void;
};

function Summary({ r }: { r: StrmRewriteResult }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="tabular-nums">
        检查 {r.checked} 个 strm，{r.dryRun ? `${r.changed} 个需要修正` : `已修正 ${r.changed} 个`}
        {r.foreign > 0 && `；跳过属于其它任务的 ${r.foreign} 个`}
      </p>
      {r.skippedRoots.length > 0 && (
        <p className="break-all text-xs text-muted-foreground">跳过了其它任务的输出目录：{r.skippedRoots.join("、")}</p>
      )}
      {r.unparsable.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <p className="tabular-nums">{r.unparsable.length} 个无法解析、不会重写（可用「重新生成」按 115 目录重建）：</p>
          <ul className="mt-0.5 space-y-0.5 font-mono">
            {r.unparsable.slice(0, 3).map((u) => (
              <li key={u.path} className="break-all">
                {u.path}
                <span className="font-sans">（{PARSE_REASON_LABEL[u.reason]}）</span>
              </li>
            ))}
            {r.unparsable.length > 3 && <li className="font-sans">…等 {r.unparsable.length} 个</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 批量修正 strm 内容：打开先预检（不落盘）给个预览，确认后再写 */
export function RewriteDialog({ target, onOpenChange, taskId, onDone }: Props) {
  const open = target != null;
  const [phase, setPhase] = useState<Phase>("previewing");
  const [preview, setPreview] = useState<StrmRewriteResult | null>(null);
  const [result, setResult] = useState<StrmRewriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || target == null || !taskId) return;
    let cancelled = false;
    setPhase("previewing");
    setPreview(null);
    setResult(null);
    setError(null);
    api.strm
      .rewrite(taskId, target, true)
      .then((res) => {
        if (cancelled) return;
        setPreview(res);
        setPhase("preview");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(strmErrorMessage(err, "预检失败"));
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [open, target, taskId]);

  const apply = async () => {
    if (target == null) return;
    setPhase("applying");
    try {
      const res = await api.strm.rewrite(taskId, target, false);
      setResult(res);
      setPhase("done");
      toast.success(`已修正 ${res.changed} 个 strm`);
      onDone();
    } catch (err) {
      const msg = strmErrorMessage(err, "修正失败");
      setError(msg);
      setPhase("error");
      toast.error(msg);
    }
  };

  const busy = phase === "previewing" || phase === "applying";
  const changed = preview?.changed ?? 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>修正 strm 内容</DialogTitle>
          <DialogDescription className="break-all">
            按任务现在的 strmPrefix / 网盘路径 / 编码设置重写 {target ? `「${target}」` : "整个任务目录"} 下内容对不上的 strm。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {phase === "previewing" && <Spinner label="正在预检，大目录要一会…" />}
          {phase === "error" && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>没能完成</AlertTitle>
              <AlertDescription className="break-all">{error}</AlertDescription>
            </Alert>
          )}
          {(phase === "preview" || phase === "applying") && preview && (
            <div className="space-y-3">
              <Summary r={preview} />
              {preview.samples.length > 0 && (
                <div className="overflow-hidden rounded-xl border">
                  <div className="border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    改动预览（前 {preview.samples.length} 条）
                  </div>
                  <div className="max-h-[40vh] divide-y overflow-y-auto">
                    {preview.samples.map((s) => (
                      <div key={s.path} className="space-y-0.5 px-3 py-2 text-xs">
                        <div className="break-all font-mono">{s.path}</div>
                        <div className="break-all text-muted-foreground">{s.from || "（空）"}</div>
                        <div className="break-all">→ {s.to}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {phase === "applying" && <p className="text-xs text-muted-foreground">正在写入，可能需要一会，请不要关闭页面。</p>}
            </div>
          )}
          {phase === "done" && result && <Summary r={result} />}
        </div>
        <DialogFooter className="gap-2">
          {phase === "done" || phase === "error" ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                取消
              </Button>
              <Button onClick={() => void apply()} disabled={busy || changed === 0}>
                {phase === "applying" && <Loader2 className="size-4 animate-spin" />}
                {phase === "applying" ? "修正中…" : `修正 ${changed} 个文件`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

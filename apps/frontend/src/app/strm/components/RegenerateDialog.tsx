"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2, RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import type { StrmRegenerateMode, StrmRegenerateResult } from "@openstrm/shared";
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
import { api } from "@/lib/api";
import { strmErrorMessage } from "@/lib/strm";

type Props = {
  /** 要重新生成的目录；null = 关着 */
  target: string | null;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  /** 任务正在同步：先别动 */
  syncing: boolean;
  onDone: () => void;
};

const MODES: Array<{ value: StrmRegenerateMode; label: string; hint: string }> = [
  { value: "fill", label: "补齐", hint: "只生成缺少的 strm，已有的不动" },
  { value: "rebuild", label: "重建", hint: "按 115 现在的目录重新生成，本地多出来的 strm 会被删掉；字幕 / nfo 等附件不动" },
];

/** 按对应的 115 目录重新导出并生成 strm；根目录不给做（请直接跑同步任务） */
export function RegenerateDialog({ target, onOpenChange, taskId, syncing, onDone }: Props) {
  const open = target != null;
  const [mode, setMode] = useState<StrmRegenerateMode>("fill");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<StrmRegenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode("fill");
    setResult(null);
    setError(null);
  }, [open, target]);

  const isRoot = target === "";
  const blocked = isRoot || syncing;

  const run = async () => {
    if (target == null || blocked) return;
    setRunning(true);
    setError(null);
    try {
      const res = await api.strm.regenerate(taskId, target, mode);
      setResult(res);
      toast.success(`重新生成完成：生成 ${res.generated}、跳过 ${res.skipped}、删除 ${res.removed}`);
      onDone();
    } catch (err) {
      const msg = strmErrorMessage(err, "重新生成失败");
      setError(msg);
      toast.error(msg);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>重新生成 strm</DialogTitle>
          <DialogDescription className="break-all">读取 115 上对应的目录，{target ? `重新生成「${target}」` : "重新生成"}下的 strm。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {isRoot && <p className="text-sm text-warning">根目录请直接运行同步任务。</p>}
          {!isRoot && syncing && <p className="text-sm text-warning">任务正在同步，等它跑完再试。</p>}
          <div className="space-y-2">
            {MODES.map((m) => (
              <label
                key={m.value}
                className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-brand has-[:checked]:bg-brand/5"
              >
                <input
                  type="radio"
                  name="regen-mode"
                  className="mt-1 accent-brand"
                  checked={mode === m.value}
                  onChange={() => setMode(m.value)}
                  disabled={running || result != null}
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{m.label}</div>
                  <div className="text-xs text-muted-foreground">{m.hint}</div>
                </div>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">会读取 115 目录，最长可能等 5 分钟；请不要关闭页面。</p>
          {running && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              正在导出目录并生成…
            </p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>没能完成</AlertTitle>
              <AlertDescription className="break-all">{error}</AlertDescription>
            </Alert>
          )}
          {result && (
            <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm tabular-nums">
              读到 {result.remoteFiles} 个文件：生成 {result.generated}、跳过 {result.skipped}、删除 {result.removed}
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          {result ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
                取消
              </Button>
              <Button onClick={() => void run()} disabled={blocked || running}>
                {running ? <Loader2 className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
                {running ? "生成中…" : "开始"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

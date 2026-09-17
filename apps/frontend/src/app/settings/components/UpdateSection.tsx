"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { UpdateSettings, UpdateStatus } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { SwitchRow } from "@/components/switch-row";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { FieldHint } from "@/components/field-hint";
import { api } from "@/lib/api";
import { fmtWhen } from "@/lib/format";
import { checkForUpdate } from "@/lib/update";

const UPGRADE_CMD = "docker compose pull && docker compose up -d";

/** 状态一句话：关着 / 没查过 / 查不上 / 有新版本 / 已是最新 */
function statusOf(s: UpdateStatus | null): { label: string; tone: StatusTone; hint: string } {
  if (!s) return { label: "读取中", tone: "neutral", hint: "" };
  if (s.outdated) return { label: `有新版本 ${s.state.latest?.version}`, tone: "brand", hint: "" };
  if (!s.state.ok && s.state.error) return { label: "检查不上", tone: "warning", hint: s.state.error };
  if (s.state.checkedAt === 0) return { label: s.enabled ? "还没查过" : "没有检查过", tone: "neutral", hint: "" };
  return { label: "已是最新", tone: "success", hint: "" };
}

/** 设置页的「更新」一节：当前版本、最新版本、更新说明、立即检查、两个开关 */
export function UpdateSection({ value, onChange }: { value: UpdateSettings; onChange: (next: UpdateSettings) => void }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.update
      .get()
      .then(setStatus)
      .catch(() => {
        /* 读不到就只显示设置，别打扰 */
      });
  }, []);

  const check = async () => {
    setChecking(true);
    // 提示和角标通知都在 checkForUpdate 里，这里只管把状态接下来（失败时它回 null，保留原来那份）
    const next = await checkForUpdate();
    if (next) setStatus(next);
    setChecking(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(UPGRADE_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("复制失败，手动选中复制吧");
    }
  };

  const s = statusOf(status);
  const latest = status?.state.latest;
  return (
    <section id="update" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium">更新</h2>
        <StatusBadge tone={s.tone} title={s.hint || undefined}>
          {s.label}
        </StatusBadge>
        <span className="text-xs text-muted-foreground tabular-nums">
          当前 v{status?.current ?? "…"}
          {status && status.state.checkedAt > 0 ? ` · 上次检查 ${fmtWhen(status.state.checkedAt * 1000)}` : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void check()} disabled={checking}>
            {checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            立即检查
          </Button>
          {latest && (
            <Button variant="ghost" size="sm" asChild>
              <a href={latest.url} target="_blank" rel="noreferrer">
                发布页
                <ExternalLink className="size-4" />
              </a>
            </Button>
          )}
        </div>
      </div>

      {status?.outdated && latest && (
        <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
          <div className="flex flex-wrap items-baseline gap-2 text-sm">
            <span className="font-medium">
              v{status.current} → v{latest.version}
            </span>
            {latest.prerelease && <StatusBadge tone="warning">预发布</StatusBadge>}
            <span className="text-xs text-muted-foreground">{latest.publishedAt ? fmtWhen(latest.publishedAt * 1000) + "发布" : ""}</span>
          </div>
          {latest.notes && <pre className="max-h-60 overflow-auto rounded bg-background p-2 text-xs whitespace-pre-wrap">{latest.notes}</pre>}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>升级：</span>
            <code className="rounded bg-background px-1.5 py-0.5 font-mono">{UPGRADE_CMD}</code>
            <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => void copy()} title="复制命令">
              {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
            </Button>
            <span>升级前先在设置页点一次「下载备份」。</span>
          </div>
        </div>
      )}

      {status && !status.state.ok && status.state.error && (
        <p className="break-all text-xs text-warning">连不上 GitHub（国内网络常见，不影响使用）：{status.state.error}</p>
      )}

      <div className="space-y-2">
        <SwitchRow
          label="自动检查更新"
          description="每天一次"
          checked={value.enabled === true}
          onCheckedChange={(v) => onChange({ ...value, enabled: v })}
        />
        <SwitchRow
          label="包含预发布版本"
          description="rc 版本也算新版本"
          checked={value.includePrerelease === true}
          onCheckedChange={(v) => onChange({ ...value, includePrerelease: v })}
        />
        <p className="text-xs text-muted-foreground">
          装上不会主动联网，检查也不带任何账号信息
          <FieldHint label="检查更新做了什么">
            默认不自动检查。检查只向 GitHub 发一个匿名请求（看最新发布的版本号和说明），不带账号、路径或任何统计。
            「立即检查」是你自己按的，开关关着也能用。跑 rc 版本时会自动和 rc 比。
          </FieldHint>
        </p>
      </div>
    </section>
  );
}

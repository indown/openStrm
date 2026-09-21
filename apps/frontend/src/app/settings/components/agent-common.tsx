"use client";

/**
 * 智能体接入两块（令牌、网页客户端）共用的：权限预设、档位和工具集的叫法、复制按钮。
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import type { AgentScope, AgentToolset } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";

/** 权限预设：档位是集合，界面上只给三个常用组合 */
export const PRESETS: Array<{ id: string; label: string; scopes: AgentScope[]; hint: string }> = [
  { id: "read", label: "只读", scopes: ["read"], hint: "只能查看：任务、同步进度和记录、网盘目录、分享内容、云下载列表" },
  { id: "daily", label: "日常", scopes: ["read", "run", "write"], hint: "查看，加上开始 / 取消同步、转存分享、添加云下载" },
  {
    id: "full",
    label: "完全",
    scopes: ["read", "run", "write", "danger"],
    hint: "再加删除与花费类的操作。目前还没有这类工具；以后的版本加了，这个令牌不用再改就能用",
  },
];

/** 修改一个不是三个预设之一的令牌（用接口建的）时，保持它原来的档位不动 */
export const CUSTOM = "custom";

export const SCOPE_LABEL: Record<AgentScope, string> = { read: "查看", run: "运行", write: "改网盘", danger: "删除与花费" };

export const TOOLSETS: Array<{ id: AgentToolset; label: string }> = [
  { id: "sync", label: "同步" },
  { id: "transfer", label: "转存与云下载" },
];

export function presetIdOf(scopes: AgentScope[]): string {
  const key = [...scopes].sort().join(",");
  return PRESETS.find((p) => [...p.scopes].sort().join(",") === key)?.id ?? CUSTOM;
}

export function presetLabel(scopes: AgentScope[]): string {
  return PRESETS.find((p) => p.id === presetIdOf(scopes))?.label ?? "自定义";
}

export const hasAllToolsets = (toolsets: AgentToolset[]) => TOOLSETS.every((t) => toolsets.includes(t.id));

const SCOPE_ORDER: AgentScope[] = ["read", "run", "write", "danger"];

/**
 * 批准网页客户端时实际给的档位：选的 ∩ 客户端要的（客户端要了才收窄），「查看」总在。
 * 和后端 services/oauth/authorize.ts 的 grantScopes 同一个算法，批准框里预览用
 */
export function grantedPreview(requested: AgentScope[], chosen: AgentScope[]): AgentScope[] {
  const base = requested.length > 0 ? chosen.filter((s) => requested.includes(s)) : chosen;
  return SCOPE_ORDER.filter((s) => s === "read" || base.includes(s));
}

export function toolsetText(toolsets: AgentToolset[]): string {
  if (hasAllToolsets(toolsets)) return "全部工具";
  return toolsets.map((t) => TOOLSETS.find((x) => x.id === t)?.label ?? t).join("、") || "只有基础工具";
}

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyToClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error("复制失败，手动选中复制吧");
    }
  };
  return (
    <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => void copy()} title={label}>
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      <span className="sr-only">{label}</span>
    </Button>
  );
}

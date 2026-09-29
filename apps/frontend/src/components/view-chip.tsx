"use client";

import { cn } from "@/lib/utils";

/** 列表上方的筛选小药丸：名字 + 个数；danger 的没选中时也带点红（已失效、提取码不对） */
export function ViewChip({ active, onClick, label, count, tone }: { active: boolean; onClick: () => void; label: string; count: number; tone?: "danger" }) {
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

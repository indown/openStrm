"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type SwitchRowProps = {
  label: React.ReactNode;
  /** 标题下面那句解释，可以不给 */
  description?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * 设置类开关的一行：标题和说明在左，开关在右。
 * 全站统一走这个，别再手抄 `<label className="flex ... rounded-md border p-3">` 那一坨。
 */
export function SwitchRow({ label, description, checked, onCheckedChange, disabled, className }: SwitchRowProps) {
  const id = useId();
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 rounded-md border p-3",
        disabled && "opacity-60",
        className,
      )}
    >
      <div className="min-w-0 space-y-1 leading-snug">
        <Label htmlFor={id} className={cn("font-medium", !disabled && "cursor-pointer")}>
          {label}
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

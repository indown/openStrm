"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { FieldHint } from "@/components/field-hint";

type SwitchRowProps = {
  label: React.ReactNode;
  /** 标题下面那句解释，可以不给 */
  description?: React.ReactNode;
  /** 标题旁边 ⓘ 里的长说明：道理、隐私、来龙去脉。后果要留在 description 里 */
  hint?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * 设置类开关的一行：标题和说明在左，开关在右。
 * 全站统一走这个，别再手抄 `<label className="flex ... rounded-md border p-3">` 那一坨。
 */
export function SwitchRow({ label, description, hint, checked, onCheckedChange, disabled, className }: SwitchRowProps) {
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
          {hint && <FieldHint>{hint}</FieldHint>}
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

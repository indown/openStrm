"use client";

import { InfoIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * 标签旁边的 ⓘ：点开才看的长说明。
 *
 * 只给"读一次就够"的东西用 —— 语法参考、为什么这么设计、隐私说明。
 * **不要拿它藏后果**：像"开了这个任何人都能拿到你的媒体直链"这种，
 * 必须留在外面看得见，ⓘ 里放的是它背后的道理。
 */
export function FieldHint({ children, label = "说明" }: { children: React.ReactNode; label?: string }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-4 shrink-0 items-center justify-center rounded-full align-middle outline-none focus-visible:ring-[3px]"
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent className="text-xs leading-relaxed">{children}</PopoverContent>
    </Popover>
  );
}

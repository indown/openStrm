import { TONE_CLASS, type StatusTone } from "@/components/status-badge";
import { cn } from "@/lib/utils";

type ProgressBarProps = {
  /** 0-100，超出范围会被夹住；indeterminate 时忽略 */
  percent?: number;
  /** 颜色跟状态走，和 StatusBadge 用同一套 tone */
  tone?: StatusTone;
  /** 正在跑：条上加一道循环扫过的高光 */
  running?: boolean;
  /** 还不知道总量：一小段来回漂，不给具体进度 */
  indeterminate?: boolean;
  /** sm = 6px（表格 / 卡片里），md = 8px（页面主进度） */
  size?: "sm" | "md";
  className?: string;
};

/**
 * 全站统一的进度条。页面里不要再自己拼 `h-1.5 overflow-hidden rounded-full bg-muted` 那一套。
 * 「正在跑」的动感（扫描高光、不确定态的漂移）在 globals.css 里，系统开了"减少动态效果"会自动静音。
 */
export function ProgressBar({
  percent = 0,
  tone = "brand",
  running,
  indeterminate,
  size = "sm",
  className,
}: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div
      className={cn("overflow-hidden rounded-full bg-muted", size === "md" ? "h-2" : "h-1.5", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      // 不确定态不报具体数值，读屏器才会念成"忙碌中"而不是 0%
      aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300",
          TONE_CLASS[tone].bar,
          indeterminate ? "progress-drift" : running && "progress-scan",
        )}
        style={{ width: indeterminate ? "25%" : `${clamped}%` }}
      />
    </div>
  );
}

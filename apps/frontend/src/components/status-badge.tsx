import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const statusBadgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium [&>svg]:size-3 [&>svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "border-transparent bg-muted text-muted-foreground",
        brand: "border-brand/20 bg-brand/10 text-brand",
        info: "border-info/20 bg-info/10 text-info",
        success: "border-success/20 bg-success/10 text-success",
        warning: "border-warning/25 bg-warning/15 text-warning",
        danger: "border-destructive/20 bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type StatusTone = NonNullable<VariantProps<typeof statusBadgeVariants>["tone"]>;

/** Badge 之外也要按 tone 上色的地方（状态图标、进度条）从这里取，别在页面里再抄一份 */
export const TONE_CLASS: Record<StatusTone, { text: string; bar: string }> = {
  neutral: { text: "text-muted-foreground", bar: "bg-muted-foreground" },
  brand: { text: "text-brand", bar: "bg-brand" },
  info: { text: "text-info", bar: "bg-info" },
  success: { text: "text-success", bar: "bg-success" },
  warning: { text: "text-warning", bar: "bg-warning" },
  danger: { text: "text-destructive", bar: "bg-destructive" },
};

type StatusBadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof statusBadgeVariants> & {
    /** 左侧加一个呼吸的小圆点，表示"正在进行" */
    pulse?: boolean;
  };

/**
 * 全站统一的状态标签：成功 / 失败 / 运行中 / 已取消 / 停用……
 * 颜色只走 globals.css 里的语义 token，浅色暗色都对；页面里不要再自己拼 bg-green-100 text-green-800
 */
export function StatusBadge({ tone, pulse, className, children, ...props }: StatusBadgeProps) {
  return (
    <span data-slot="status-badge" className={cn(statusBadgeVariants({ tone }), className)} {...props}>
      {pulse && (
        <span className="relative flex size-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-current" />
        </span>
      )}
      {children}
    </span>
  );
}

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 页面图标，一般传侧栏里同一个 */
  icon?: LucideIcon;
  /** 右侧操作区：刷新、新建之类 */
  actions?: React.ReactNode;
  className?: string;
  /** 标题下面的附加内容，比如统计小标签 */
  children?: React.ReactNode;
};

/** 每个页面顶部统一的标题区：图标 + 标题 + 一句说明，右侧放操作按钮 */
export function PageHeader({ title, description, icon: Icon, actions, className, children }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="flex min-w-0 items-center gap-2 text-2xl font-semibold tracking-tight">
          {Icon && <Icon className="size-6 shrink-0 text-brand" />}
          {/* 允许在任意位置断行：日志页把网盘路径当标题，截断就看不全了 */}
          <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
        </h1>
        {description && <p className="line-clamp-2 text-sm text-muted-foreground sm:line-clamp-none">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

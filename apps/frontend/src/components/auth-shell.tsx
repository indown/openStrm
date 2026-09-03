import Image from "next/image";

type AuthShellProps = {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  /** 卡片下面的一行小字或链接 */
  footer?: React.ReactNode;
};

/** 登录 / 改密码这类不带侧栏的页面：居中一张卡，上面是 logo 和标题 */
export function AuthShell({ title, description, children, footer }: AuthShellProps) {
  return (
    <div className="auth-backdrop flex min-h-screen flex-col items-center justify-center bg-muted/50 px-4 py-10 dark:bg-background">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Image src="/logo-128.png" alt="OpenStrm" width={56} height={56} className="size-14" unoptimized priority />
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
        </div>
        <div className="rounded-xl border bg-card p-6 shadow-sm">{children}</div>
        {footer && <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div>}
      </div>
    </div>
  );
}

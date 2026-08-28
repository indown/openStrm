"use client";

import { Button } from "@/components/ui/button";

/** 路由段渲染出错时的兜底：显示错误信息，给一个重试按钮重新渲染这一段 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4 text-center px-6">
      <h2 className="text-xl font-semibold">页面出错了</h2>
      <p className="text-sm text-muted-foreground max-w-lg break-all">{error.message || "发生了未知错误"}</p>
      <Button onClick={() => reset()}>重试</Button>
    </div>
  );
}

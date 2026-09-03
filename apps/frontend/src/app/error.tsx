"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";

/** 路由段渲染出错时的兜底：显示错误信息，给一个重试按钮重新渲染这一段 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="页面出错了"
      description={<span className="break-all">{error.message || "发生了未知错误"}</span>}
      action={<Button onClick={() => reset()}>重试</Button>}
      className="min-h-[50vh]"
    />
  );
}

import { toast } from "sonner";
import type { ShareReceiveResult } from "./api";

/**
 * 「保存到任务目录」的结果提示：同步模式报生成数量，异步模式给一个跳到进度页的入口。
 * 分享详情和影库两处入口共用。
 */
export function notifySaveToTaskResult(
  result: ShareReceiveResult | undefined,
  router: { push: (url: string) => void },
): void {
  const data = result ?? {};
  if (data.mode === "async" && data.taskId) {
    const taskId = data.taskId;
    toast.success("已触发后台同步", {
      action: { label: "查看进度", onClick: () => router.push(`/log?taskId=${encodeURIComponent(taskId)}`) },
    });
  } else if (typeof data.generatedCount === "number") {
    toast.success(`保存成功，生成 ${data.generatedCount} 个 strm（跳过 ${data.skippedCount ?? 0} 个）`);
  } else {
    toast.success("保存成功");
  }
}

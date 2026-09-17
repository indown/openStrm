import { toast } from "sonner";
import type { UpdateStatus } from "@openstrm/shared";
import { api } from "@/lib/api";
import { apiErrorBody, apiErrorMessage } from "@/lib/axios";

/** 检查更新的小事件：设置页查完之后让侧栏的角标立刻跟上，不用等它自己那一轮 */
export const UPDATE_CHANGED_EVENT = "openstrm:update-changed";

export function notifyUpdateChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(UPDATE_CHANGED_EVENT));
}

/**
 * 立即检查一次，结果用 toast 说，顺便通知侧栏角标。
 * 设置页要拿回状态自己显示，命令面板不要，所以返回值可空。
 */
export async function checkForUpdate(): Promise<UpdateStatus | null> {
  try {
    const next = await api.update.check();
    notifyUpdateChanged();
    toast[next.outdated ? "success" : "info"](
      next.outdated ? `有新版本 ${next.state.latest?.version}` : "已经是最新版本",
    );
    return next;
  } catch (err) {
    // 后端对「刚查过」回 retryAfter 秒数，别当成一般失败
    const retry = (apiErrorBody(err) as { retryAfter?: number }).retryAfter;
    toast.error(typeof retry === "number" ? `刚查过，${Math.ceil(retry / 60)} 分钟后再试` : apiErrorMessage(err, "检查更新失败"));
    return null;
  }
}

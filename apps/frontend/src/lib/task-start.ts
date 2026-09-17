import { toast } from "sonner";
import { api, type StartTaskResult } from "@/lib/api";
import { apiErrorBody } from "@/lib/axios";

/** 后端 startTask 的 message 是固定的英文句式，界面上说成人话 */
export function describeStart(res: StartTaskResult): string {
  const m = /^(\d+) files to download$/.exec(res.message);
  if (m) return `开始处理 ${m[1]} 个文件`;
  if (res.message === "no files to download") return "本地已是最新，没有需要处理的文件";
  return res.message;
}

/**
 * 启动一个任务，成败都用 toast 说。
 *
 * 返回它是不是真的起来了：任务页据此把那一行乐观标成执行中，命令面板不关心。
 * 超时单独说一句 —— 115 导出大目录要几分钟，这时候任务多半已经在后台跑了，
 * 让人去历史页看，而不是以为失败了再点一次。
 */
export async function startTaskWithToast(id: string): Promise<boolean> {
  try {
    const res = await api.tasks.start(id);
    toast.success(describeStart(res));
    if (res.warning) toast.warning(res.warning);
    return true;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ECONNABORTED") {
      toast.error("启动超时：读取网盘目录太久，请稍后到历史页看结果");
    } else if (error && typeof error === "object" && "response" in error) {
      const { message, details } = apiErrorBody(error);
      const text = message || "任务启动失败";
      toast.error(details ? `${text}：${details}` : text);
    } else {
      toast.error("任务启动失败");
    }
    return false;
  }
}

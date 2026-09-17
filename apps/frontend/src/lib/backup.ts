import { toast } from "sonner";
import { api } from "@/lib/api";

/**
 * 下载数据库的一致性快照。
 *
 * 备份接口要带登录 token，普通 <a download> 带不上，只能拉成 blob 再触发下载。
 * 设置页和命令面板都要用，抽在这儿。
 */
export async function downloadBackup(): Promise<void> {
  const { blob, filename } = await api.system.backup();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // 别同步撤销：Firefox / Safari 会在下载真正开始前就把 URL 收回，下载直接中断
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 上面那个加一句失败提示，给不关心结果的调用点（命令面板）用 */
export async function downloadBackupWithToast(): Promise<void> {
  try {
    await downloadBackup();
  } catch {
    toast.error("下载备份失败");
  }
}

import type { OpenlistCopySettings } from "@openstrm/shared";

/**
 * 任务弹框里「开着复制却复制不了」卡在哪，null = 设置上齐了。
 *
 * 条件和顺序跟后端 services/copy/paths.ts 的 copySettingsGap 一样（改条件时两边一起动），
 * 说法是给弹框的：目标目录那条就在弹框里能补上。保存过的任务不用这个——
 * 任务列表接口直接带着后端算好的 copyBlocked。
 * accounts 是空的（还在读 / 读失败）就不查 OpenList 账号在不在，免得误报。
 */
export function copyGapInDialog(
  cfg: OpenlistCopySettings,
  account: string,
  taskDstDir: string | undefined,
  accounts: Array<{ name: string; accountType: string }>,
): string | null {
  if (!cfg.account) return "设置页还没选 OpenList 账号，开着也不会复制";
  if (accounts.length > 0 && !accounts.some((a) => a.name === cfg.account && a.accountType === "openlist")) {
    return `设置页选的 OpenList 账号「${cfg.account}」已经不在了，开着也不会复制`;
  }
  if (!cfg.mounts?.[account]?.trim()) return `账号 ${account} 还没在设置页填「在 OpenList 里的挂载根」，开着也不会复制`;
  if (!taskDstDir?.trim() && !cfg.dstDir?.trim()) return "没有目标目录：在下面的「复制到哪」里填一个，或者到设置页填默认目标目录";
  return null;
}

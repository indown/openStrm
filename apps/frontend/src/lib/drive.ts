/**
 * 网盘类型的文案，和「这条记录是哪个账号哪个网盘的」这种一句话标签。
 * 同一个人可以在 115 和夸克上各建一个叫 tv 的任务，光看目录名分不出是哪个。
 */
import type { DriveKind, TaskRow } from "@/lib/api";

export const DRIVE_LABEL: Record<DriveKind, string> = { "115": "115", quark: "夸克", openlist: "OpenList" };
export const DRIVE_FULL_LABEL: Record<DriveKind, string> = { "115": "115 网盘", quark: "夸克网盘", openlist: "OpenList" };

const labelOf = (kind?: string): string => DRIVE_LABEL[(kind ?? "") as DriveKind] ?? "";

/** 账号 + 网盘类型：`kuake（夸克）`；账号名字本身已经说明了是哪家就不重复（`115`） */
export function accountLabel(account: string, accountType?: string): string {
  const kind = labelOf(accountType);
  if (!kind) return account;
  return account.toLowerCase().includes(kind.toLowerCase()) ? account : `${account}（${kind}）`;
}

/** 一个任务在列表里怎么称呼：`kuake（夸克）· tv` */
export function taskLabel(task: Pick<TaskRow, "account" | "accountType" | "originPath">): string {
  return `${accountLabel(task.account, task.accountType)} · ${task.originPath}`;
}

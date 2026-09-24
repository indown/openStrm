/**
 * 「允许在 Telegram 里批准网页客户端的连接」等于能不输密码签出一把长期有效的钥匙（刷新令牌一直能续、不随改密码断开），
 * 和在管理界面批准、建令牌同一个分量，所以：
 *   - 打开它要当前密码；
 *   - 开着的时候换了「谁能批」（机器人、chat id、白名单加了人），它自动关掉，要用再输密码打开。
 * 不然拿着偷来的会话，把机器人换成自己的、或者把自己的 Telegram 账号加进白名单，就能批出一个自己的客户端。
 * 白名单删人、改别的开关不算：批准的人只会变少
 */
import type { TelegramSettings } from "@openstrm/shared";

export function approversChanged(before: TelegramSettings | undefined, after: TelegramSettings | undefined): boolean {
  if ((after?.botToken ?? "") !== (before?.botToken ?? "")) return true;
  if ((after?.chatId ?? "").trim() !== (before?.chatId ?? "").trim()) return true;
  const had = new Set(before?.allowedUsers ?? []);
  return (after?.allowedUsers ?? []).some((u) => !had.has(u));
}

/** 开着批准、这次又换了能批的人：该自动关掉 */
export function approvalMustTurnOff(before: TelegramSettings | undefined, after: TelegramSettings | undefined): boolean {
  return before?.allowOAuthApproval === true && after?.allowOAuthApproval === true && approversChanged(before, after);
}

export const APPROVAL_OFF_NOTE = "换了机器人、chat id 或白名单，「允许批准网页客户端的连接」已自动关掉；要用的话重新打开（要输当前密码）";

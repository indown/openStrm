/**
 * 账号 → Provider 的分派，和「哪个账号能开这个分享链接」。
 * 功能代码只 import 这里，不直接碰 providers/。测试用 setDriveProviderFactory 换成内存假网盘。
 */
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { getAccount, listAccounts } from "../../db/repositories/accounts.js";
import { HttpError } from "../../lib/http-error.js";
import { Cloud115Provider, parse115ShareLink } from "./providers/cloud115.js";
import { OpenlistProvider } from "./providers/openlist.js";
import { parseQuarkShareLink, QuarkProvider } from "./providers/quark.js";
import type { DriveCapabilities, DriveKind, DriveProvider, ShareRef } from "./types.js";

export const KIND_LABEL: Record<DriveKind, string> = { "115": "115 网盘", quark: "夸克网盘", openlist: "OpenList" };
const CAP_LABEL: Record<keyof DriveCapabilities, string> = { share: "分享转存", changes: "网盘监控", write: "整理（改名 / 移动）" };

export type ProviderFactory = (account: AccountInfo) => DriveProvider | null;
let override: ProviderFactory | null = null;

/** 仅供测试：返回 null 的账号照旧走真实现；传 null 恢复 */
export function setDriveProviderFactory(fn: ProviderFactory | null): void {
  override = fn;
}

/** Provider 只是薄包装，不缓存：账号对象每次现取，cookie 在账户页改过就直接用新的 */
export function providerFor(account: AccountInfo): DriveProvider {
  const custom = override?.(account);
  if (custom) return custom;
  switch (account.accountType) {
    case "115":
      return new Cloud115Provider(account);
    case "quark":
      return new QuarkProvider(account);
    case "openlist":
      return new OpenlistProvider(account);
  }
  throw new Error(`Unknown account type: ${(account as { accountType?: string }).accountType}`);
}

export function providerForAccount(name: string, need?: keyof DriveCapabilities): DriveProvider {
  const account = getAccount(name);
  if (!account) throw new HttpError(400, `账号不存在：${name}`);
  const provider = providerFor(account);
  if (need && !provider.capabilities[need]) {
    throw new HttpError(400, `账号 ${name}（${KIND_LABEL[provider.kind]}）不支持${CAP_LABEL[need]}`);
  }
  return provider;
}

export function providerForTask(task: TaskDefinition, need?: keyof DriveCapabilities): DriveProvider {
  const account = getAccount(task.account);
  if (!account) throw new HttpError(400, `任务 ${task.id} 绑定的账号 ${task.account} 不存在`);
  const provider = providerFor(account);
  if (need && !provider.capabilities[need]) {
    throw new HttpError(400, `任务 ${task.id} 绑定的账号 ${task.account}（${KIND_LABEL[provider.kind]}）不支持${CAP_LABEL[need]}`);
  }
  return provider;
}

/* ------------------------------- 分享链接 ------------------------------- */

/** 不需要账号的纯解析：严格认域名的（夸克）先来，115 还认裸分享码所以放最后 */
export function parseShareRef(text: string): ShareRef | null {
  return parseQuarkShareLink(text) ?? parse115ShareLink(text);
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'，。；）]+/gi;
const PASSCODE_IN_TEXT = /提取码[:：]?\s*([a-z0-9]{4,8})/i;

function withPassword(ref: ShareRef, password: string): ShareRef {
  if (!password || ref.password) return ref;
  const sep = ref.url.includes("?") ? "&" : "?";
  return { ...ref, password, url: `${ref.url}${sep}${ref.kind === "115" ? "password" : "pwd"}=${password}` };
}

/** 从一段话里挑出分享链接（Telegram 消息）：只认 URL，提取码可以写在链接后面的文字里 */
export function findShareLink(text: string): ShareRef | null {
  for (const url of text.match(URL_IN_TEXT) ?? []) {
    const ref = parseShareRef(url);
    if (ref) return withPassword(ref, PASSCODE_IN_TEXT.exec(text)?.[1] ?? "");
  }
  return null;
}

export interface ShareMatch {
  provider: DriveProvider;
  ref: ShareRef;
}

/**
 * 哪个账号能打开这个分享链接：先认出是哪家的，再在账号池里找同类且有分享能力的第一个。
 * 指定了 account 就只看它。认不出或没有账号返回 null。
 */
export function matchShareLink(text: string, opts: { account?: string; accounts?: AccountInfo[] } = {}): ShareMatch | null {
  const ref = parseShareRef(text);
  if (!ref) return null;
  const pool = (opts.accounts ?? listAccounts()).filter((a) => !opts.account || a.name === opts.account);
  for (const account of pool) {
    if (account.accountType !== ref.kind) continue;
    const provider = providerFor(account);
    if (provider.share) return { provider, ref };
  }
  return null;
}

/** 同上，但没人认出就抛 400 */
export function shareForLink(text: string, opts: { account?: string } = {}): ShareMatch {
  const hit = matchShareLink(text, opts);
  if (hit) return hit;
  const ref = parseShareRef(text);
  if (!ref) throw new HttpError(400, "不认识这个分享链接，目前支持 115 和夸克网盘的分享");
  if (opts.account) throw new HttpError(400, `账号 ${opts.account} 打不开${KIND_LABEL[ref.kind]}的分享`);
  throw new HttpError(400, `这是${KIND_LABEL[ref.kind]}的分享，请先到「账户」页添加一个${KIND_LABEL[ref.kind]}账号`);
}

/** 分享的网盘必须和目标账号同类：115 的分享转不进夸克，反之亦然 */
export function assertSameKind(ref: ShareRef, target: DriveProvider): void {
  if (ref.kind !== target.kind) {
    throw new HttpError(400, `这是${KIND_LABEL[ref.kind]}的分享，不能转存到${KIND_LABEL[target.kind]}账号的任务里`);
  }
}

/**
 * 账号 → Provider 的分派，和「哪个账号能开这个分享链接」。
 * 功能代码只 import 这里，不直接碰 providers/。测试用 setDriveProviderFactory 换成内存假网盘。
 */
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { getAccount, listAccounts } from "../../db/repositories/accounts.js";
import { HttpError } from "../../lib/http-error.js";
import { Cloud115Provider } from "./providers/cloud115.js";
import { OpenlistProvider } from "./providers/openlist.js";
import { QuarkProvider } from "./providers/quark.js";
import type { DriveCapabilities, DriveKind, DriveProvider, ShareRef } from "./types.js";

export const KIND_LABEL: Record<DriveKind, string> = { "115": "115 网盘", quark: "夸克网盘", openlist: "OpenList" };
const CAP_LABEL: Record<keyof DriveCapabilities, string> = { share: "分享转存", changes: "网盘监控" };

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

/** 认链接时严格的先来：夸克只认自家域名，115 还认裸分享码，顺序反了裸码会被抢走 */
const PARSE_ORDER: DriveKind[] = ["quark", "115", "openlist"];

export interface ShareMatch {
  provider: DriveProvider;
  ref: ShareRef;
}

/**
 * 哪个账号能打开这个分享链接：按 PARSE_ORDER 里的网盘顺序问各账号的 parseLink，第一个认出的就是。
 * 指定了 account 就只问它。没人认出返回 null。
 */
export function matchShareLink(text: string, opts: { account?: string; accounts?: AccountInfo[] } = {}): ShareMatch | null {
  const pool = (opts.accounts ?? listAccounts()).filter((a) => !opts.account || a.name === opts.account);
  const providers = pool.map(providerFor).filter((p) => p.share);
  for (const kind of PARSE_ORDER) {
    for (const provider of providers) {
      if (provider.kind !== kind) continue;
      const ref = provider.share!.parseLink(text);
      if (ref) return { provider, ref };
    }
  }
  return null;
}

/** 同上，但没人认出就抛 400 */
export function shareForLink(text: string, opts: { account?: string } = {}): ShareMatch {
  const hit = matchShareLink(text, opts);
  if (hit) return hit;
  if (opts.account) throw new HttpError(400, `账号 ${opts.account} 打不开这个分享链接`);
  const kinds = new Set(listAccounts().map((a) => providerFor(a)).filter((p) => p.share).map((p) => KIND_LABEL[p.kind]));
  if (kinds.size === 0) throw new HttpError(400, "还没有能转存分享的网盘账号，请先到「账户」页添加 115 或夸克账号");
  throw new HttpError(400, `不认识这个分享链接；现在配置的账号能开：${[...kinds].join("、")}`);
}

/** 分享的网盘必须和目标任务的账号同类：115 的分享转不进夸克，反之亦然 */
export function assertSameKind(ref: ShareRef, target: DriveProvider): void {
  if (ref.kind !== target.kind) {
    throw new HttpError(400, `这是${KIND_LABEL[ref.kind]}的分享，不能转存到${KIND_LABEL[target.kind]}账号的任务里`);
  }
}

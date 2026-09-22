/**
 * 网盘路径 ↔ OpenList 路径的换算，以及「复制到 OpenList」的配置解析。
 *
 * OpenList 把各家网盘挂在自己的某个目录下（115 挂 /115、夸克挂 /quark），
 * 所以网盘上的绝对路径前面补上这个账号的挂载根，就是它在 OpenList 里的路径。
 * 有了这层换算，复制就不再限定在某一个目录、某一种网盘上——加一种网盘只要多配一行挂载根。
 *
 * 这里的路径归一**只管斜杠**：不能用 drive/types.ts 的 normalizePath，
 * 它会把每一段首尾的空格削掉，而网盘上真有「Season 1 」这种带尾空格的目录名（见 test/fake-drive.ts）。
 */
import type { AccountOpenlist, AppSettings } from "@openstrm/shared";
import { getAccount } from "../../db/repositories/accounts.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";

export interface CopyConfig {
  /** 调 OpenList 接口用的账号 */
  account: AccountOpenlist;
  /** 默认目标目录 */
  dstDir: string;
  /** 网盘账号名 → 挂载根 */
  mounts: Record<string, string>;
}

/** 去掉尾斜杠、补上头斜杠、把连着的斜杠收成一个；空的还它空串，让调用方按「没配置」处理 */
export function normDir(input?: string): string {
  const t = (input ?? "").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (!t.trim()) return (input ?? "").trim() === "/" ? "/" : "";
  return t.startsWith("/") ? t : `/${t}`;
}

/** 拼两段路径，中间只留一个斜杠 */
export function joinPath(base: string, rel: string): string {
  const head = base === "/" ? "" : base.replace(/\/+$/, "");
  const tail = rel.replace(/^\/+/, "");
  return tail ? `${head}/${tail}` : head || "/";
}

/** 路径的最后一段（条目名）；根目录返回空串。不 trim，网盘上的名字可能带空格 */
export function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

/** 路径的父目录，带前导 /；顶层条目的父目录是 / */
export function parentDir(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

/** path 在 root 下面的相对路径；不在 root 下面返回 null */
export function relativeTo(root: string, path: string): string | null {
  const r = normDir(root);
  const p = normDir(path);
  if (r === "/" || r === "") return p.replace(/^\/+/, "");
  if (p === r) return "";
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null;
}

/**
 * 网盘绝对路径 → OpenList 里的路径。没给这个账号配挂载根就返回 null，
 * 调用方据此说「这个账号还没配挂载根」，而不是猜一个路径出来复制到奇怪的地方。
 */
export function toOpenlistPath(mounts: Record<string, string>, account: string, drivePath: string): string | null {
  const mount = normDir(mounts[account]);
  if (!mount) return null;
  return mount === "/" ? normDir(drivePath) || "/" : joinPath(mount, drivePath);
}

/**
 * 这一条复制到哪个目录：把源路径相对「根」的那段目录结构原样搬到目标下面。
 * 监控报上来的是一个个深层文件（/tv/某剧/S01/E01.mkv），平铺过去几十集会挤在一个目录里还撞名。
 * 给不出根（或路径不在根下面）就平铺到 base，调用方会在 detail 里说明。
 */
export function dstDirFor(base: string, rootPath: string | undefined, srcPath: string): { dstDir: string; flattened: boolean } {
  if (!rootPath) return { dstDir: normDir(base), flattened: false };
  const rel = relativeTo(rootPath, srcPath);
  if (rel === null) return { dstDir: normDir(base), flattened: true };
  const sub = parentDir(`/${rel}`);
  return { dstDir: sub === "/" ? normDir(base) : joinPath(normDir(base), sub), flattened: false };
}

/** 设置页的 openlistCopy + 账号表 → 可用的配置；缺什么直接说什么 */
export function resolveCopyConfig(settings: AppSettings = readAppSettings()): CopyConfig {
  const cfg = settings.openlistCopy ?? {};
  const dstDir = normDir(cfg.dstDir);
  if (!cfg.account || !dstDir) {
    throw new HttpError(400, "「复制到 OpenList」还没配置好：请在设置页填上 OpenList 账号和目标目录");
  }
  const acc = getAccount(cfg.account);
  if (!acc) throw new HttpError(400, `OpenList 账号不存在：${cfg.account}`);
  if (acc.accountType !== "openlist") throw new HttpError(400, `${cfg.account} 不是 openlist 账号`);
  if (!acc.url || !acc.account || !acc.password) throw new HttpError(400, `OpenList 账号 ${cfg.account} 缺少地址或用户名/密码`);
  const mounts: Record<string, string> = {};
  for (const [name, path] of Object.entries(cfg.mounts ?? {})) {
    const norm = normDir(path);
    if (norm) mounts[name] = norm;
  }
  return { account: acc, dstDir, mounts };
}

/**
 * 只看设置：OpenList 账号、目标目录、这个网盘账号的挂载根都填了没有。
 * 不碰账号表——给「要不要显示这个入口」用，账号本身好不好使留到真提交时报错。
 */
export function copyConfigured(account: string, settings: AppSettings = readAppSettings()): boolean {
  const cfg = settings.openlistCopy ?? {};
  return Boolean(cfg.account && normDir(cfg.dstDir) && normDir(cfg.mounts?.[account]));
}

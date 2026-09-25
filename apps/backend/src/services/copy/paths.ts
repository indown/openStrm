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
import type { AccountOpenlist, AppSettings, CopyAfterCopy, TaskDefinition } from "@openstrm/shared";
import { afterCopyOf } from "../../lib/after-copy.js";
import { getAccount, listAccounts } from "../../db/repositories/accounts.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { messageOf } from "../../lib/errors.js";
import { HttpError } from "../../lib/http-error.js";

export interface CopyConfig {
  /** 调 OpenList 接口用的账号 */
  account: AccountOpenlist;
  /** 默认目标目录 */
  dstDir: string;
  /** 网盘账号名 → 挂载根 */
  mounts: Record<string, string>;
}

/**
 * 设置里手打的路径：先整串去空白再归一。
 * 和 normDir 分开是因为网盘路径的最后一段可能真的带空格（「Season 1 」），那种不能 trim。
 */
export function normConfigDir(input?: string): string {
  return normDir((input ?? "").trim());
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
  // 目标目录可以只在任务上填（设置页那个是默认值），所以这里不强求；真到要用时 enqueueCopy 会再看一次
  const dstDir = normConfigDir(cfg.dstDir);
  if (!cfg.account) {
    throw new HttpError(400, "「复制到 OpenList」还没配置好：请在设置页选一个 OpenList 账号");
  }
  const acc = getAccount(cfg.account);
  if (!acc) throw new HttpError(400, `OpenList 账号不存在：${cfg.account}`);
  if (acc.accountType !== "openlist") throw new HttpError(400, `${cfg.account} 不是 openlist 账号`);
  if (!acc.url || !acc.account || !acc.password) throw new HttpError(400, `OpenList 账号 ${cfg.account} 缺少地址或用户名/密码`);
  const mounts: Record<string, string> = {};
  for (const [name, path] of Object.entries(cfg.mounts ?? {})) {
    const norm = normConfigDir(path);
    if (norm) mounts[name] = norm;
  }
  return { account: acc, dstDir, mounts };
}

/**
 * 只看设置：这个网盘账号要复制还缺哪样，null = 设置上齐了。顺序照设置页从上到下。
 * 不碰账号表——账号本身好不好使留到真提交时报错（要连账号表一起看的是 copyBlockerFor）。
 * 前端任务弹框里有一份同样的判断（apps/frontend/src/lib/openlist-copy.ts），改条件时两边一起动。
 */
export function copySettingsGap(account: string, settings: AppSettings = readAppSettings(), taskDstDir?: string): string | null {
  const cfg = settings.openlistCopy ?? {};
  if (!cfg.account) return "设置页还没选 OpenList 账号";
  if (!normConfigDir(cfg.mounts?.[account])) return `账号 ${account} 还没填「在 OpenList 里的挂载根」`;
  if (!normConfigDir(taskDstDir) && !normConfigDir(cfg.dstDir)) return "没有目标目录：任务上和设置页都没填";
  return null;
}

/** 只看设置：OpenList 账号、目标目录、这个网盘账号的挂载根都填了没有。给「要不要显示这个入口」用 */
export function copyConfigured(account: string, settings: AppSettings = readAppSettings(), taskDstDir?: string): boolean {
  return copySettingsGap(account, settings, taskDstDir) === null;
}

/**
 * 按任务回答「要复制的话卡在哪」，null = 能复制。任务列表的徽标、转存弹框的勾选框、
 * 明确要复制时的当场报错都看它，和真干活时同一套判断。
 *
 * 比 copySettingsGap 多看账号表：设置上齐了、OpenList 账号却被删了或缺密码（resolveCopyConfig 会拒），
 * 或者任务本身挂在 OpenList 账号上（转存 / 追更 / 云下载 / 监控都不会往那种任务里落文件），一样复制不了。
 * 全局那部分只算一次，列表里每个任务只查表。
 */
export function copyBlockerFor(settings: AppSettings = readAppSettings()): (task: Pick<TaskDefinition, "account" | "copyToOpenlist">) => string | null {
  let global: string | null = null;
  // 压根没选 OpenList 账号的交给 copySettingsGap 说（话短），选了的才去账号表里核对
  if (settings.openlistCopy?.account) {
    try {
      resolveCopyConfig(settings);
    } catch (err) {
      global = messageOf(err);
    }
  }
  const types = new Map(listAccounts().map((a) => [a.name, a.accountType]));
  return (task) => {
    if (types.get(task.account) === "openlist") return "OpenList 账号的任务用不着复制：转存、追更、云下载、监控都不会往这里落新文件";
    return global ?? copySettingsGap(task.account, settings, task.copyToOpenlist?.dstDir);
  };
}

/** copyOptionsFor 的结论 */
export interface CopyOptions {
  enabled: boolean;
  /** 这一次指定的、或任务上填的目标目录；都没有用设置页的默认目标目录 */
  dstDir?: string;
  /** 复制成功后源文件的去向 */
  afterCopy: CopyAfterCopy;
  /** 要复制却复制不了：卡在哪 */
  blocked?: string;
}

/**
 * 这一次复制什么参数。明说了就按它（弹框里的一次性勾选），否则按任务上的开关；
 * 全局没配好 / 这个账号没填挂载根一律当关——同「没配 TMDB key 就不自动整理」的路子。
 * 要复制却因此关掉的，blocked 里带着卡在哪：调用方记一笔，不然用户只看到「开着复制，什么都没发生」。
 *
 * **源文件的去向只认任务开关**：一次性勾的那个复选框上只写着「复制」，
 * 不能让它顺带把网盘上的源文件删了或挪了（任务上留着的旧设置也不行）。
 */
export function copyOptionsFor(
  task: Pick<TaskDefinition, "account" | "copyToOpenlist"> | null,
  forced: boolean | undefined,
  settings: AppSettings = readAppSettings(),
  /** 这一次指定的目标目录（云下载弹框里选的）：有它就不再要求任务上、设置页填了目标目录 */
  dstDir?: string,
): CopyOptions {
  const account = task?.account;
  const off: CopyOptions = { enabled: false, afterCopy: "keep" };
  const cfg = task?.copyToOpenlist;
  const byTask = cfg?.enabled === true;
  if (!account || !(forced ?? byTask)) return off;
  const dst = normConfigDir(dstDir) || cfg?.dstDir;
  const gap = copySettingsGap(account, settings, dst);
  if (gap) return { ...off, blocked: gap };
  return { enabled: true, dstDir: dst, afterCopy: byTask ? afterCopyOf(cfg) : "keep" };
}

/**
 * 这一次指定的复制目标能不能用，null = 能。只能是任务上填的目标目录、设置页的默认目标目录，或者它们下面的目录——
 * 界面和 Telegram 都是从这两个根往下选的；随便填的话能把东西复制进别的网盘的挂载里，开着删源还会删掉原件
 */
export function copyDstProblem(dstDir: string, task: Pick<TaskDefinition, "copyToOpenlist"> | null, settings: AppSettings = readAppSettings()): string | null {
  const bases = [...new Set([normConfigDir(task?.copyToOpenlist?.dstDir), normConfigDir(settings.openlistCopy?.dstDir)].filter(Boolean))];
  if (bases.length === 0) return "任务上和设置页都没填复制的目标目录，没法指定这次复制到哪";
  if (bases.some((b) => relativeTo(b, dstDir) !== null)) return null;
  return `复制目标只能是 ${bases.join(" 或 ")}，或者它下面的目录`;
}

/** 只问「这次要不要复制」 */
export function copyEnabledFor(
  task: Pick<TaskDefinition, "account" | "copyToOpenlist"> | null,
  forced: boolean | undefined,
  settings: AppSettings = readAppSettings(),
): boolean {
  return copyOptionsFor(task, forced, settings).enabled;
}

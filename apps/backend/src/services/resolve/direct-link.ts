/**
 * 115 直链解析。
 *
 * 两个调用方向，路径约定不一样：
 * - Emby 302 路由：拿到的是 strm 文件里写的路径，形如 `${strmPrefix}/${originPath}/${相对路径}`，
 *   需要先剥掉挂载前缀，再反查任务表确定是哪个账号的盘。
 * - /api/fs/get（Alist 兼容接口，CD2/OpenList 回源在用）：拿到的是 `/{账号名}/{115 路径}`。
 *
 * 直链和请求时用的 UA 是绑定的，所以 UA 必须由调用方传进来——
 * 302 场景要用客户端自己的 UA，否则客户端拿着这条链接去下会被 115 拒掉。
 */
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { listAccounts } from "../../db/repositories/accounts.js";
import { listTasks } from "../../db/repositories/tasks.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { getIdToPath, getDownloadUrlWeb } from "../cloud-115/client.js";

type Account115 = Extract<AccountInfo, { accountType: "115" }>;

export type ResolveFailure =
  /** 一个 115 账号都没配 */
  | "no-account"
  /** 路径不在任何 mediaMountPath 之下，不该由我们接管 */
  | "not-mounted"
  /** 盘里找不到这个文件 */
  | "not-found"
  /** 找到了文件但拿不到直链 */
  | "no-url";

/**
 * 扁平结构而不是判别联合：backend 的 tsconfig 关了 strict，
 * `ok: true | false` 的联合在这里收窄不了。和代码库里其他 `{ ok, ... }` 返回值保持一致。
 */
export type ResolveResult = {
  ok: boolean;
  /** ok 为 false 时给出失败原因 */
  reason?: ResolveFailure;
  url?: string;
  accountName?: string;
  panPath?: string;
};

/** strm 落盘时可能被 encodeURI 过（任务的 enablePathEncoding），解不开就按原样用 */
export function safeDecode(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** 合并重复斜杠。originPath 带不带前导 `/` 都有人这么配，拼出来会有 `//` */
function collapseSlashes(p: string): string {
  return p.replace(/\/{2,}/g, "/");
}

function trimTrailing(p: string): string {
  return p.replace(/\/+$/, "");
}

function accounts115(): Account115[] {
  return listAccounts().filter((a): a is Account115 => a.accountType === "115");
}

/**
 * 剥掉 mediaMountPath 前缀。多个前缀时取最长匹配，
 * 避免 `/mnt/115` 和 `/mnt/115-4k` 这种互为前缀的配置选错。
 */
export function stripMountPath(
  path: string,
  mountPaths: string[],
): { mount: string; rest: string } | null {
  const candidates = [...new Set(mountPaths.filter(Boolean).map(trimTrailing))].sort(
    (a, b) => b.length - a.length,
  );
  for (const mount of candidates) {
    if (path === mount) return { mount, rest: "/" };
    if (path.startsWith(`${mount}/`)) return { mount, rest: path.slice(mount.length) };
  }
  return null;
}

/**
 * 反查任务表：哪个任务用的就是这个 strmPrefix、且它的 originPath 正好是这条路径的前缀，
 * 那这个文件就在该任务的账号里。比在路径里找账号名靠谱——strm 路径里根本没有账号名。
 */
export function accountNameByTask(
  mount: string,
  rest: string,
  tasks: TaskDefinition[],
): string | null {
  for (const t of tasks) {
    if (!t.strmPrefix || trimTrailing(t.strmPrefix) !== mount) continue;
    const origin = trimTrailing(collapseSlashes(`/${t.originPath ?? ""}`));
    // originPath 为空或就是根，说明整个挂载点都是这个任务的
    if (!origin || origin === "/") return t.account;
    if (rest === origin || rest.startsWith(`${origin}/`)) return t.account;
  }
  return null;
}

/** Alist 约定：路径里带账号名，形如 `/{账号名}/{115 路径}` */
function splitByAccountName(
  path: string,
  list: Account115[],
): { account: Account115; panPath: string } | null {
  for (const account of list) {
    const pattern = `/${account.name}/`;
    const idx = path.indexOf(pattern);
    if (idx !== -1) {
      return { account, panPath: path.slice(idx + pattern.length) };
    }
  }
  return null;
}

async function toDirectUrl(
  account: Account115,
  panPath: string,
  userAgent: string | undefined,
): Promise<ResolveResult> {
  // getIdToPath 找不到文件时是抛异常而不是返回空，这里翻译成 not-found，
  // 真正的网络/接口错误继续往上抛，不要被伪装成"文件不存在"
  let pickcode: unknown;
  try {
    pickcode = await getIdToPath({ path: panPath, userAgent, accountInfo: account });
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return { ok: false, reason: "not-found" };
    }
    throw err;
  }
  if (!pickcode) return { ok: false, reason: "not-found" };

  const url = await getDownloadUrlWeb(pickcode, { userAgent, accountInfo: account });
  if (!url) return { ok: false, reason: "no-url" };

  return { ok: true, url, accountName: account.name, panPath };
}

/**
 * Emby 看到的路径 → 115 直链。
 *
 * 路径不在挂载点下时返回 `not-mounted`，调用方据此回源——本地文件不该被 302 掉。
 * 115 侧的网络/接口错误会抛出，由调用方兜底。
 */
export async function resolveEmbyPath(
  embyPath: string,
  userAgent?: string,
): Promise<ResolveResult> {
  const list = accounts115();
  if (list.length === 0) return { ok: false, reason: "no-account" };

  const decoded = collapseSlashes(safeDecode(embyPath));
  const mountPaths = readAppSettings().mediaMountPath ?? [];
  const stripped = stripMountPath(decoded, mountPaths);
  if (!stripped) return { ok: false, reason: "not-mounted" };

  const byTaskName = accountNameByTask(stripped.mount, stripped.rest, listTasks());
  const taskAccount = byTaskName ? list.find((a) => a.name === byTaskName) : undefined;
  if (taskAccount) {
    return toDirectUrl(taskAccount, stripped.rest, userAgent);
  }

  // 任务表反查不到，退回 Alist 那套：路径里找账号名，再不行用第一个账号
  const matched = splitByAccountName(stripped.rest, list);
  return toDirectUrl(matched?.account ?? list[0], matched?.panPath ?? stripped.rest, userAgent);
}

/**
 * Alist 兼容接口用的解析：路径形如 `/{账号名}/{115 路径}`，认不出账号名就用第一个 115 账号。
 * 保持 /api/fs/get 原有行为，CD2/OpenList 回源依赖它。
 */
export async function resolveAlistPath(
  alistPath: string,
  userAgent?: string,
): Promise<ResolveResult> {
  const list = accounts115();
  if (list.length === 0) return { ok: false, reason: "no-account" };

  const decoded = safeDecode(alistPath);
  const matched = splitByAccountName(decoded, list);

  return toDirectUrl(matched?.account ?? list[0], matched?.panPath ?? decoded, userAgent);
}

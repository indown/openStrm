/**
 * 夸克分享：换 stoken、列分享目录、转存、盯转存任务。
 * 接口来自 quark-auto-save / kuake_cli 等开源实现，和 client.ts 共用 quarkRequest（同样的头、限流、__puus 写回）。
 *
 *   - POST share/sharepage/token {pwd_id, passcode} → data.stoken（还带 title）；分享没了 / 提取码错在这一步就报
 *   - GET  share/sharepage/detail?pwd_id&stoken&pdir_fid&_page&_size=50 → data.list[{fid, file_name, dir, size, updated_at, share_fid_token}]，metadata._total 翻页
 *   - POST share/sharepage/save {fid_list, fid_token_list, to_pdir_fid, pwd_id, stoken, pdir_fid:"0", scene:"link"} → data.task_id
 *   - GET  task?task_id&retry_index → data.status 2 完成 / 3 失败 / 4 暂停；data.save_as.save_as_top_fids 是转存进来的顶层 fid
 *   - POST share/inc_update_list {pwd_id, stoken, page, page_size} → data.share_inc_update.list 是相对上次转存的新增（空就是没更新）；
 *          41043 没转存过；41040 也是没更新
 *
 * 分享级失败（分享不存在、stoken 失效、提取码错）抛 QuarkShareError；登录态问题仍是 QuarkError；转存任务失败是 QuarkTaskError。
 */
import { setTimeout as sleep } from "node:timers/promises";
import { LRUCache } from "lru-cache";
import type { AccountQuark } from "@openstrm/shared";
import type { ShareUpdateSignal } from "../drive/types.js";
import { isAbortError } from "../../lib/errors.js";
import { QuarkError, quarkRequest, unescapeHtml } from "./client.js";

const PAGE_SIZE = 50;
/** 分享没了 / 提取码不对这类换多少次都一样的错误码（41006 分享不存在是真机见过的）；其余靠 message 认 */
const SHARE_GONE_CODES = new Set([41006, 41007, 41008]);
const SHARE_GONE_MESSAGE = /share not exist|stoken|passcode|提取码|分享.*(取消|失效|不存在|过期|删除)|已失效|not found/i;

export class QuarkShareError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = "QuarkShareError";
  }
}

/** 转存任务本身失败 / 暂停 / 超时 */
export class QuarkTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuarkTaskError";
  }
}

function toShareError(err: unknown): unknown {
  if (err instanceof QuarkError && err.code !== undefined && err.code !== 0) {
    if (err.code === 31001 || err.code === 31004) return err;
    if (SHARE_GONE_CODES.has(err.code) || SHARE_GONE_MESSAGE.test(err.message)) return new QuarkShareError(err.message, err.code, err.status);
  }
  return err;
}

export interface QuarkShareFile {
  fid: string;
  name: string;
  isDir: boolean;
  size: number;
  /** 转存时要一并传的 share_fid_token */
  token: string;
  /** 毫秒 */
  modifiedAt: number;
}

interface RawShareFile {
  fid?: string;
  file_name?: string;
  dir?: boolean;
  file?: boolean;
  size?: number;
  updated_at?: number;
  share_fid_token?: string;
}

const stokenCache = new LRUCache<string, { stoken: string; title: string }>({ max: 500, ttl: 30 * 60 * 1000 });

/** 仅供测试 */
export function clearQuarkShareCaches(): void {
  stokenCache.clear();
}

const stokenKey = (account: AccountQuark, pwdId: string, passcode: string): string => `${account.name}\0${pwdId}\0${passcode}`;

/** stoken 失效（41008）时丢掉缓存，下次重新换 */
export function forgetQuarkShareToken(account: AccountQuark, pwdId: string, passcode: string): void {
  stokenCache.delete(stokenKey(account, pwdId, passcode));
}

/** stoken 按账号 + pwd_id + 提取码缓存半小时（stoken 是拿哪个账号换的就只对它有效）；顺带拿到分享标题 */
export async function quarkShareToken(
  account: AccountQuark,
  pwdId: string,
  passcode: string,
  signal?: AbortSignal,
): Promise<{ stoken: string; title: string }> {
  const key = stokenKey(account, pwdId, passcode);
  const cached = stokenCache.get(key);
  if (cached) return cached;
  let body: { data?: { stoken?: string; title?: string } };
  try {
    body = await quarkRequest<{ stoken?: string; title?: string }>(account, "POST", "/share/sharepage/token", {
      data: { pwd_id: pwdId, passcode },
      signal,
    });
  } catch (err) {
    throw toShareError(err);
  }
  const stoken = body.data?.stoken;
  if (!stoken) throw new QuarkShareError(`夸克：没有拿到分享 ${pwdId} 的 stoken`);
  const value = { stoken, title: unescapeHtml(String(body.data?.title ?? "")) };
  stokenCache.set(key, value);
  return value;
}

/** 列分享目录的一页（50 条）。pdir_fid "0" 是分享根 */
export async function quarkShareList(
  account: AccountQuark,
  pwdId: string,
  stoken: string,
  pdirFid: string,
  page: number,
  signal?: AbortSignal,
): Promise<{ list: QuarkShareFile[]; total: number | undefined }> {
  let body: { data?: { list?: RawShareFile[] }; metadata?: Record<string, unknown> };
  try {
    body = await quarkRequest<{ list?: RawShareFile[] }>(account, "GET", "/share/sharepage/detail", {
      params: {
        pwd_id: pwdId,
        stoken,
        pdir_fid: pdirFid || "0",
        force: 0,
        _page: page,
        _size: PAGE_SIZE,
        _fetch_banner: 0,
        _fetch_share: 0,
        _fetch_total: 1,
        _sort: "file_type:asc,updated_at:desc",
        ver: 2,
      },
      signal,
    });
  } catch (err) {
    throw toShareError(err);
  }
  const list = (body.data?.list ?? [])
    .filter((f) => f.fid)
    .map((f) => ({
      fid: String(f.fid),
      name: unescapeHtml(String(f.file_name ?? "")),
      // 分享列表里 dir 是目录标记；有的版本只有 file
      isDir: f.dir === true || (f.dir == null && f.file === false),
      size: Number(f.size ?? 0),
      token: String(f.share_fid_token ?? ""),
      modifiedAt: Number(f.updated_at ?? 0),
    }));
  // 拿不到 _total 就不猜：调用方按「这页满不满」决定翻不翻
  const total = Number(body.metadata?._total);
  return { list, total: Number.isFinite(total) ? total : undefined };
}

export const QUARK_SHARE_PAGE_SIZE = PAGE_SIZE;

interface RawIncUpdate {
  /** 服务端是异步算的：false 表示还没算完 */
  finish?: boolean;
  share_inc_update?: { list?: unknown[]; total?: number };
}

/**
 * 相对这个账号上次转存，分享有没有新增（追更用）。
 * 真 cookie 验证过：自己转存过的分享回 200，`share_inc_update.list` 为空就是没更新；没转存过回 41043；41040 也是没更新。
 * 只当信号用：具体新增了什么仍靠整棵列目录对比，所以列表非空、算不出来（finish=false / 结构不认识）都按「不知道」处理。
 */
export async function quarkShareIncUpdate(
  account: AccountQuark,
  pwdId: string,
  stoken: string,
  signal?: AbortSignal,
): Promise<ShareUpdateSignal> {
  try {
    const body = await quarkRequest<RawIncUpdate>(account, "POST", "/share/inc_update_list", {
      data: { pwd_id: pwdId, stoken, page: 1, page_size: PAGE_SIZE },
      signal,
    });
    const d = body.data;
    if (!d || d.finish === false) return "unknown";
    const inc = d.share_inc_update;
    const n = Array.isArray(inc?.list) ? inc.list.length : Number(inc?.total);
    if (!Number.isFinite(n)) return "unknown";
    return n > 0 ? "some" : "none";
  } catch (err) {
    if (err instanceof QuarkError) {
      if (err.code === 41040) return "none";
      if (err.code === 41043) return "unknown";
    }
    throw toShareError(err);
  }
}

/** 提交转存，返回任务 id；完成要用 quarkWaitTask 盯 */
export async function quarkShareSave(
  account: AccountQuark,
  input: { pwdId: string; stoken: string; items: Array<{ id: string; token: string }>; toPdirFid: string },
  signal?: AbortSignal,
): Promise<{ taskId: string }> {
  let body: { data?: { task_id?: string } };
  try {
    body = await quarkRequest<{ task_id?: string }>(account, "POST", "/share/sharepage/save", {
      params: { uc_param_str: "", app: "clouddrive", __dt: Math.floor(60_000 + Math.random() * 240_000), __t: Date.now() },
      data: {
        fid_list: input.items.map((i) => i.id),
        fid_token_list: input.items.map((i) => i.token),
        to_pdir_fid: input.toPdirFid,
        pwd_id: input.pwdId,
        stoken: input.stoken,
        pdir_fid: "0",
        scene: "link",
      },
      signal,
    });
  } catch (err) {
    throw toShareError(err);
  }
  const taskId = body.data?.task_id;
  if (!taskId) throw new QuarkTaskError("夸克：转存没有返回 task_id");
  return { taskId: String(taskId) };
}

export interface QuarkTaskResult {
  status: number;
  /** 转存进来的顶层 fid */
  topIds: string[];
  title: string;
}

interface RawTask {
  status?: number;
  task_title?: string;
  save_as?: { save_as_top_fids?: Array<string | number> };
}

/** 轮询转存任务到终态：0.5s 起步、最长 2s 一次，默认最多等 15 分钟 */
export async function quarkWaitTask(
  account: AccountQuark,
  taskId: string,
  { signal, timeoutMs = 15 * 60_000 }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<QuarkTaskResult> {
  const deadline = Date.now() + timeoutMs;
  let delay = 500;
  let pollFailures = 0;
  for (let retry = 0; ; retry++) {
    let body: { data?: RawTask };
    try {
      body = await quarkRequest<RawTask>(account, "GET", "/task", {
        params: { task_id: taskId, retry_index: retry, __dt: Math.floor(60_000 + Math.random() * 240_000), __t: Date.now() },
        signal,
      });
      pollFailures = 0;
    } catch (err) {
      // 转存任务在服务端已经建好了，查进度抖一下不能算转存失败（追更会因此把同样的东西再存一遍）；
      // 登录态没了或连着 5 次都查不到才放弃
      const loggedOut = err instanceof QuarkError && (err.code === 31001 || err.code === 31004 || err.status === 401);
      if (isAbortError(err) || loggedOut || ++pollFailures >= 5) throw err;
      await sleep(delay, undefined, { signal });
      delay = Math.min(Math.round(delay * 1.5), 2000);
      continue;
    }
    const d = body.data;
    const status = Number(d?.status ?? 0);
    const title = String(d?.task_title ?? "");
    if (status === 2) return { status, topIds: (d?.save_as?.save_as_top_fids ?? []).map(String), title };
    if (status === 3) throw new QuarkTaskError(`夸克转存任务失败${title ? `：${title}` : ""}`);
    if (status === 4) throw new QuarkTaskError(`夸克转存任务已暂停${title ? `：${title}` : ""}`);
    if (Date.now() > deadline) throw new QuarkTaskError(`夸克转存任务超时（${Math.round(timeoutMs / 60_000)} 分钟）`);
    await sleep(delay, undefined, { signal });
    delay = Math.min(Math.round(delay * 1.5), 2000);
  }
}

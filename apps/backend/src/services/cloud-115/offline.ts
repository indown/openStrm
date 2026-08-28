/**
 * 115 云下载（离线下载）接口，对应 p115client 的 offline_* 系列。
 *
 * 两类入口：
 *   - 列表 / 删除 / 清空 / 重试走 https://lixian.115.com/web/lixian/?ac=…，只要 cookie，
 *     和 115 网页版一致（2026-08 用真实账号验证过 task_lists / get_quota_info）。
 *   - 添加任务走 https://lixian.115.com/lixianssp/?ac=add_task_urls：
 *     请求体是 RSA 加密后的 JSON，响应里的 data 也是 RSA 密文，
 *     用的是和 ufile/download 同一套 crypto.ts。这条路不需要网页版的 sign/time。
 *
 * 字段含义（真实响应对照）：
 *   - file_id      目标目录 id（等于 wp_path_id），**不是**下载产物
 *   - delete_file_id 下载产物（文件或目录）的 id；BT 任务两者相同
 *   - del_path     产物在目标目录下的名字
 *   - file_category 1 文件 / 0 目录
 *   - status       -1 失败、0 等待、1 下载中、2 完成；status_text 是 115 给的中文说明
 *   - move         -1 表示下载完了但转存失败（一般是空间不足）
 */
import { request115, type AccountInfo } from "./client.js";
import { decrypt, encrypt } from "./crypto.js";
import { parseJsonBigIntSafe } from "./life.js";

const WEB_LIXIAN = "https://lixian.115.com/web/lixian/";
const LIXIAN_SSP = "https://lixian.115.com/lixianssp/";
const DOWNPATH = "https://webapi.115.com/offine/downpath";
const SSP_APP_VER = "99.99.99.99";
const SSP_USER_AGENT = `Mozilla/5.0 115disk/${SSP_APP_VER} 115Browser/${SSP_APP_VER} 115wangpan_android/${SSP_APP_VER}`;
/** 独立的限流通道：界面上刷列表不该和取直链抢同一个槽位 */
const LIMITER_CHANNEL = "offline";
/** 一次最多提交多少条链接；115 单次接口本来也吃不下太多 */
export const MAX_URLS_PER_ADD = 100;

export type OfflineTaskState = "pending" | "downloading" | "done" | "failed" | "unknown";

export interface OfflineTask {
  infoHash: string;
  name: string;
  url: string;
  size: number;
  /** 0-100 */
  percent: number;
  /** 115 原始状态码 */
  status: number;
  state: OfflineTaskState;
  /** 115 给的中文说明，没有就按 status 兜底 */
  statusText: string;
  /** unix 秒 */
  addTime: number;
  lastUpdate: number;
  leftTime: number;
  peers: number;
  rateDownload: number;
  /** 目标目录 id */
  dirId: string;
  /** 下载产物 id */
  resultId: string;
  /** 下载产物在目标目录下的名字 */
  resultName: string;
  isDir: boolean;
  move: number;
  pickCode: string;
}

export interface OfflineListPage {
  page: number;
  pageCount: number;
  pageSize: number;
  count: number;
  /** 剩余配额；接口没给就是 null */
  quota: number | null;
  total: number | null;
  tasks: OfflineTask[];
}

export interface OfflineAddResult {
  url: string;
  ok: boolean;
  infoHash?: string;
  name?: string;
  message?: string;
}

export interface OfflineDownPath {
  id: string;
  name: string;
  selected: boolean;
}

/** 清空列表的 flag：0 已完成 / 1 全部 / 2 已失败 / 3 进行中 / 4 已完成+删源文件 / 5 全部+删源文件 */
export type OfflineClearFlag = 0 | 1 | 2 | 3 | 4 | 5;

/* ------------------------------- 传输层 ------------------------------- */

type Params = Record<string, string | number | undefined>;

/** 走网络的那一层拆出来，测试直接换掉，不用碰 axios */
export interface OfflineTransport {
  /** /web/lixian/?ac=…：GET 时参数进 query，POST 时进 form */
  web(accountInfo: AccountInfo, ac: string, params: Params, method: "GET" | "POST"): Promise<unknown>;
  /** /lixianssp/?ac=…：payload 整体 RSA 加密后 POST，返回已解密的 data */
  ssp(accountInfo: AccountInfo, ac: string, payload: Params): Promise<unknown>;
  /** GET webapi offine/downpath */
  downPath(accountInfo: AccountInfo): Promise<unknown>;
}

function compact(params: Params): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return out;
}

const realTransport: OfflineTransport = {
  async web(accountInfo, ac, params, method) {
    const form = compact({ ...params, ac });
    if (method === "GET") {
      const text = await request115<string>(`${WEB_LIXIAN}?${new URLSearchParams(form)}`, {
        method: "GET",
        useCommonHeaders: true,
        accountInfo,
        rawText: true,
        limiterChannel: LIMITER_CHANNEL,
      });
      return parseJsonBigIntSafe(text, `lixian ${ac}`);
    }
    const text = await request115<string>(`${WEB_LIXIAN}?ac=${encodeURIComponent(ac)}`, {
      method: "POST",
      data: new URLSearchParams(form),
      useCommonHeaders: true,
      accountInfo,
      rawText: true,
      limiterChannel: LIMITER_CHANNEL,
    });
    return parseJsonBigIntSafe(text, `lixian ${ac}`);
  },

  async ssp(accountInfo, ac, payload) {
    const body = { ...compact(payload), ac, app_ver: SSP_APP_VER };
    const text = await request115<string>(`${LIXIAN_SSP}?ac=${encodeURIComponent(ac)}`, {
      method: "POST",
      headers: { "User-Agent": SSP_USER_AGENT },
      data: new URLSearchParams({ data: encrypt(JSON.stringify(body)) }),
      useCommonHeaders: true,
      accountInfo,
      rawText: true,
      limiterChannel: LIMITER_CHANNEL,
    });
    const outer = parseJsonBigIntSafe<{ state?: boolean; data?: unknown; error?: string; errno?: number }>(
      text,
      `lixianssp ${ac}`,
    );
    return { ...outer, data: decodeSspData(outer.data) };
  },

  async downPath(accountInfo) {
    const text = await request115<string>(DOWNPATH, {
      method: "GET",
      useCommonHeaders: true,
      accountInfo,
      rawText: true,
      limiterChannel: LIMITER_CHANNEL,
    });
    return parseJsonBigIntSafe(text, "offine/downpath");
  },
};

let transport: OfflineTransport = realTransport;

/** 仅供测试：换掉网络层；传 null 恢复 */
export function setOfflineTransport(next: OfflineTransport | null): void {
  transport = next ?? realTransport;
}

/** ssp 响应的 data 通常是 RSA 密文；偶尔 115 直接给明文 JSON，和 p115client 一样两种都认 */
export function decodeSspData(data: unknown): unknown {
  if (typeof data !== "string" || !data) return data;
  try {
    return parseJsonBigIntSafe(decrypt(data), "lixianssp data");
  } catch {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
}

/* ------------------------------- 响应校验 ------------------------------- */

type Envelope = { state?: boolean; errno?: number | null; error?: string | null; error_msg?: string; errcode?: number };

/** 115 的失败说法不统一：state=false、errno≠0、error_msg 都见过；task_lists 干脆没有 state 字段 */
export function offlineErrorOf(resp: unknown): string | null {
  if (!resp || typeof resp !== "object") return "115 返回了空响应";
  const r = resp as Envelope;
  const failed = r.state === false || (typeof r.errno === "number" && r.errno !== 0);
  if (!failed) return null;
  return r.error_msg || r.error || `errno=${r.errno ?? "?"}`;
}

function ensureOk(resp: unknown, what: string): void {
  const err = offlineErrorOf(resp);
  if (err) throw new Error(`115 ${what}失败：${err}`);
}

/* ------------------------------- 归一化 ------------------------------- */

const STATE_BY_STATUS: Record<number, OfflineTaskState> = {
  [-1]: "failed",
  0: "pending",
  1: "downloading",
  2: "done",
};

const TEXT_BY_STATE: Record<OfflineTaskState, string> = {
  failed: "下载失败",
  pending: "等待中",
  downloading: "下载中",
  done: "下载成功",
  unknown: "未知状态",
};

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: unknown): string => (v == null ? "" : String(v));

export function normalizeOfflineTask(raw: Record<string, unknown>): OfflineTask {
  const status = num(raw.status, Number.NaN);
  const move = num(raw.move, 0);
  let state: OfflineTaskState = STATE_BY_STATUS[status] ?? "unknown";
  // 下载完了但转存失败（一般是网盘满了）：对用户来说就是失败
  if (move === -1) state = "failed";
  const name = str(raw.name);
  return {
    infoHash: str(raw.info_hash),
    name,
    url: str(raw.url),
    size: num(raw.size),
    percent: Math.max(0, Math.min(100, num(raw.percentDone))),
    status: Number.isNaN(status) ? -999 : status,
    state,
    statusText: move === -1 ? "转存失败（网盘空间不足）" : str(raw.status_text) || TEXT_BY_STATE[state],
    addTime: num(raw.add_time),
    lastUpdate: num(raw.last_update),
    leftTime: num(raw.left_time),
    peers: num(raw.peers),
    rateDownload: num(raw.rateDownload),
    dirId: str(raw.wp_path_id ?? raw.file_id),
    resultId: str(raw.delete_file_id),
    resultName: str(raw.del_path) || name,
    isDir: String(raw.file_category ?? "1") === "0",
    move,
    pickCode: str(raw.pick_code),
  };
}

export function normalizeOfflineListPage(resp: unknown): OfflineListPage {
  const r = (resp ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(r.tasks) ? (r.tasks as Record<string, unknown>[]) : [];
  return {
    page: num(r.page, 1),
    pageCount: num(r.page_count, 1),
    pageSize: num(r.page_size ?? r.page_row, rows.length),
    count: num(r.count, rows.length),
    quota: r.quota == null ? null : num(r.quota),
    total: r.total == null ? null : num(r.total),
    tasks: rows.map(normalizeOfflineTask),
  };
}

/**
 * add_task_urls 解密后的 data：多条时是 `{ result: [...] }`，每条 `{ state, errno, error_msg, info_hash, name, url }`；
 * 单条接口是扁平的；整体失败时只有 `{ state:false, error_msg }`。按提交顺序对齐到 urls。
 */
export function normalizeAddResults(data: unknown, urls: string[]): OfflineAddResult[] {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const rows: Record<string, unknown>[] = Array.isArray(d.result)
    ? (d.result as Record<string, unknown>[])
    : d.info_hash || d.url || d.name
      ? [d]
      : [];

  const toResult = (row: Record<string, unknown>, url: string): OfflineAddResult => {
    const err = offlineErrorOf(row);
    return {
      url,
      ok: err === null,
      infoHash: str(row.info_hash) || undefined,
      name: str(row.name) || undefined,
      message: err ?? undefined,
    };
  };

  if (rows.length === 0) {
    const message = offlineErrorOf(d) ?? "115 没有返回任务信息";
    return urls.map((url) => ({ url, ok: false, message }));
  }
  // 115 会把 url 原样回在每一条里；对不上（极少）就按顺序对齐
  const byUrl = new Map<string, Record<string, unknown>>();
  for (const row of rows) if (typeof row.url === "string") byUrl.set(row.url, row);
  return urls.map((url, i) => {
    const row = byUrl.get(url) ?? rows[i];
    if (!row) return { url, ok: false, message: "115 没有返回这条链接的结果" };
    return toResult(row, url);
  });
}

/* ------------------------------- 链接整理 ------------------------------- */

const SUPPORTED_SCHEME = /^(magnet:\?|ed2k:\/\/|https?:\/\/|ftp:\/\/)/i;
const INFO_HASH = /^(?:[0-9a-f]{40}|[a-z2-7]{32})$/i;

/**
 * 把用户贴进来的一坨文本整理成可提交的链接：按行拆、去空白、去重；
 * 裸的 info_hash 补成磁力链（p115client 也是这么等价的）；
 * 其它协议（thunder:// 之类）115 不收，单独列出来告诉用户。
 */
export function normalizeOfflineUrls(input: string | string[]): { urls: string[]; invalid: string[] } {
  const lines = (Array.isArray(input) ? input : input.split(/\r?\n/)).map((s) => s.trim()).filter(Boolean);
  const urls: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    let url = line;
    if (INFO_HASH.test(line)) url = `magnet:?xt=urn:btih:${line.toLowerCase()}`;
    else if (!SUPPORTED_SCHEME.test(line)) {
      invalid.push(line);
      continue;
    }
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return { urls, invalid };
}

/* ------------------------------- 接口 ------------------------------- */

export async function offlineList(accountInfo: AccountInfo, page = 1, pageSize = 30): Promise<OfflineListPage> {
  const resp = await transport.web(accountInfo, "task_lists", { page, page_size: pageSize }, "GET");
  ensureOk(resp, "读取云下载列表");
  return normalizeOfflineListPage(resp);
}

/** 剩余 / 总配额 */
export async function offlineQuota(accountInfo: AccountInfo): Promise<{ quota: number; total: number }> {
  const resp = (await transport.web(accountInfo, "get_quota_info", {}, "GET")) as Record<string, unknown>;
  ensureOk(resp, "读取云下载配额");
  return { quota: num(resp.quota), total: num(resp.total) };
}

/**
 * 添加一批链接。dirId 不传就落到 115 自己的默认目录。
 * 单条链接失败不抛：结果逐条返回，让界面把"任务已存在"这类说明贴到对应行。
 */
export async function offlineAddUrls(
  accountInfo: AccountInfo,
  urls: string[],
  opts: { dirId?: string; savePath?: string } = {},
): Promise<OfflineAddResult[]> {
  if (urls.length === 0) return [];
  if (urls.length > MAX_URLS_PER_ADD) throw new Error(`一次最多提交 ${MAX_URLS_PER_ADD} 条链接`);
  const payload: Params = {};
  urls.forEach((u, i) => (payload[`url[${i}]`] = u));
  if (opts.dirId) payload.wp_path_id = opts.dirId;
  if (opts.savePath) payload.savepath = opts.savePath;
  const resp = (await transport.ssp(accountInfo, "add_task_urls", payload)) as { state?: boolean; data?: unknown };
  // 外层 state=false 且没有 data：cookie 失效、风控之类，整批失败
  if (resp?.data == null) {
    const message = offlineErrorOf(resp) ?? "115 没有返回任务信息";
    return urls.map((url) => ({ url, ok: false, message }));
  }
  return normalizeAddResults(resp.data, urls);
}

/** 删除任务；deleteFiles 为 true 时连已下载的文件一起删 */
export async function offlineRemove(accountInfo: AccountInfo, infoHashes: string[], deleteFiles = false): Promise<void> {
  if (infoHashes.length === 0) return;
  const payload: Params = { flag: deleteFiles ? 1 : 0 };
  infoHashes.forEach((h, i) => (payload[`hash[${i}]`] = h));
  ensureOk(await transport.web(accountInfo, "task_del", payload, "POST"), "删除云下载任务");
}

export async function offlineClear(accountInfo: AccountInfo, flag: OfflineClearFlag): Promise<void> {
  ensureOk(await transport.web(accountInfo, "task_clear", { flag }, "POST"), "清空云下载列表");
}

export async function offlineRestart(accountInfo: AccountInfo, infoHash: string): Promise<void> {
  ensureOk(await transport.web(accountInfo, "restart", { info_hash: infoHash }, "POST"), "重试云下载任务");
}

/** 115 记着的默认下载目录（可能多个，selected 的那个是当前默认） */
export async function offlineDownPaths(accountInfo: AccountInfo): Promise<OfflineDownPath[]> {
  const resp = (await transport.downPath(accountInfo)) as { data?: Record<string, unknown>[] };
  ensureOk(resp, "读取默认下载目录");
  return (Array.isArray(resp.data) ? resp.data : []).map((d) => ({
    id: str(d.file_id),
    name: str(d.file_name),
    selected: String(d.is_selected ?? "0") === "1",
  }));
}

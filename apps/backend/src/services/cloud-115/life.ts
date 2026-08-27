/**
 * 115「生活事件」接口封装。
 *
 * 115 会把用户在网盘上的每一次操作（上传/移动/改名/删除…）记录成一条生活事件，
 * 通过 behavior/detail 接口可以按倒序把它们拉出来，从而在不做全量目录扫描的前提下
 * 感知网盘文件变动。
 *
 * 参考实现：DDSRem-Dev/MoviePilot-Plugins 的 p115strmhelper 插件，
 * 以及本仓库 vendored 的 p115client/p115client/tool/life.py。
 */
import axios from "axios";
import { request115, type AccountInfo } from "./client.js";

/** 事件类型 → 名称，取自 p115client 的 BEHAVIOR_TYPE_TO_NAME，并补上 proapi 才有的 23/24 */
export const BEHAVIOR_TYPE_TO_NAME: Record<number, string> = {
  1: "upload_image_file",
  2: "upload_file",
  3: "star_image",
  4: "star_file",
  5: "move_image_file",
  6: "move_file",
  7: "browse_image",
  8: "browse_video",
  9: "browse_audio",
  10: "browse_document",
  14: "receive_files",
  17: "new_folder",
  18: "copy_folder",
  19: "folder_label",
  20: "folder_rename",
  22: "delete_file",
  23: "copy_file",
  24: "rename_file",
};

/** 纯浏览/标记类事件，拉取时直接跳过（但仍占用同 file_id 的去重位） */
export const IGNORE_BEHAVIOR_TYPES = new Set([3, 4, 7, 8, 9, 10, 19]);

/** 出现新路径 → 需要生成 strm */
export const CREATE_TYPES = new Set([1, 2, 14, 18, 23]);
/** 移动 */
export const MOVE_TYPES = new Set([5, 6]);
/** 改名 */
export const RENAME_TYPES = new Set([20, 24]);
/** 删除 */
export const REMOVE_TYPES = new Set([22]);
/** 新建目录，只补路径缓存 */
export const NEW_FOLDER_TYPES = new Set([17]);

export interface LifeEvent {
  id: string;
  type: number;
  /** 0 = 目录，1 = 文件 */
  file_category: number;
  file_id: string;
  parent_id: string;
  file_name: string;
  file_size: number;
  sha1: string;
  pick_code: string;
  update_time: number;
  create_time: number;
}

export interface LifeCursor {
  /** 起始时间戳（秒，含）。事件 update_time 小于它就停 */
  fromTime: number;
  /** 起始事件 id（不含）。事件 id 小于等于它就停 */
  fromId: string;
}

export type LifeApp = "web" | "ios" | "android";

/** 超过这个位数的整数在 JS 里已经不精确，一律转成字符串保管 */
const BIG_INT_DIGITS = 16;

/**
 * 115 的 file_id / 事件 id 是 19 位整数，超过 JS 安全整数范围，
 * JSON.parse 会静默丢精度（3040163688862324736 → 3040163688862324700）。
 * 这里在解析前把超长整数字面量加上引号。
 *
 * 用扫描而不是正则：正则要么漏掉数组里的元素，要么会误伤字符串内容里
 * 恰好长得像数字的片段（文件名完全可能出现），扫描时跟踪引号状态才是准的。
 */
export function parseJsonBigIntSafe<T>(text: string, context = ""): T {
  let out = "";
  let inString = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inString) {
      out += ch;
      if (ch === "\\") {
        // 转义序列整体照抄，避免把 \" 误判成字符串结束
        if (i + 1 < text.length) out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    // 必须整段消费一个完整的 JSON number，不能只吃连续数字：
    // 只吃数字的话，0.9007199254740993000 会被当成「短整数 0」加「长整数 9007...」，
    // 于是给小数部分加上引号，得到 0."9007..." 这种非法 JSON；
    // 负数同理会变成 -"1234..."。
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i;
      if (text[j] === "-") j++;
      const intStart = j;
      while (j < text.length && text[j] >= "0" && text[j] <= "9") j++;
      const intDigits = text.slice(intStart, j);

      let isPlainInt = true;
      if (text[j] === ".") {
        isPlainInt = false;
        j++;
        while (j < text.length && text[j] >= "0" && text[j] <= "9") j++;
      }
      if (text[j] === "e" || text[j] === "E") {
        isPlainInt = false;
        j++;
        if (text[j] === "+" || text[j] === "-") j++;
        while (j < text.length && text[j] >= "0" && text[j] <= "9") j++;
      }

      const token = text.slice(i, j);
      // 只有「纯整数且长到 JS 存不下」才转成字符串，浮点/科学计数原样放过
      out += isPlainInt && intDigits.length >= BIG_INT_DIGITS ? `"${token}"` : token;
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  try {
    return JSON.parse(out) as T;
  } catch (err) {
    // 光报 "Unterminated fractional number" 没法定位是哪个接口，带上来源和片段
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `解析 115 响应失败${context ? `（${context}）` : ""}：${msg}；原始片段 ${text.slice(0, 300)}`,
      { cause: err },
    );
  }
}

function httpStatusOf(err: unknown): number | undefined {
  if (axios.isAxiosError(err)) return err.response?.status;
  return undefined;
}

/** 405 是 115 对 proapi 的常见风控返回，需要降级到 webapi */
export function is405(err: unknown): boolean {
  if (httpStatusOf(err) === 405) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("405") || msg.includes("Method Not Allowed");
}

/**
 * 开启 115 生活的事件记录开关。不开的话 behavior/detail 会一直返回空。
 * POST https://life.115.com/api/1.0/web/1.0/calendar/setoption
 */
export async function enableLifeCalendar(
  accountInfo: AccountInfo,
): Promise<{ ok: boolean; message: string }> {
  const form = new URLSearchParams({ locus: "1", open_life: "1" });
  const resp = await request115<{ state?: boolean; errno?: number; error?: string; message?: string }>(
    "https://life.115.com/api/1.0/web/1.0/calendar/setoption",
    {
      method: "POST",
      data: form,
      useCommonHeaders: true,
      accountInfo,
      limiterChannel: "life",
    },
  );
  const ok = resp?.state !== false && !resp?.errno;
  return { ok, message: ok ? "已开启" : resp?.error || resp?.message || `errno=${resp?.errno}` };
}

interface BehaviorDetailResp {
  state?: boolean;
  errno?: number;
  error?: string;
  data?: { count?: number | string; list?: LifeEvent[] };
}

/**
 * 拉一页生活事件明细。
 * web  → GET https://webapi.115.com/behavior/detail
 * app  → GET https://proapi.115.com/{app}/behavior/detail（更快，但更容易被风控返 405）
 */
async function fetchBehaviorDetail(
  accountInfo: AccountInfo,
  params: { limit: number; offset: number; type?: string; date?: string },
  app: LifeApp,
): Promise<BehaviorDetailResp> {
  const base =
    app === "web"
      ? "https://webapi.115.com/behavior/detail"
      : `https://proapi.115.com/${app}/behavior/detail`;
  const q = new URLSearchParams({
    type: params.type ?? "",
    limit: String(params.limit),
    offset: String(params.offset),
  });
  if (params.date) q.set("date", params.date);

  const text = await request115<string>(`${base}?${q}`, {
    method: "GET",
    useCommonHeaders: true,
    accountInfo,
    rawError: true,
    rawText: true,
    limiterChannel: "life",
  });
  return parseJsonBigIntSafe<BehaviorDetailResp>(text, `behavior/detail app=${app}`);
}

/** 事件是否已经落在游标之前（列表是倒序的，命中即可整轮停止） */
export function reachedCursor(ev: LifeEvent, cursor: LifeCursor): boolean {
  if (cursor.fromId && cursor.fromId !== "0") {
    // 19 位 id 用字符串比较会出错，长度不同时先比长度
    const a = String(ev.id);
    const b = cursor.fromId;
    if (a.length < b.length || (a.length === b.length && a <= b)) return true;
  }
  if (cursor.fromTime > 0 && Number(ev.update_time) < cursor.fromTime) return true;
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PullOptions {
  accountInfo: AccountInfo;
  cursor: LifeCursor;
  app?: LifeApp;
  /** 两次翻页之间的冷却，默认 2s，和 p115client 保持一致 */
  cooldownMs?: number;
  /** 单轮最多翻多少页，防止全量模式下无限翻 */
  maxPages?: number;
  /** 首批拉取条数；默认有游标 64、无游标 1000（与 p115client 一致） */
  firstBatchSize?: number;
  signal?: AbortSignal;
}

/**
 * 单轮拉取：从最新一条开始往回翻，翻到游标为止。
 *
 * 返回值是**倒序**（新 → 旧）的事件数组，已按 file_id 去重（只保留每个文件最新的一条），
 * 并已剔除浏览/标星类事件。
 */
export async function pullLifeEvents(opts: PullOptions): Promise<LifeEvent[]> {
  const { accountInfo, cursor, app = "ios", cooldownMs = 2000, maxPages = 50, signal } = opts;
  const hasCursor = (cursor.fromId && cursor.fromId !== "0") || cursor.fromTime > 0;

  const out: LifeEvent[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let limit = opts.firstBatchSize ?? (hasCursor ? 64 : 1000);
  // 每页返回后由 count 覆盖；循环体内先赋值再读，无需初值
  let total: number;

  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) break;
    const resp = await fetchBehaviorDetail(accountInfo, { limit, offset }, app);
    if (resp?.state === false || resp?.errno) {
      throw new Error(`115 behavior/detail error: ${resp.error || resp.errno || "unknown"}`);
    }
    const list = resp?.data?.list ?? [];
    if (list.length === 0) break;
    total = Number(resp?.data?.count ?? 0) || list.length;

    for (const ev of list) {
      if (reachedCursor(ev, cursor)) return out;
      const fid = String(ev.file_id);
      if (seen.has(fid)) continue;
      // 忽略类事件同样占位：它会挡住同一文件更早的事件，与 p115client 行为一致
      seen.add(fid);
      if (IGNORE_BEHAVIOR_TYPES.has(Number(ev.type))) continue;
      out.push(ev);
    }

    offset += list.length;
    if (offset >= total) break;
    limit = 1000;
    if (cooldownMs > 0) await sleep(cooldownMs);
  }

  return out;
}

/** 一个目录的祖先链，根在最前（cid 为 "0"） */
export interface Ancestor {
  cid: string;
  pid: string;
  name: string;
}

/**
 * 一次请求拿到某个目录的完整祖先链。
 * GET https://webapi.115.com/files?cid=<cid>&limit=1&… 的响应里带一个 `path` 数组，
 * 就是从根到该目录的每一级，可以一把写进 path_cache。
 */
export async function fetchAncestors(
  accountInfo: AccountInfo,
  cid: string,
): Promise<Ancestor[] | null> {
  const q = new URLSearchParams({
    aid: "1",
    cid: String(cid),
    limit: "1",
    offset: "0",
    show_dir: "1",
    count_folders: "1",
    record_open_time: "1",
    cur: "1",
    nf: "1",
    hide_data: "1",
  });
  const text = await request115<string>(`https://webapi.115.com/files?${q}`, {
    method: "GET",
    useCommonHeaders: true,
    accountInfo,
    rawError: true,
    rawText: true,
    limiterChannel: "life",
  });
  const resp = parseJsonBigIntSafe<{
    state?: boolean;
    errno?: number;
    path?: Array<{ cid: string | number; pid: string | number; name: string }>;
  }>(text, `files 祖先链 cid=${cid}`);
  if (!resp?.path || !Array.isArray(resp.path)) return null;
  return resp.path.map((p) => ({
    cid: String(p.cid),
    pid: String(p.pid),
    name: p.name ?? "",
  }));
}

/** 列一个目录下的直接子项（用于展开新增目录），返回归一化后的条目 */
export interface DirEntry {
  fileId: string;
  parentId: string;
  name: string;
  isDir: boolean;
  pickCode: string;
  size: number;
}

export async function listDir(
  accountInfo: AccountInfo,
  cid: string,
  offset = 0,
  limit = 1000,
): Promise<{ entries: DirEntry[]; total: number }> {
  const q = new URLSearchParams({
    aid: "1",
    cid: String(cid),
    limit: String(limit),
    offset: String(offset),
    show_dir: "1",
    count_folders: "1",
    record_open_time: "1",
  });
  const text = await request115<string>(`https://webapi.115.com/files?${q}`, {
    method: "GET",
    useCommonHeaders: true,
    accountInfo,
    rawError: true,
    rawText: true,
    limiterChannel: "life",
  });
  const resp = parseJsonBigIntSafe<{
    state?: boolean;
    count?: number | string;
    data?: Array<Record<string, unknown>>;
  }>(text, `files 列目录 cid=${cid} offset=${offset}`);
  const rows = resp?.data ?? [];
  const entries: DirEntry[] = rows.map((r) => {
    // 目录项只有 cid/pid，文件项有 fid/cid（cid 此时是父目录）
    const isDir = r.fid === undefined || r.fid === null;
    return {
      fileId: String(isDir ? r.cid : r.fid),
      parentId: String(isDir ? r.pid : r.cid),
      name: String(r.n ?? ""),
      isDir,
      pickCode: String(r.pc ?? ""),
      size: Number(r.s ?? 0),
    };
  });
  return { entries, total: Number(resp?.count ?? entries.length) };
}

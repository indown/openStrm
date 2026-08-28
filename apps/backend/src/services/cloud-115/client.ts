// 115 export-dir end-to-end implementation using real 115 APIs.
import axios, { type AxiosRequestConfig } from "axios";
import { defer, firstValueFrom, Observable } from "rxjs";
import { encrypt, decrypt } from "./crypto.js";
import { LRUCache } from "lru-cache";
import { readAppSettings } from "../../db/repositories/settings.js";
import { enqueueForAccount } from "../download/rate-limited.js";
import { moduleLogger } from "../../lib/logger.js";
import { TreeBuilder } from "../task/tree.js";
import { DEFAULT_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, guardIdleStream } from "../../lib/http.js";

const log = moduleLogger("cloud-115");

// 定义账户信息类型（导出供 115share 等模块使用）
export interface AccountInfo {
  name: string;
  cookie: string;
  accountType?: string;
  url?: string;
  token?: string;
}

type RequestCtx = { userAgent?: string; accountInfo: AccountInfo };

/**
 * 115 接口回了非 2xx。
 * 以前直接把响应体 throw 出去（不是 Error）：调用方拿到的 message 是 "[object Object]"，
 * 执行历史和 Telegram 通知里全是这个；封控（405）也只能靠在字符串里找数字。
 */
export class Cloud115Error extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    url?: string,
  ) {
    super(`115 接口返回 ${status}${pathOf(url)}: ${summarizeBody(body)}`);
    this.name = "Cloud115Error";
  }
}

function pathOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return ` (${new URL(url).pathname})`;
  } catch {
    return "";
  }
}

function summarizeBody(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 200);
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const msg = b.error ?? b.message ?? b.error_msg;
    if (typeof msg === "string" && msg) return msg;
    try {
      return JSON.stringify(body).slice(0, 200);
    } catch {
      return "[unserializable body]";
    }
  }
  return String(body);
}

/** 导出任务查询接口的 data 部分 */
type ExportDirResult = {
  export_id?: string;
  file_id?: string | number;
  file_name?: string;
  pick_code?: string;
};

interface ExportDirParseOptions {
  /** 要导出的目录 id，可以多个 */
  exportFileIds?: number | string | Array<number | string>;
  /** 传字符串时视为已有导出文件的 pick_code，跳过导出这一步 */
  exportId?: number | string;
  /** 目录层数上限，<= 0 不限 */
  layerLimit?: number;
  timeoutMs?: number;
  checkIntervalMs?: number;
  userAgent?: string;
  accountInfo: AccountInfo;
  /** 调用方一直在传的两个参数，这条链路其实用不上 */
  targetPid?: number;
  deleteAfter?: boolean;
}

/**
 * 三份缓存都封顶。以前是裸 Map、过期项没人清：浏览/同步过几万个目录之后条目只增不减
 * （filesListCache 每项还是一个最多 1000 条的数组），compose 限的 1 GB 内存迟早被顶爆。
 */
const dirIdCache = new LRUCache<string, { id: number }>({ max: 5000, ttl: 10 * 60 * 1000 });
/** 网盘目录项：n 名字、fid 文件 id、cid 目录 id、fc 类别、sha 文件哈希（目录为空） */
export type DriveEntry = { n: string; fid: number; cid: number; fc: number; sha?: string | null };
const filesListCache = new LRUCache<string, { data: DriveEntry[]; count?: number }>({ max: 2000, ttl: 5 * 60 * 1000 });
const pickcodeCache = new LRUCache<string, string>({ max: 20_000, ttl: 30 * 60 * 1000 });

export async function exportDirParse(options: ExportDirParseOptions) {
  const {
    exportFileIds = 0, // number | string | string[]
    exportId = 0, // number | string; if string => it's pickcode, skip export
    layerLimit = 0, // number; <=0 no limit
    timeoutMs = 10 * 60 * 1000, // default 10 minutes
    checkIntervalMs = 1000, // polling interval
    userAgent = defaultUA(), // optional: override user-agent; some endpoints validate UA
    accountInfo, // required: account information
  } = options;

  if (!accountInfo?.cookie) throw new Error("accountInfo.cookie is required");

  let pickcode: string | undefined;
  let result: ExportDirResult | undefined;
  // let mustDelete = !!deleteAfter;
  const mustDelete = true;

  if (!exportId) {
    // 1) Submit export task
    const file_ids = Array.isArray(exportFileIds)
      ? exportFileIds.join(",")
      : String(exportFileIds);
    const target = `U_1_0`;

    const exportResp = await fsExportDir(
      {
        file_ids,
        target,
        layer_limit: layerLimit > 0 ? layerLimit : undefined,
      },
      { userAgent, accountInfo }
    );
    const export_id = ensureOk(exportResp)?.data?.export_id;
    if (!export_id) throw new Error("Failed to get export_id");

    // 2) Poll result
    result = await exportDirResult(export_id, {
      userAgent,
      timeoutMs,
      checkIntervalMs,
      accountInfo,
    });
    pickcode = result.pick_code;
  } else if (typeof exportId === "string") {
    pickcode = exportId;
  }
  if (!pickcode) throw new Error("Failed to get pick_code");

  // 3) Resolve download URL (try web first, then app as fallback)
  const url = await getDownloadUrlWeb(pickcode, { userAgent, accountInfo });
  
  if (!url) throw new Error("Failed to resolve download URL");

  // 4) Download and parse
  const fileIdForDelete = result && result.file_id;
  try {
    const stream = await openFileStream(url, { userAgent });
    const tree = new TreeBuilder();
    for await (const path of parseExportDirAsPathIter(stream)) {
      // 导出文件末尾的空行会被解析器折进最后一条路径，所以每段都要去掉首尾空白（含换行）
      tree.add(path.split("/").map((part) => part.trim()).filter(Boolean));
    }
    return tree.nodes;
  } finally {
    // 5) Optionally delete export file
    // if (mustDelete && fileIdForDelete) {
    if (mustDelete) {
      try {
        await fsDelete(String(fileIdForDelete), { userAgent, accountInfo });
      } catch {
        // 导出文件删不掉不影响结果，下次导出会覆盖
      }
    }
  }
}
// 从路径获取对应的 115 文件/目录 ID - 简化版本
export async function getIdToPath(options: {
  path: string;
  userAgent?: string;
  accountInfo?: AccountInfo;
}) {
  const {
    path,
    userAgent = defaultUA(),
    accountInfo,
  } = options || {};

  if (!accountInfo?.cookie) throw new Error('accountInfo.cookie is required');
  if (!path) throw new Error('path is required');

  log.debug(`[getIdToPath] Looking for file: ${path}`);

  // 解析路径，例如 "a/b/c.mkv" -> ["a", "b", "c.mkv"]
  const pathParts = path.split('/').filter(p => p);

  if (pathParts.length === 0) {
    return 0; // 根目录
  }

  // 如果是单层路径，直接查找
  if (pathParts.length === 1) {
    log.debug(`[getIdToPath] Searching in root directory for: ${pathParts[0]}`);
    const files = await listDirEntries(0, { userAgent, accountInfo });
    
    for (const file of files) {
      if (file.n === pathParts[0]) {
        log.debug(`[getIdToPath] Found file in root: ${pathParts[0]}, cid: ${file.cid}`);
        return file.cid;
      }
    }
    throw new Error(`File not found: ${pathParts[0]}`);
  }

  // 多层路径：先获取目录路径的 ID
  const dirPath = pathParts.slice(0, -1).join('/');
  const fileName = pathParts[pathParts.length - 1];
  
  log.debug(`[getIdToPath] Searching in directory: ${dirPath} for file: ${fileName}`);
  
  // 使用 fsDirGetId 获取目录 ID
  try {
    const dirResp = await fsDirGetId(dirPath, { userAgent, accountInfo });
    const dirId = dirResp.id;
    
    if (!dirId) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    log.debug(`[getIdToPath] Directory ID for ${dirPath}: ${dirId}`);

    // 列出目录中的文件
    const files = await listDirEntries(dirId, { userAgent, accountInfo });
    log.debug(`[getIdToPath] Found ${files.length} files in directory ${dirPath}`);
    
    // 查找目标文件
    for (const file of files) {
      if (file.n === fileName) {
        log.debug(`[getIdToPath] Found target file: ${fileName}, fid: ${file.fid}`);
        const pickcode = await getPickcodeToId(file.fid, { userAgent, accountInfo });
        log.debug(`[getIdToPath] Successfully got pickcode for ${path}: ${pickcode}`);
        return pickcode;
      }
    }
    
    // 列出目录中的所有文件以便调试
    const fileNames = files.map((f) => f.n);
    log.debug({ files: fileNames }, `[getIdToPath] Available files in ${dirPath}`);
    throw new Error(`File not found: ${fileName} in directory: ${dirPath}. Available files: ${fileNames.join(', ')}`);
  } catch (error) {
    log.error({ err: error }, `[getIdToPath] Error getting directory ID for ${dirPath}`);
    throw error;
  }
}

// 通过路径获取目录 ID
export async function fsDirGetId(path: string, { userAgent, accountInfo }: { userAgent?: string; app?: string; accountInfo?: AccountInfo }) {
  if (!accountInfo?.cookie) throw new Error('accountInfo.cookie is required');
  
  // 生成缓存键
  const cacheKey = `dir_id:${path}:${accountInfo.cookie.substring(0, 20)}`; // 使用路径和cookie前20位作为键
  
  // 尝试从缓存获取
  const cached = dirIdCache.get(cacheKey);
  if (cached) {
    log.debug(`[CACHE HIT] Directory ID for path: ${path}`);
    return cached;
  }

  log.debug(`[CACHE MISS] Fetching directory ID for path: ${path}`);
  const url = 'https://webapi.115.com/files/getid';
  const params = new URLSearchParams({ path });
  const data = await request115<{ id: number }>(url + '?' + params, {
    method: 'GET',
    userAgent,
    ensureOk: true,
    useCommonHeaders: true,
    accountInfo,
  });
  
  // 缓存结果
  dirIdCache.set(cacheKey, data);
  return data;
}

// 获取目录中的文件列表
export async function fsFiles(cid: number | string, { userAgent, limit = 1000, offset = 0, accountInfo }: { 
  userAgent?: string; 
  app?: string; 
  limit?: number; 
  offset?: number; 
  accountInfo?: AccountInfo;
}) {
  if (!accountInfo?.cookie) throw new Error('accountInfo.cookie is required');
  
  // 生成缓存键
  const cacheKey = `files:${String(cid)}:${limit}:${offset}:${accountInfo.cookie.substring(0, 20)}`;
  
  // 尝试从缓存获取
  const cached = filesListCache.get(cacheKey);
  if (cached) {
    log.debug(`[CACHE HIT] Files list for cid: ${cid}`);
    return cached;
  }

  log.debug(`[CACHE MISS] Fetching files list for cid: ${cid}`);
  const url = 'https://webapi.115.com/files';
  const params = new URLSearchParams({
    cid: String(cid),
    limit: String(limit),
    offset: String(offset),
  });
  const data = await request115<{ data: DriveEntry[]; count?: number }>(url + '?' + params, {
    method: 'GET',
    userAgent,
    ensureOk: true,
    useCommonHeaders: true,
    accountInfo,
  });
  
  // 缓存结果
  filesListCache.set(cacheKey, data);
  return data;
}


/**
 * 整个目录的条目。files 接口一页最多 1000 条，以前只取第一页：
 * 超过 1000 个文件的目录，后面的文件一律 "File not found"——全量同步重试三次后失败，
 * 代理侧则退回转码。按 count 翻页直到取完。
 *
 * @param fetchPage 测试用，默认就是 fsFiles
 */
export async function listDirEntries(
  cid: number | string,
  ctx: RequestCtx,
  fetchPage: typeof fsFiles = fsFiles,
): Promise<DriveEntry[]> {
  const limit = 1000;
  const all: DriveEntry[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = await fetchPage(cid, { ...ctx, limit, offset });
    const items = page.data ?? [];
    all.push(...items);
    const count = typeof page.count === "number" ? page.count : undefined;
    if (items.length < limit || (count !== undefined && all.length >= count)) break;
  }
  return all;
}

/* ------------------------ HTTP helpers (real 115 APIs) ------------------------ */

// POST https://proapi.115.com/android/2.0/ufile/export_dir
async function fsExportDir(
  payload: Record<string, string | number | undefined>,
  { userAgent, accountInfo }: RequestCtx,
) {
  const url = "https://proapi.115.com/android/2.0/ufile/export_dir";
  const form = new URLSearchParams();
  // Only include defined values
  Object.entries(payload).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") form.append(k, String(v));
  });
  return request115<{ data?: { export_id?: string } }>(url, {
    method: 'POST',
    data: form,
    userAgent,
    useCommonHeaders: true,
    accountInfo,
  });
}

// GET https://webapi.115.com/files/export_dir?export_id=...
async function fsExportDirStatus(exportId: string, { userAgent, accountInfo }: RequestCtx) {
  const url =
    "https://webapi.115.com/files/export_dir?export_id=" +
    encodeURIComponent(exportId);
  return request115<{ data: ExportDirResult }>(url, {
    method: 'GET',
    userAgent,
    useCommonHeaders: true,
    accountInfo,
  });
}

async function exportDirResult(
  exportId: string,
  { userAgent, timeoutMs, checkIntervalMs, accountInfo }: RequestCtx & { timeoutMs: number; checkIntervalMs: number },
): Promise<ExportDirResult> {
  const deadline = isFinite(timeoutMs) ? Date.now() + timeoutMs : Infinity;
  while (true) {
    const resp = await fsExportDirStatus(exportId, { userAgent, accountInfo });
    
    // 检查响应是否有效
    if (resp && resp.data) {
      // 如果 export_id 存在，就可以返回数据
      if (resp.data.export_id) {
        return resp.data;
      }
    }
    
    if (Date.now() >= deadline)
      throw new Error(`Timeout waiting export result: ${exportId}`);
    if (checkIntervalMs > 0) await sleep(checkIntervalMs);
  }
}
export async function request115<T = unknown>(
  url: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    data?: unknown;
    userAgent?: string;
    responseType?: AxiosRequestConfig['responseType'];
    ensureOk?: boolean;
    useCommonHeaders?: boolean;
    accountInfo?: AccountInfo;
    /** 抛出原始 AxiosError 而不是响应体，调用方需要 HTTP 状态码时用（如 405 降级） */
    rawError?: boolean;
    /** 拿未经 JSON.parse 的原始响应文本，用于自行处理超出 JS 安全整数的 id */
    rawText?: boolean;
    /** 覆盖限流通道；默认 `${account}:normal` */
    limiterChannel?: string;
    maxConcurrent?: number;
  }
) {
  const {
    method = "GET",
    headers = {},
    data,
    userAgent,
    responseType,
    ensureOk: shouldEnsureOk = false,
    useCommonHeaders = true,
    accountInfo,
    rawError = false,
    rawText = false,
    limiterChannel = "normal",
    maxConcurrent,
  } = options || {};
  const settings = readAppSettings();
  const downloadConfig = settings.download ?? {};
  // 从 accountInfo 中获取 cookie
  const cookie = accountInfo?.cookie || null;
  
  // accountInfo 现在可以在函数内部使用，用于根据账户类型进行不同的处理
  // 例如：根据 accountInfo.accountType 设置不同的请求头或参数  
  try {
    const mergedHeaders = {
      ...(useCommonHeaders ? commonHeaders({ cookie: cookie || "", userAgent }) : {}),
      ...headers,
      ...(cookie && !useCommonHeaders ? { "Cookie": cookie } : {}),
    };
    const config: AxiosRequestConfig = {
      method: method.toLowerCase(),
      url,
      headers: mergedHeaders,
      // 115 的 CDN / WAF 会把连接黑洞掉；没有超时的话卡住的请求把限流槽位占到进程重启
      timeout: DEFAULT_TIMEOUT_MS,
    };
    if (data !== undefined) config.data = data;
    if (responseType) config.responseType = responseType;
    if (rawText) {
      config.responseType = "text";
      config.transformResponse = [(d: unknown) => d];
    }
    const accountKey = accountInfo?.name + ':' + limiterChannel;
    const obs$ = enqueueForAccount(accountKey, () =>
      defer(() => new Observable<T>((observer) => {
        axios(config)
          .then((response) => {
            observer.next(response.data as T);
            observer.complete();
          })
          .catch((err) => observer.error(err));
      })),
      maxConcurrent ?? downloadConfig.linkMaxConcurrent ?? 2
    );
    const respData = await firstValueFrom(obs$);
    if (shouldEnsureOk) ensureOk(respData as unknown as Record<string, unknown>, url);
    return respData;
  } catch (error) {
    if (!rawError && axios.isAxiosError(error) && error.response) {
      throw new Cloud115Error(error.response.status, error.response.data, error.config?.url);
    }
    throw error;
  }
}
// POST https://proapi.115.com/android/2.0/ufile/download
// Use the same getUrl function as the Node.js script
export async function getDownloadUrlWeb(pickcode: string | number, { userAgent, accountInfo }: RequestCtx) {
  const data = `data=${encodeURIComponent(encrypt(`{"pick_code":"${pickcode}"}`))}`;
    const response = await request115<{ data: string }>(
      `https://proapi.115.com/android/2.0/ufile/download`,
      {
        method: 'POST',
        headers: { "User-Agent": userAgent ?? defaultUA(), "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(data)) },
        data,
        userAgent,
        useCommonHeaders: false,
        accountInfo,
      }
    );
    const decryptedData = JSON.parse(decrypt(response.data));
    return decryptedData.url;
}

export async function getPickcodeToId(id: number, { userAgent = defaultUA(), accountInfo }: { userAgent?: string; accountInfo?: AccountInfo }) {
  if (!accountInfo?.cookie) throw new Error('accountInfo.cookie is required');
  
  // 生成缓存键
  const cacheKey = `pickcode:${id}:${accountInfo.cookie.substring(0, 20)}`;
  
  // 尝试从缓存获取
  const cached = pickcodeCache.get(cacheKey);
  if (cached) {
    log.debug(`[CACHE HIT] Pickcode for file ID: ${id}`);
    return cached;
  }

  log.debug(`[CACHE MISS] Fetching pickcode for file ID: ${id}`);
  const response = await request115<{ state: boolean; data: Array<{ pick_code: string }> }>(
    `https://webapi.115.com/files/file?file_id=${id}`,
    {
      method: 'GET',
      headers: { "User-Agent": userAgent },
      userAgent,
      useCommonHeaders: false,
      accountInfo,
    }
  );
  
  if (!response.state) throw new Error(JSON.stringify(response));
  
  const pickcode = response.data[0].pick_code;
  
  // 缓存结果
  pickcodeCache.set(cacheKey, pickcode);
  return pickcode;
}

/* ------------------------ 115 分享接口 (对应 p115client P115ShareFileSystem) ------------------------ */
const SHARE_BASE = "https://webapi.115.com";

/** 分享快照/列目录 GET share/snap */
export async function shareSnap(
  accountInfo: AccountInfo,
  params: { share_code: string; receive_code?: string; limit?: number; cid?: string; offset?: number },
  opts?: { userAgent?: string }
) {
  if (!accountInfo?.cookie) throw new Error("accountInfo.cookie is required");
  const url = `${SHARE_BASE}/share/snap`;
  const q = new URLSearchParams();
  q.set("share_code", params.share_code);
  if (params.receive_code != null) q.set("receive_code", params.receive_code);
  if (params.limit != null) q.set("limit", String(params.limit));
  if (params.cid != null) q.set("cid", String(params.cid));
  if (params.offset != null) q.set("offset", String(params.offset));
  return request115<{ state?: boolean; errno?: number; data?: Record<string, unknown> & { list?: unknown[] }; list?: unknown[] }>(
    url + "?" + q.toString(),
    {
      method: "GET",
      userAgent: opts?.userAgent ?? defaultUA(),
      useCommonHeaders: true,
      accountInfo,
    }
  );
}

/** 分享下载链接 GET share/download_url */
export async function shareDownloadUrl(
  accountInfo: AccountInfo,
  shareCode: string,
  receiveCode: string,
  fileId: number | string,
  opts?: { userAgent?: string }
) {
  if (!accountInfo?.cookie) throw new Error("accountInfo.cookie is required");
  const url = `${SHARE_BASE}/share/download_url`;
  const q = new URLSearchParams({
    share_code: shareCode,
    receive_code: receiveCode || "",
    file_id: String(fileId),
  });
  return request115<{ state?: boolean; errno?: number; data?: { url?: string }; url?: string }>(
    url + "?" + q.toString(),
    {
      method: "GET",
      userAgent: opts?.userAgent ?? defaultUA(),
      useCommonHeaders: true,
      accountInfo,
    }
  );
}

/** 转存到我的网盘 POST share/receive */
export async function shareReceive(
  accountInfo: AccountInfo,
  shareCode: string,
  receiveCode: string,
  fileIds: number | string | (number | string)[],
  toPid: string,
  opts?: { userAgent?: string }
) {
  if (!accountInfo?.cookie) throw new Error("accountInfo.cookie is required");
  const url = `${SHARE_BASE}/share/receive`;
  const fileIdStr = Array.isArray(fileIds) ? fileIds.join(",") : String(fileIds);
  const form = new URLSearchParams();
  form.set("share_code", shareCode);
  form.set("receive_code", receiveCode || "");
  form.set("file_id", fileIdStr);
  form.set("cid", String(toPid));
  return request115<{ state?: boolean; errno?: number; error?: string }>(url, {
    method: "POST",
    data: form,
    userAgent: opts?.userAgent ?? defaultUA(),
    useCommonHeaders: true,
    accountInfo,
    ensureOk: true,
  });
}

// POST https://webapi.115.com/rb/delete (fs_delete)
async function fsDelete(fileId: string | number, { userAgent, accountInfo }: RequestCtx) {
  const url = "https://webapi.115.com/rb/delete";
  const form = new URLSearchParams();
  form.set("fid[0]", String(fileId));
  return request115(url, {
    method: 'POST',
    data: form,
    userAgent,
    useCommonHeaders: true,
    accountInfo,
  });
}

// fetchJson removed after consolidating on request115

function commonHeaders({ cookie, userAgent }: { cookie: string; userAgent?: string }) {
  return {
    "User-Agent": userAgent || defaultUA(),
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Referer: "https://115.com/",
    Origin: "https://115.com",
    Cookie: cookie,
  };
}

/* ------------------------ Stream fetch + parser ------------------------ */

// Fetch the download URL and return a ReadableStream of bytes
// Use axios to match downloadOrCreateStrm behavior and handle 302
async function openFileStream(url: string, { userAgent }: { userAgent?: string }) {
  
  const headers = {
    "User-Agent": userAgent,
  };

  // Use axios exactly like downloadOrCreateStrm - let it handle 302 automatically
  const res = await axios.get(url, {
    headers,
    responseType: 'stream',
    timeout: DEFAULT_TIMEOUT_MS,
  });

  const nodeStream = res.data; // Node.js Readable
  if (!nodeStream || typeof nodeStream.on !== 'function') {
    throw new Error('Response is not a readable stream');
  }
  // 导出文件可能几十 MB；CDN 把连接黑洞掉的话，没有这个看门狗整个同步就永远挂在这里
  guardIdleStream(nodeStream, STREAM_IDLE_TIMEOUT_MS, "115 目录导出文件下载");
  // Wrap Node Readable into Web ReadableStream
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer) => controller.enqueue(chunk));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (err: unknown) => controller.error(err));
    },
    cancel() {
      if (typeof nodeStream.destroy === 'function') {
        nodeStream.destroy();
      }
    },
  });
}

// Parse the exported directory tree (UTF-16 lines) into path strings
export async function* parseExportDirAsPathIter(readableStream: ReadableStream<Uint8Array>) {
  const reader = readableStream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const buf = concatUint8(chunks);
  // Most 115 exported files are UTF-16 with BOM; TextDecoder('utf-16') handles it.
  const decoder = new TextDecoder("utf-16");
  const text = decoder.decode(buf);

  const lines = text.split("\n");
  if (lines.length === 0 || !lines[0]) return;

  const cre = /^(?:\| )+\|-(.*)/;
  // The first line keeps "  /<root>" with leading "  " per Python: removesuffix("\n")[3:]
  const first = lines[0].replace(/\r$/, "");
  let root = first.length >= 3 ? first.slice(3) : first;
  let stack: string[];
  if (root === "根目录") {
    stack = [""];
    root = "/";
  } else {
    root = "/" + escapeName(root);
    stack = [root];
  }

  let depth = 0;
  // Emit first value same as Python behavior
  yield root;

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i].replace(/\r$/, "");
    const m = cre.exec(rawLine);
    if (!m) {
      stack[depth] = (stack[depth] || "") + "\n" + rawLine;
      continue;
    }
    const nameRaw = m[1];
    const nameEsc = escapeName(nameRaw);
    // depth count: (len(line) - len(name)) // 2 - 1
    const delta = Math.floor((rawLine.length - nameRaw.length) / 2) - 1;
    if (depth) {
      yield stack[depth];
    }
    depth = delta;
    const parent = stack[depth - 1] || "";
    const path = (parent ? parent : "") + "/" + nameEsc;
    stack[depth] = path;
  }
  if (depth) {
    yield stack[depth];
  }
}

/* ------------------------ Utils ------------------------ */

function concatUint8(parts: Uint8Array[]) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function escapeName(s: string) {
  // Mirror Python default behavior when escape=True in parse_export_dir_as_path_iter
  if (s === "." || s === "..") return "\\" + s;
  return s.replaceAll("/", "\\/");
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultUA() {
  // 从配置文件读取user-agent
  const settings = readAppSettings();
  if (settings['user-agent']) {
    return settings['user-agent'];
  }
  
  // 默认UA作为fallback
  return "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/116.0.5845.89 Mobile/15E148 Safari/604.1";
}

/**
 * 2xx 但 state=false / errno≠0 的响应。以前把整个响应体 JSON.stringify 进 message，
 * 界面上弹出来的是一坨 {"state":false,"errNo":990001,...}；115 的 error 字段本来就是给人看的中文。
 */
export function ensureOk<T>(resp: T, url?: string): NonNullable<T> {
  const r = resp as { errno?: unknown; error?: unknown; state?: boolean; request?: unknown } | null | undefined;
  if (!r || r.errno || r.state === false) {
    const reason = typeof r?.error === "string" ? r.error.trim() : "";
    const where = url ? pathOf(url).trim() : typeof r?.request === "string" ? `(${r.request})` : "";
    const meta = [r?.errno ? `errno ${r.errno}` : "", where.replace(/^\(|\)$/g, "")].filter(Boolean).join("，");
    if (reason) throw new Error(`115：${reason}${meta ? `（${meta}）` : ""}`);
    throw new Error(`115 接口出错${where ? ` ${where}` : ""}: ${summarizeBody(resp)}`);
  }
  return resp as NonNullable<T>;
}

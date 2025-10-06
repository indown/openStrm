// 115 export-dir end-to-end implementation using real 115 APIs.
import axios from "axios";
import { encrypt, decrypt } from "./115crypto";
import { SimpleCache } from "./SimpleCache";
import { readSettings } from "./serverUtils";

// 创建缓存实例
const dirIdCache = new SimpleCache<{ id: number }>(10 * 60 * 1000); // 目录ID缓存10分钟
const filesListCache = new SimpleCache<{ data: Array<{ n: string; fid: number; cid: number; fc: number }> }>(5 * 60 * 1000); // 文件列表缓存5分钟
const pickcodeCache = new SimpleCache<string>(30 * 60 * 1000); // pickcode缓存30分钟

// 缓存管理函数
export function clearAllCaches(): void {
  dirIdCache.clear();
  filesListCache.clear();
  pickcodeCache.clear();
  console.log("[CACHE] All caches cleared");
}

export function cleanupExpiredCaches(): void {
  dirIdCache.cleanup();
  filesListCache.cleanup();
  pickcodeCache.cleanup();
  console.log("[CACHE] Expired cache entries cleaned up");
}

export function getCacheStats(): { dirId: number; files: number; pickcode: number } {
  // 使用类型断言访问私有属性
  const dirIdSize = (dirIdCache as unknown as { cache: Map<string, unknown> }).cache.size;
  const filesSize = (filesListCache as unknown as { cache: Map<string, unknown> }).cache.size;
  const pickcodeSize = (pickcodeCache as unknown as { cache: Map<string, unknown> }).cache.size;
  
  return {
    dirId: dirIdSize,
    files: filesSize,
    pickcode: pickcodeSize
  };
}
export async function exportDirParse(options) {
  const {
    cookie, // required: string cookie for 115
    exportFileIds = 0, // number | string | string[]
    exportId = 0, // number | string; if string => it's pickcode, skip export
    layerLimit = 0, // number; <=0 no limit
    timeoutMs = 10 * 60 * 1000, // default 10 minutes
    checkIntervalMs = 1000, // polling interval
    userAgent = defaultUA(), // optional: override user-agent; some endpoints validate UA
  } = options || {};

  if (!cookie) throw new Error("cookie is required");

  let pickcode;
  let result; // { export_id, file_id, file_name, pick_code }
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
      { cookie, userAgent }
    );
    const export_id = ensureOk(exportResp)?.data?.export_id;
    if (!export_id) throw new Error("Failed to get export_id");

    // 2) Poll result
    result = await exportDirResult(export_id, {
      cookie,
      userAgent,
      timeoutMs,
      checkIntervalMs,
    });
    pickcode = result.pick_code;
  } 

  // 3) Resolve download URL (try web first, then app as fallback)
  const url = await getDownloadUrlWeb(pickcode, { cookie, userAgent });
  
  if (!url) throw new Error("Failed to resolve download URL");

  // 4) Download and parse
  const fileIdForDelete = result && result.file_id;
  try {
    const stream = await openFileStream(url, { cookie, userAgent });
    const treeData: Array<{ depth: number; key: number; name: string; parent_key: number }> = [];
    let keyCounter = 0;
    
    // 添加根节点
    treeData.push({
      depth: 0,
      key: keyCounter++,
      name: '',
      parent_key: 0
    });
    
    for await (const path of parseExportDirAsPathIter(stream)) {
      const pathParts = path.split('/').filter(part => part !== '');
      let parentKey = 0;
      
      for (let i = 0; i < pathParts.length; i++) {
        const name = pathParts[i].trim(); // 去除前后空白字符包括换行符
        const depth = i;
        
        // 查找是否已经存在这个路径节点
        const existingNode = treeData.find(node => 
          node.depth === depth && 
          node.name === name && 
          node.parent_key === parentKey
        );
        
        if (!existingNode) {
          // 创建新节点
          const newNode = {
            depth,
            key: keyCounter++,
            name,
            parent_key: parentKey
          };
          treeData.push(newNode);
          parentKey = newNode.key;
        } else {
          parentKey = existingNode.key;
        }
      }
    }
    
    return treeData;
  } finally {
    // 5) Optionally delete export file
    // if (mustDelete && fileIdForDelete) {
    if (mustDelete) {
      try {
        await fsDelete(String(fileIdForDelete), { cookie, userAgent });
      } catch {
      }
    }
  }
}
// 从路径获取对应的 115 文件/目录 ID - 简化版本
export async function get_id_to_path(options: {
  cookie: string;
  path: string;
  userAgent?: string;
}) {
  const {
    cookie,
    path,
    userAgent = defaultUA(),
  } = options || {};

  if (!cookie) throw new Error('cookie is required');
  if (!path) throw new Error('path is required');

  console.log(`[get_id_to_path] Looking for file: ${path}`);

  // 解析路径，例如 "a/b/c.mkv" -> ["a", "b", "c.mkv"]
  const pathParts = path.split('/').filter(p => p);

  if (pathParts.length === 0) {
    return 0; // 根目录
  }

  // 如果是单层路径，直接查找
  if (pathParts.length === 1) {
    console.log(`[get_id_to_path] Searching in root directory for: ${pathParts[0]}`);
    const files = await fs_files(0, { cookie, userAgent });
    
    for (const file of files.data || []) {
      if (file.n === pathParts[0]) {
        console.log(`[get_id_to_path] Found file in root: ${pathParts[0]}, cid: ${file.cid}`);
        return file.cid;
      }
    }
    throw new Error(`File not found: ${pathParts[0]}`);
  }

  // 多层路径：先获取目录路径的 ID
  const dirPath = pathParts.slice(0, -1).join('/');
  const fileName = pathParts[pathParts.length - 1];
  
  console.log(`[get_id_to_path] Searching in directory: ${dirPath} for file: ${fileName}`);
  
  // 使用 fs_dir_getid 获取目录 ID
  try {
    const dirResp = await fs_dir_getid(dirPath, { cookie, userAgent });
    const dirId = dirResp.id;
    
    if (!dirId) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    console.log(`[get_id_to_path] Directory ID for ${dirPath}: ${dirId}`);

    // 列出目录中的文件
    const files = await fs_files(dirId, { cookie, userAgent });
    console.log(`[get_id_to_path] Found ${files.data?.length || 0} files in directory ${dirPath}`);
    
    // 查找目标文件
    for (const file of files.data || []) {
      if (file.n === fileName) {
        console.log(`[get_id_to_path] Found target file: ${fileName}, fid: ${file.fid}`);
        const pickcode = await getPickcodeToId(file.fid, { cookie, userAgent });
        console.log(`[get_id_to_path] Successfully got pickcode for ${path}: ${pickcode}`);
        return pickcode;
      }
    }
    
    // 列出目录中的所有文件以便调试
    const fileNames = files.data?.map(f => f.n) || [];
    console.log(`[get_id_to_path] Available files in ${dirPath}:`, fileNames);
    throw new Error(`File not found: ${fileName} in directory: ${dirPath}. Available files: ${fileNames.join(', ')}`);
  } catch (error) {
    console.error(`[get_id_to_path] Error getting directory ID for ${dirPath}:`, error);
    throw error;
  }
}

// 通过路径获取目录 ID
export async function fs_dir_getid(path: string, { cookie, userAgent }: { cookie: string; userAgent?: string; app?: string }) {
  // 生成缓存键
  const cacheKey = `dir_id:${path}:${cookie.substring(0, 20)}`; // 使用路径和cookie前20位作为键
  
  // 尝试从缓存获取
  const cached = dirIdCache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] Directory ID for path: ${path}`);
    return cached;
  }

  console.log(`[CACHE MISS] Fetching directory ID for path: ${path}`);
  const url = 'https://webapi.115.com/files/getid';
  const params = new URLSearchParams({ path });
  
  const response = await axios.get(url + '?' + params, {
    headers: commonHeaders({ cookie, userAgent }),
  });

  const data = response.data;
  ensureOk(data);
  
  // 缓存结果
  dirIdCache.set(cacheKey, data);
  return data;
}

// 获取目录中的文件列表
export async function fs_files(cid: number, { cookie, userAgent, limit = 1000, offset = 0 }: { 
  cookie: string; 
  userAgent?: string; 
  app?: string; 
  limit?: number; 
  offset?: number; 
}) {
  // 生成缓存键
  const cacheKey = `files:${cid}:${limit}:${offset}:${cookie.substring(0, 20)}`;
  
  // 尝试从缓存获取
  const cached = filesListCache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] Files list for cid: ${cid}`);
    return cached;
  }

  console.log(`[CACHE MISS] Fetching files list for cid: ${cid}`);
  const url = 'https://webapi.115.com/files';
  const params = new URLSearchParams({
    cid: String(cid),
    limit: String(limit),
    offset: String(offset),
  });

  const response = await axios.get(url + '?' + params, {
    headers: commonHeaders({ cookie, userAgent }),
  });

  const data = response.data;
  ensureOk(data);
  
  // 缓存结果
  filesListCache.set(cacheKey, data);
  return data;
}


// 通过文件 ID 获取文件信息
export async function getFileInfoById(fileId: number, { cookie, userAgent }: { cookie: string; userAgent?: string }) {
  const url = `https://webapi.115.com/files/info?fid=${fileId}`;
  const response = await axios.get(url, {
    headers: {
      'User-Agent': userAgent || defaultUA(),
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://115.com/',
      'Origin': 'https://115.com',
      'Cookie': cookie,
    },
  });

  const data = response.data;
  if (data.errno || data.state === false) {
    throw new Error(`115 API error: ${JSON.stringify(data)}`);
  }
  
  return data.data;
}

/* ------------------------ HTTP helpers (real 115 APIs) ------------------------ */

// POST https://proapi.115.com/android/2.0/ufile/export_dir
async function fsExportDir(payload, ctx) {
  const url = "https://proapi.115.com/android/2.0/ufile/export_dir";
  const form = new URLSearchParams();
  // Only include defined values
  Object.entries(payload).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") form.append(k, String(v));
  });
  return fetchJson(
    url,
    {
      method: "POST",
      body: form,
    },
    ctx
  );
}

// GET https://webapi.115.com/files/export_dir?export_id=...
async function fsExportDirStatus(exportId, ctx) {
  const url =
    "https://webapi.115.com/files/export_dir?export_id=" +
    encodeURIComponent(exportId);
  return fetchJson(url, {}, ctx);
}

async function exportDirResult(
  exportId,
  { cookie, userAgent, timeoutMs, checkIntervalMs }
) {
  const deadline = isFinite(timeoutMs) ? Date.now() + timeoutMs : Infinity;
  while (true) {
    const resp = await fsExportDirStatus(exportId, { cookie, userAgent });
    
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
async function request115(url: string, method: string = "GET", headers: Record<string, string> | null = null, data: string | null = null, cookie: string | null = null) {
  try {
    const config: {
      method: string;
      url: string;
      headers: Record<string, string>;
      data?: string;
    } = {
      method: method.toLowerCase(),
      url: url,
      headers: {
        ...headers,
        ...(cookie ? { "Cookie": cookie } : {})
      }
    };
    
    if (data && (method.toUpperCase() === "POST" || method.toUpperCase() === "PUT")) {
      config.data = data;
    }
    
    const response = await axios(config);
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      throw error.response.data;
    }
    throw error;
  }
}
// POST https://proapi.115.com/android/2.0/ufile/download
// Use the same getUrl function as the Node.js script
export async function getDownloadUrlWeb(pickcode, ctx) {
  const { cookie, userAgent } = ctx;
  const data = `data=${encodeURIComponent(encrypt(`{"pick_code":"${pickcode}"}`))}`;
    const response = await request115(
        `http://pro.api.115.com/android/2.0/ufile/download`, 
        "POST", 
        {"User-Agent": userAgent, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(data))}, 
        data, 
        cookie
    );
    const decryptedData = JSON.parse(decrypt((response as { data: string }).data));
    return decryptedData.url;
}

export async function getPickcodeToId(id: number, { cookie, userAgent = defaultUA() }: { cookie: string; userAgent?: string }) {
  // 生成缓存键
  const cacheKey = `pickcode:${id}:${cookie.substring(0, 20)}`;
  
  // 尝试从缓存获取
  const cached = pickcodeCache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] Pickcode for file ID: ${id}`);
    return cached;
  }

  console.log(`[CACHE MISS] Fetching pickcode for file ID: ${id}`);
  const response = await request115(
    `http://web.api.115.com/files/file?file_id=${id}`, 
    "GET", 
    {"User-Agent": userAgent}, 
    null, 
    cookie
  ) as { state: boolean; data: Array<{ pick_code: string }> };
  
  if (!response.state) throw new Error(JSON.stringify(response));
  
  const pickcode = response.data[0].pick_code;
  
  // 缓存结果
  pickcodeCache.set(cacheKey, pickcode);
  return pickcode;
}
// POST https://webapi.115.com/rb/delete (fs_delete)
async function fsDelete(fileId, ctx) {
  const url = "https://webapi.115.com/rb/delete";
  const form = new URLSearchParams();
  form.set("fid[0]", String(fileId));
  return fetchJson(url, { method: "POST", body: form }, ctx);
}

async function fetchJson(url, init, { cookie, userAgent }) {
  try {
    const res = await axios({
      url,
      method: init.method || 'GET',
      data: init.body,
      headers: {
        ...commonHeaders({ cookie, userAgent }),
        ...(init && init.headers ? init.headers : {}),
      },
      maxRedirects: 5,
    });
    return res.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      // Some 115 endpoints return text-first; try a second attempt as JSON via regex
      throw new Error(
        `Unexpected response (not JSON) from ${url}: ${JSON.stringify(error.response.data).slice(0, 256)}`
      );
    }
    throw new Error(`Request error from ${url}: ${error.message}`);
  }
}

function commonHeaders({ cookie, userAgent }) {
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
async function openFileStream(url: string, { userAgent }: { cookie: string; userAgent?: string }) {
  
  const headers = {
    "User-Agent": userAgent,
  };

  // Use axios exactly like downloadOrCreateStrm - let it handle 302 automatically
  const res = await axios.get(url, { 
    headers, 
    responseType: 'stream' 
  });

  const nodeStream = res.data; // Node.js Readable
  if (!nodeStream || typeof nodeStream.on !== 'function') {
    throw new Error('Response is not a readable stream');
  }
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
export async function* parseExportDirAsPathIter(readableStream) {
  const reader = readableStream.getReader();
  const chunks = [];
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
  let stack;
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

function concatUint8(parts) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function escapeName(s) {
  // Mirror Python default behavior when escape=True in parse_export_dir_as_path_iter
  if (s === "." || s === "..") return "\\" + s;
  return s.replaceAll("/", "\\/");
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultUA() {
  // 从配置文件读取user-agent
  const settings = readSettings();
  if (settings['user-agent']) {
    return settings['user-agent'];
  }
  
  // 默认UA作为fallback
  return "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/116.0.5845.89 Mobile/15E148 Safari/604.1";
}

function ensureOk(resp) {
  if (!resp || resp.errno || resp.state === false) {
    throw new Error(`115 API error: ${JSON.stringify(resp)}`);
  }
  return resp;
}

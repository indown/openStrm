/**
 * PanSou 的 HTTP 客户端：只管请求、响应壳和登录，不认识 OpenStrm 的账号和链接规则（那些在 normalize.ts）。
 *
 * PanSou 是用户自己部署的网盘搜索服务：搜 TG 频道和一批资源站插件，链接按网盘类型分组、组内按分数排好。
 * 实测和它的文档有出入的地方都在这里兜住：
 *   - 响应套了一层 `{ code: 0, message, data }`，文档写的是裸对象，两种都认；
 *   - 开了登录（AUTH_ENABLED）时除 health 外都要带 Bearer JWT，没带或过期回 401 + AUTH_TOKEN_*；
 *   - 检测接口是较新的版本才有，老版本回 404。
 */
import axios, { type AxiosResponse } from "axios";
import { isAbortError, messageOf } from "../../lib/errors.js";
import { moduleLogger } from "../../lib/logger.js";

const log = moduleLogger("pansou");

/** 冷查询实测多数 4～8 秒，偶尔要等到它插件的上限（30 秒）才回；不再往上加是为了智能体一次调用守在 40 秒以内 */
let SEARCH_TIMEOUT_MS = 25_000;
const CHECK_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 5_000;
const LOGIN_TIMEOUT_MS = 10_000;
/** JWT 提前这么久当过期，免得请求发出去的路上刚好过期 */
const TOKEN_MARGIN_MS = 5 * 60_000;

export interface PansouConn {
  baseUrl: string;
  username?: string;
  password?: string;
}

/** 分组后的一条链接（res=merge 时 merged_by_type 里那种） */
export interface PansouLink {
  url: string;
  password: string;
  note: string;
  datetime: string;
  /** `tg:频道名` / `plugin:插件名` / `unknown` */
  source: string;
}

export type PansouSrc = "all" | "tg" | "plugin";

export interface PansouSearchResult {
  /** 网盘类型（115 / quark / magnet / baidu…）→ 链接，组内是 PanSou 排好的顺序 */
  byType: Record<string, PansouLink[]>;
}

export interface PansouHealth {
  authEnabled: boolean;
  plugins: string[];
  channels: string[];
}

export type PansouCheckState = "ok" | "bad" | "locked" | "unsupported" | "uncertain";

export interface PansouCheckItem {
  diskType: string;
  url: string;
  password?: string;
}

export interface PansouCheckResult {
  /** 传进去的链接（PanSou 原样带回来） */
  url: string;
  /** PanSou 规范化之后的链接（提取码拼进去了），对号时和 url 一起认 */
  normalizedUrl?: string;
  state: PansouCheckState;
  summary?: string;
}

/**
 * 出错的几类，调用方按它换成给人看的说法和状态码。
 * timeout 单列：PanSou 偶尔一问要等到它插件的上限（实测冷搜有 30 秒才回的），我们掐了它还在后台接着搜、写进缓存，
 * 过半分钟再问同一个词就快了——和连不上是两回事，不能叫人「别再试」
 */
export type PansouErrorKind = "auth" | "rate" | "unavailable" | "timeout" | "bad_response";

export class PansouError extends Error {
  readonly kind: PansouErrorKind;
  /** PanSou 回的 HTTP 状态码；连不上的没有 */
  readonly status?: number;
  /** 对面自己说的那句（已截短、去掉控制字符），message 里拼了它的时候才有：智能体那边只当数据给，不当报错原文 */
  readonly upstream?: string;

  constructor(kind: PansouErrorKind, message: string, status?: number, upstream?: string) {
    super(message);
    this.name = "PansouError";
    this.kind = kind;
    this.status = status;
    if (upstream) this.upstream = upstream;
  }
}

/** 对面回的文字最多取这么长 */
const UPSTREAM_TEXT_MAX = 120;

/**
 * PanSou（或它前面的反代、防护）回的文字：压成一行、去掉控制字符和零宽字符、截短，才拼进报错。
 * 报错会原样到网页、Telegram 和智能体那里，不能让对面塞一大段进来
 */
function upstreamText(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  return s.length > UPSTREAM_TEXT_MAX ? `${s.slice(0, UPSTREAM_TEXT_MAX - 1)}…` : s;
}

/** 地址末尾的 / 和误填的 /api 去掉：填 http://host:8888/api/ 也认 */
export function apiBase(conn: Pick<PansouConn, "baseUrl">): string {
  return `${conn.baseUrl.trim().replace(/\/+$/, "").replace(/\/api$/i, "")}/api`;
}

/* ------------------------------- 登录 ------------------------------- */

const tokens = new Map<string, { token: string; expiresAt: number }>();
/** 同一套凭据同时只登一次：并发的几个请求一起碰上过期时，别各登各的 */
const logins = new Map<string, Promise<string>>();

/** 按整套凭据记：设置里改了密码，旧密码登出来的令牌就不再拿来用（只在内存里） */
const tokenKey = (conn: PansouConn) => JSON.stringify([apiBase(conn), conn.username ?? "", conn.password ?? ""]);

/** 测试用：搜索的超时别真等 25 秒 */
export function __test_setSearchTimeout(ms = 25_000): void {
  SEARCH_TIMEOUT_MS = ms;
}

export function __test_clearPansouTokens(): void {
  tokens.clear();
  logins.clear();
}

/**
 * 登录拿 JWT。PanSou 的 expires_at 是秒；给毫秒的也认。
 * 不接调用方的取消信号：同一套凭据同时只登一次，别的请求在等同一个结果，第一个调用方掐了不能连累它们（登录自己有超时）
 */
export async function pansouLogin(conn: PansouConn): Promise<string> {
  const key = tokenKey(conn);
  const inflight = logins.get(key);
  if (inflight) return inflight;
  const job = (async () => {
    if (!conn.username) throw new PansouError("auth", "PanSou 开了登录，到设置页「资源搜索」填用户名和密码", 401);
    const res = await send(() =>
      axios.post(
        `${apiBase(conn)}/auth/login`,
        { username: conn.username, password: conn.password ?? "" },
        { timeout: LOGIN_TIMEOUT_MS, validateStatus: () => true, headers: { Accept: "application/json" } },
      ),
    );
    // 只有 401 是凭据不对；403、429、5xx 和别的请求一样归类（403 是前面的防护拦的，不是密码错）
    if (res.status === 401) throw new PansouError("auth", "PanSou 的用户名或密码不对，到设置页「资源搜索」改一下", 401);
    classifyStatus(res);
    const body = unwrap(res);
    const token = typeof body.token === "string" ? body.token : "";
    if (!token) throw new PansouError("bad_response", "PanSou 登录没有返回令牌", res.status);
    const raw = Number(body.expires_at);
    const expiresAt = Number.isFinite(raw) && raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : Date.now() + 60 * 60_000;
    tokens.set(key, { token, expiresAt });
    return token;
  })();
  logins.set(key, job);
  try {
    return await job;
  } finally {
    logins.delete(key);
  }
}

function cachedToken(conn: PansouConn): string | undefined {
  const t = tokens.get(tokenKey(conn));
  if (!t) return undefined;
  if (t.expiresAt - TOKEN_MARGIN_MS <= Date.now()) {
    tokens.delete(tokenKey(conn));
    return undefined;
  }
  return t.token;
}

/* ------------------------------- 请求 ------------------------------- */

const TIMEOUT_MESSAGE = "PanSou 等太久没回应";
/** 搜索超时的说法：它多半还在后台接着搜 */
const SEARCH_TIMEOUT_MESSAGE = "PanSou 这一问太久没回：它多半还在后台接着搜，过半分钟再搜一次同一个词就快了";

/** 发出去；连不上、超时换成 PanSouError，取消原样抛（调用方自己掐的） */
async function send(fn: () => Promise<AxiosResponse>): Promise<AxiosResponse> {
  try {
    return await fn();
  } catch (err) {
    if (isAbortError(err)) throw err;
    const code = axios.isAxiosError(err) ? err.code : undefined;
    if (code === "ECONNABORTED" || code === "ETIMEDOUT") throw new PansouError("timeout", TIMEOUT_MESSAGE);
    const why = code === "ECONNREFUSED" ? "连接被拒绝（地址或端口不对，或者 PanSou 没在运行）" : messageOf(err);
    throw new PansouError("unavailable", `连不上 PanSou：${why}`);
  }
}

interface CallOptions {
  data?: unknown;
  timeout: number;
  signal?: AbortSignal;
  /** health 是公开的，不用登录 */
  auth?: boolean;
}

/**
 * 带登录的一次请求：有令牌就带上；回 401 且配了用户名就重登一次再发一次。
 * timeout 管的是整次调用：重新登录花掉的时间也算，重发那一次只用剩下的（智能体那边整趟搜索有预算）。
 * 状态码的归类（429、5xx）也在这里，调用方只剩 2xx 和少数它自己认的（检测接口的 404）
 */
async function call(conn: PansouConn, method: "get" | "post", path: string, opts: CallOptions): Promise<AxiosResponse> {
  const url = `${apiBase(conn)}${path}`;
  const deadline = Date.now() + opts.timeout;
  const once = (token?: string) => {
    const left = deadline - Date.now();
    if (left <= 0) return Promise.reject(new PansouError("timeout", TIMEOUT_MESSAGE));
    return send(() =>
      axios.request({
        method,
        url,
        data: opts.data,
        timeout: left,
        signal: opts.signal,
        validateStatus: () => true,
        headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      }),
    );
  };
  const useAuth = opts.auth !== false;
  const used = useAuth ? cachedToken(conn) : undefined;
  let res = await once(used);
  if (res.status === 401 && useAuth) {
    if (!conn.username) throw new PansouError("auth", "PanSou 开了登录，到设置页「资源搜索」填用户名和密码", 401);
    // 并发的请求可能已经换好了新令牌：有就直接用，没有（或者就是刚被拒的那个）才登录
    const fresh = cachedToken(conn);
    let token = fresh && fresh !== used ? fresh : undefined;
    if (!token) {
      tokens.delete(tokenKey(conn));
      token = await pansouLogin(conn);
    }
    res = await once(token);
    if (res.status === 401) throw new PansouError("auth", "PanSou 不认 OpenStrm 的登录令牌，到设置页「资源搜索」检查一下用户名和密码", 401);
  }
  classifyStatus(res);
  return res;
}

/** 限流、防护、PanSou 自己出错这几种状态码的归类：请求和登录共用 */
function classifyStatus(res: AxiosResponse): void {
  if (res.status === 429) throw new PansouError("rate", "PanSou 限流了，过一会儿再搜", 429);
  // PanSou 自己不回 403（登录失败是 401）：这是它前面的防护拦的，公共实例在请求一多时就这样
  if (res.status === 403) throw new PansouError("rate", "PanSou 前面的防护拦下了请求（HTTP 403），多半是请求太频繁，过一会儿再试", 403);
  if (res.status >= 500) throw new PansouError("unavailable", `PanSou 出错了（HTTP ${res.status}）`, res.status);
}

/** 两种壳都认：`{ code, message, data }` 取 data（code 不是 0 就是出错），裸对象直接用 */
function unwrap(res: AxiosResponse): Record<string, unknown> {
  const body: unknown = res.data;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    // 出错时回的网页（网关、防护的错误页）按状态码说；200 却不是 JSON 才是地址填错了（填成了别的网站）
    if (res.status >= 400) throw new PansouError("bad_response", `PanSou 拒绝了请求（HTTP ${res.status}）`, res.status);
    throw new PansouError("bad_response", "PanSou 返回的不是 JSON：地址填的是 PanSou 吗？", res.status);
  }
  const b = body as Record<string, unknown>;
  const message = upstreamText(b.message) || upstreamText(b.error);
  if (res.status >= 400) {
    throw new PansouError("bad_response", message ? `PanSou：${message}` : `PanSou 拒绝了请求（HTTP ${res.status}）`, res.status, message);
  }
  if ("code" in b && typeof b.code === "number") {
    if (b.code !== 0 && b.code !== 200) {
      throw new PansouError("bad_response", message ? `PanSou：${message}` : `PanSou 返回了错误（${b.code}）`, res.status, message);
    }
    const data = b.data;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  }
  return b;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/* ------------------------------- 接口 ------------------------------- */

/** 搜一次（res 固定 merge：只要分组后的链接，消息正文用不上）。refresh 跳过 PanSou 的缓存 */
export async function pansouSearch(
  conn: PansouConn,
  /** titleEn：作品的外文原名，作为 ext.title_en 交给认它的插件 */
  q: { kw: string; src: PansouSrc; refresh?: boolean; titleEn?: string },
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PansouSearchResult> {
  const started = Date.now();
  let res: AxiosResponse;
  try {
    res = await call(conn, "post", "/search", {
      data: { kw: q.kw, src: q.src, res: "merge", ...(q.refresh ? { refresh: true } : {}), ...(q.titleEn ? { ext: { title_en: q.titleEn } } : {}) },
      timeout: opts.timeoutMs ?? SEARCH_TIMEOUT_MS,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof PansouError && err.kind === "timeout") throw new PansouError("timeout", SEARCH_TIMEOUT_MESSAGE);
    throw err;
  }
  if (res.status === 404) throw new PansouError("unavailable", "PanSou 地址不对：找不到搜索接口（/api/search）", 404);
  const data = unwrap(res);
  const merged = data.merged_by_type;
  const byType: Record<string, PansouLink[]> = {};
  if (merged && typeof merged === "object" && !Array.isArray(merged)) {
    for (const [type, list] of Object.entries(merged as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const links: PansouLink[] = [];
      for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        const url = str(r.url).trim();
        if (!url) continue;
        links.push({ url, password: str(r.password).trim(), note: str(r.note), datetime: str(r.datetime), source: str(r.source) });
      }
      if (links.length > 0) byType[type] = links;
    }
  }
  log.debug({ kw: q.kw, src: q.src, links: Object.values(byType).reduce((n, l) => n + l.length, 0), ms: Date.now() - started }, "PanSou 搜索");
  return { byType };
}

/** 服务状态：开没开登录、启用了哪些插件和频道。公开接口，不用登录 */
export async function pansouHealth(conn: PansouConn, signal?: AbortSignal): Promise<PansouHealth> {
  const res = await call(conn, "get", "/health", { timeout: HEALTH_TIMEOUT_MS, signal, auth: false });
  if (res.status === 404) throw new PansouError("unavailable", "PanSou 地址不对：找不到 /api/health", 404);
  const data = unwrap(res);
  if (data.status !== undefined && data.status !== "ok") {
    const said = upstreamText(String(data.status));
    throw new PansouError("unavailable", `PanSou 说自己不正常（${said}）`, res.status, said);
  }
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { authEnabled: data.auth_enabled === true, plugins: names(data.plugins), channels: names(data.channels) };
}

/** 检测一批分享链接还有没有效。老版本 PanSou 没有这个接口（404），回 "unsupported" */
export async function pansouCheckLinks(
  conn: PansouConn,
  items: PansouCheckItem[],
  signal?: AbortSignal,
): Promise<PansouCheckResult[] | "unsupported"> {
  const res = await call(conn, "post", "/check/links", {
    data: { items: items.map((i) => ({ disk_type: i.diskType, url: i.url, ...(i.password ? { password: i.password } : {}) })) },
    timeout: CHECK_TIMEOUT_MS,
    signal,
  });
  if (res.status === 404 || res.status === 405) return "unsupported";
  const data = unwrap(res);
  const list = Array.isArray(data.results) ? data.results : [];
  const states = new Set<PansouCheckState>(["ok", "bad", "locked", "unsupported", "uncertain"]);
  const out: PansouCheckResult[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const state = str(r.state) as PansouCheckState;
    out.push({
      url: str(r.url),
      ...(str(r.normalized_url) ? { normalizedUrl: str(r.normalized_url) } : {}),
      state: states.has(state) ? state : "uncertain",
      ...(str(r.summary) ? { summary: str(r.summary) } : {}),
    });
  }
  return out;
}

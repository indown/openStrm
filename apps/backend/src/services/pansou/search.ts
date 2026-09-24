/**
 * 资源搜索的服务层：设置 → PanSou 连接、网页用的一问一答、服务端用的多轮等结果、链接检测、检查连接。
 *
 * PanSou 的插件是「尽快响应，持续处理」：4 秒先回一部分，后台最长 30 秒搜完写进它自己的缓存，
 * 同一个词再问一次才拿得到补全的。响应里没有「补完了没有」的标记，只能隔一会儿再问：
 *   - 网页由前端排轮次，这里每次一问一答、不留状态（searchPhase）；
 *   - 智能体和 Telegram 要一次性的答案，由 searchSettled 在服务端多问几轮。
 */
import { setTimeout as sleep } from "node:timers/promises";
import { LRUCache } from "lru-cache";
import type { PansouSettings, ResourceCheckResult, ResourceHit, ResourceLinkState, ResourceSearchResult, ResourceStatus } from "@openstrm/shared";
import { readAppSetting } from "../../db/repositories/settings.js";
import { listShareFollowRefs } from "../../db/repositories/share-follows.js";
import { listTasks } from "../../db/repositories/tasks.js";
import { isAbortError, messageOf } from "../../lib/errors.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { isMasked } from "../../lib/secrets.js";
import { SHARE_PASSWORD_PROBLEM } from "../drive/errors.js";
import { parseShareRef } from "../drive/registry.js";
import type { ShareRef } from "../drive/types.js";
import {
  PansouError,
  apiBase,
  pansouCheckLinks,
  pansouHealth,
  pansouLogin,
  pansouSearch,
  type PansouConn,
  type PansouHealth,
  type PansouLink,
  type PansouSearchResult,
  type PansouSrc,
} from "./client.js";
import { accountCaps, normalizeResults } from "./normalize.js";
import { matchKey, matchTextOf } from "./tags.js";

const log = moduleLogger("pansou");

/** 界面、智能体、Telegram 同一句 */
export const PANSOU_NOT_CONFIGURED = "还没配置资源搜索：到设置页「资源搜索」填 PanSou 的地址";

export function pansouSettings(): PansouSettings {
  return readAppSetting("pansou") ?? {};
}

/** 设置 → 连接；没填地址就是 null（功能关） */
export function pansouConn(): PansouConn | null {
  const s = pansouSettings();
  const baseUrl = s.baseUrl?.trim();
  if (!baseUrl) return null;
  return { baseUrl, username: s.username?.trim() || undefined, password: s.password || undefined };
}

export function requirePansou(): PansouConn {
  const conn = pansouConn();
  if (!conn) throw new HttpError(400, PANSOU_NOT_CONFIGURED, { code: "PANSOU_NOT_CONFIGURED" });
  return conn;
}

/** 自动检测链接有效性：不填当开 */
export function checkLinksEnabled(): boolean {
  return pansouSettings().checkLinks !== false;
}

/**
 * PanSouError → HttpError。限流原样 429；登录不上、连不上一律走上游错误（500）：
 * PanSou 的 401 不能回给浏览器，前端的全局拦截会当成会话失效、把管理员踢回登录页。
 * 对面自己说的那句另放在 upstreamMessage：智能体那边只把它当数据给
 */
export function pansouHttpError(err: unknown): unknown {
  if (!(err instanceof PansouError)) return err;
  if (err.kind === "rate") return new HttpError(429, err.message, { code: "PANSOU_RATE_LIMITED" }, { cause: err });
  const code = err.kind === "auth" ? "PANSOU_AUTH" : err.kind === "timeout" ? "PANSOU_TIMEOUT" : "PANSOU_UNAVAILABLE";
  return upstreamError(
    err.message,
    { code, ...(err.status ? { upstreamStatus: err.status } : {}), ...(err.upstream ? { upstreamMessage: err.upstream } : {}) },
    err,
  );
}

/** 两个地址是不是同一台 PanSou（末尾的 /、误填的 /api 不算不同）；有一个空着就不是 */
export function samePansouServer(a: string | undefined, b: string | undefined): boolean {
  const x = a?.trim();
  const y = b?.trim();
  return Boolean(x && y) && apiBase({ baseUrl: x! }) === apiBase({ baseUrl: y! });
}

/* ------------------------------- health ------------------------------- */

/** 频道和插件的数目决定 first 那一问怎么发；PanSou 改配置要重启，5 分钟足够新 */
const healthCache = new LRUCache<string, PansouHealth>({ max: 8, ttl: 5 * 60_000 });
/** health 读不到的也记一分钟：前面的反代把 /api/health 卡住时，别每次搜索都先干等它 5 秒 */
const healthFailed = new LRUCache<string, true>({ max: 8, ttl: 60_000 });

async function cachedHealth(conn: PansouConn): Promise<PansouHealth | null> {
  const key = apiBase(conn);
  const hit = healthCache.get(key);
  if (hit) return hit;
  if (healthFailed.has(key)) return null;
  try {
    const health = await pansouHealth(conn);
    healthCache.set(key, health);
    return health;
  } catch (err) {
    healthFailed.set(key, true);
    log.debug({ err }, "读 PanSou 的 health 失败，按全量搜");
    return null;
  }
}

/* ------------------------------- 结果 ------------------------------- */

/**
 * 订过追更的分享：按「网盘:分享码」对追更表。网盘先看订阅自己的分享链接，只存了分享码的老订阅才靠任务认
 * （分享和任务是同一家网盘；任务的 accountType 是客户端带的，换账号时不一定跟着改）。
 * 停掉的（分享失效、长期没更新、手动暂停）标 stopped：搜替代资源时，原来那个分享多半也在结果里，不能说它「在追」
 */
export function markFollowed(items: ResourceHit[]): ResourceHit[] {
  const follows = listShareFollowRefs();
  if (follows.length === 0) return items;
  // 任务表只在真有老订阅要靠它时读一次，不按订阅一条条查
  let taskKinds: Map<string, string | undefined> | undefined;
  const states = new Map<string, "active" | "stopped">();
  for (const f of follows) {
    let kind: string | undefined = f.shareUrl ? parseShareRef(f.shareUrl)?.kind : undefined;
    if (!kind) {
      taskKinds ??= new Map(listTasks().map((t) => [t.id, t.accountType]));
      kind = taskKinds.get(f.taskId);
    }
    if (!kind) continue;
    const key = `${kind}:${f.shareCode}`;
    // 同一个分享订了几个目录：有一个还在追就算在追
    if (f.enabled) states.set(key, "active");
    else if (!states.has(key)) states.set(key, "stopped");
  }
  return items.map((h) => {
    const followed = states.get(h.key);
    return followed ? { ...h, followed } : h;
  });
}

/**
 * 屏蔽词：标题或标签里带任何一个就藏掉，回藏了几条。匹配口径见 tags.ts 的 matchKey（全角半角、大小写不计较，
 * 中文词按子串、英文数字的词要整段对上：「TC」不藏 The Witcher），和智能体 resource_search 的 include / exclude 一样。
 * 在这边滤、不交给 PanSou 的 filter.exclude：换了屏蔽词不用重搜（缓存里的原始结果现滤），也不挑 PanSou 的版本
 */
function applyBlockWords(items: ResourceHit[], words: readonly string[]): { items: ResourceHit[]; blocked: number } {
  const keys = words.map(matchKey).filter(Boolean);
  if (keys.length === 0) return { items, blocked: 0 };
  const kept = items.filter((h) => {
    const text = matchTextOf(h);
    return !keys.some((w) => text.includes(w));
  });
  return { items: kept, blocked: items.length - kept.length };
}

/**
 * 规整 + 按屏蔽词藏掉 + 标上订过追更的。屏蔽词、追更表随时会变，每次回结果时现算；缓存里只放 PanSou 的原样结果
 */
function present(kw: string, byType: Record<string, PansouLink[]>): ResourceSearchResult {
  const res = normalizeResults(kw, byType, accountCaps());
  const { items, blocked } = applyBlockWords(res.items, pansouSettings().blockWords ?? []);
  if (blocked === 0) return { ...res, items: markFollowed(items) };
  const counts: ResourceSearchResult["counts"] = {};
  for (const h of items) counts[h.kind] = (counts[h.kind] ?? 0) + 1;
  return { keyword: res.keyword, items: markFollowed(items), counts, blocked };
}

/* ------------------------------- 网页：一问一答 ------------------------------- */

/**
 * 网页的一问。first：频道和插件都有时先只搜 TG（1～3 秒出第一屏），同时不等待地发一个全量的预热，
 * 让插件先跑起来、结果进 PanSou 的缓存；more：全量，一般直接吃缓存。
 * refresh（跳过缓存）只在 first 带：more 也带的话，会把刚写进的缓存冲掉重搜。
 * full：不排轮次的一问（REST 调用没给 phase 时），全量、认 refresh
 */
export async function searchPhase(
  keyword: string,
  phase: "first" | "more" | "full",
  /** titleEn：网页上选了 TMDB 候选时带的外文原名，作为 ext.title_en 交给认它的插件 */
  opts: { refresh?: boolean; signal?: AbortSignal; titleEn?: string } = {},
): Promise<ResourceSearchResult> {
  const conn = requirePansou();
  const kw = keyword.trim();
  const refresh = phase !== "more" && opts.refresh === true;
  const titleEn = opts.titleEn?.trim() || undefined;
  try {
    let src: PansouSrc = "all";
    if (phase === "first") {
      const health = await cachedHealth(conn);
      if (health && health.channels.length > 0 && health.plugins.length > 0) {
        src = "tg";
        void pansouSearch(conn, { kw, src: "all", refresh, titleEn }).catch((err: unknown) => log.debug({ err }, "预热搜索失败（不影响这次）"));
      }
    }
    const raw = await pansouSearch(conn, { kw, src, refresh, titleEn }, { signal: opts.signal });
    return present(kw, raw.byType);
  } catch (err) {
    throw pansouHttpError(err);
  }
}

/* ------------------------------- 服务端：多问几轮 ------------------------------- */

export interface SettledResult extends ResourceSearchResult {
  /** 结果不再变多了：插件多半补完了。false 时过半分钟再搜同一个词会更全 */
  complete: boolean;
}

let ROUND_GAP_MS = 3_000;
/** 最多问几轮（含第一问）：一般第一问 5～8 秒，之后每轮隔 3 秒、吃 PanSou 的缓存很快，四轮在 20 秒的预算里放得下 */
export const SETTLE_MAX_ROUNDS = 4;
const DEFAULT_BUDGET_MS = 20_000;
/**
 * PanSou 的插件在后台最长搜 30 秒。从这个词第一次问起过了这么久，插件肯定跑完了：一轮没变多就算补完，0 条也才算真没有。
 * 在那之前要连着两轮没变多、而且有结果才算——国内连不上 TG、插件又慢的时候，前几轮一直是 0 条
 */
let PLUGIN_SETTLE_MS = 30_000;
/**
 * 还没补完的结果只缓存 20 秒：智能体换个筛选条件马上再调能用上，
 * 照结果里的提示「过半分钟再搜」时又能重新问 PanSou、拿到插件后台补完的那些
 */
let INCOMPLETE_TTL_MS = 20_000;

/** 测试用：轮与轮之间别真等 3 秒；没补完的结果缓存多久；插件多久算肯定跑完了 */
export function __test_setRoundGap(ms: number, incompleteTtlMs = 20_000, pluginSettleMs = 30_000): void {
  ROUND_GAP_MS = ms;
  INCOMPLETE_TTL_MS = incompleteTtlMs;
  PLUGIN_SETTLE_MS = pluginSettleMs;
}

/** trip：第几趟问的（先开始的小）。两趟重叠时（fresh 的另起一趟），先开始、后回来的那趟不能拿旧结果盖掉缓存 */
type Settled = { raw: PansouSearchResult; complete: boolean; trip: number };
type RoundListener = (round: number, links: number) => void;

/** 结果（PanSou 的原样，账号能力每次现算）按关键词缓存：补完了的 2 分钟，没补完的 INCOMPLETE_TTL_MS。智能体常会换个筛选条件再调一次 */
const settledCache = new LRUCache<string, Settled>({ max: 50, ttl: 2 * 60_000 });
/**
 * 每个词第一次问到 PanSou 的时间（fresh 从头算）：判插件是不是早就跑完了。比 PanSou 自己的缓存时间短，那边的结果还在。
 * 第一问没问成（登录不上、限流、连不上）不记：那次 PanSou 根本没搜，插件也就没在后台跑
 */
const firstAsked = new LRUCache<string, number>({ max: 200, ttl: 10 * 60_000 });
let trips = 0;
/**
 * 正在问的词：同时来的调用（智能体并行调两次、Telegram 和智能体同时搜同一个词）搭同一趟，不各问一套。
 * 等着的都走了（都取消了）才掐掉这一趟
 */
const inflight = new Map<string, { job: Promise<Settled>; ac: AbortController; waiters: number; listeners: Set<RoundListener> }>();

export function __test_clearPansouCaches(): void {
  settledCache.clear();
  firstAsked.clear();
  healthCache.clear();
  healthFailed.clear();
  checkCache.clear();
  unsupportedBases.clear();
}

const linkCount = (raw: PansouSearchResult) => Object.values(raw.byType).reduce((n, list) => n + list.length, 0);

/** 等 promise，但调用方取消了就先走（promise 本身不管，别人可能还在等它） */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("已取消", "AbortError"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * 全量搜一次 → 隔 3 秒再问，变多了接着问、不再变多就停，最多四轮、不超过预算（第一问不受预算管，见 askRounds）。
 * 第二轮起出错（多半是预算到了）不算失败：拿已有的结果回去，标 complete: false
 */
export async function searchSettled(
  keyword: string,
  opts: { budgetMs?: number; fresh?: boolean; signal?: AbortSignal; onRound?: RoundListener } = {},
): Promise<SettledResult> {
  const conn = requirePansou();
  opts.signal?.throwIfAborted();
  const kw = keyword.trim();
  const key = JSON.stringify([apiBase(conn), kw]);
  const cached = opts.fresh ? undefined : settledCache.get(key);
  if (cached) return { ...present(kw, cached.raw.byType), complete: cached.complete };

  // fresh 的另起一趟（要带 refresh），之后来的搭它
  let run = opts.fresh ? undefined : inflight.get(key);
  if (!run) {
    const ac = new AbortController();
    const listeners = new Set<RoundListener>();
    const job = askRounds(conn, kw, key, {
      budgetMs: opts.budgetMs ?? DEFAULT_BUDGET_MS,
      fresh: opts.fresh === true,
      signal: ac.signal,
      onRound: (round, links) => {
        for (const l of listeners) l(round, links);
      },
    });
    const entry = { job, ac, waiters: 0, listeners };
    inflight.set(key, entry);
    void job
      .catch(() => undefined)
      .finally(() => {
        if (inflight.get(key) === entry) inflight.delete(key);
      });
    run = entry;
  }
  const entry = run;
  entry.waiters++;
  if (opts.onRound) entry.listeners.add(opts.onRound);
  try {
    const settled = await untilAborted(entry.job, opts.signal);
    return { ...present(kw, settled.raw.byType), complete: settled.complete };
  } finally {
    if (opts.onRound) entry.listeners.delete(opts.onRound);
    // 等着的都走了：没人要这一趟的结果，别再问 PanSou（已经问完的，掐一下也没事）。
    // 马上摘掉，别等它的取消落地：这中间来的调用不能搭上一趟已经掐掉的
    if (--entry.waiters === 0) {
      entry.ac.abort();
      if (inflight.get(key) === entry) inflight.delete(key);
    }
  }
}

async function askRounds(
  conn: PansouConn,
  kw: string,
  key: string,
  opts: { budgetMs: number; fresh: boolean; signal: AbortSignal; onRound: RoundListener },
): Promise<Settled> {
  const trip = ++trips;
  const started = Date.now();
  const deadline = started + opts.budgetMs;
  const noteAsked = () => {
    if (opts.fresh || !firstAsked.has(key)) firstAsked.set(key, started);
  };
  let raw: PansouSearchResult;
  try {
    // 第一问不按预算掐（慢的实例第一问十几秒起步，掐了就整个失败）：用它自己的 25 秒，要重新登录的也算在里面
    raw = await pansouSearch(conn, { kw, src: "all", refresh: opts.fresh }, { signal: opts.signal });
  } catch (err) {
    // 超时的那一问 PanSou 收到了、插件在后台接着搜，照样从这时算起；别的失败它根本没搜，不记——
    // 记了的话过半分钟再搜会当插件早跑完了：一轮没变多就收工，0 条当真没有、缓存 2 分钟
    if (err instanceof PansouError && err.kind === "timeout") noteAsked();
    throw pansouHttpError(err);
  }
  noteAsked();
  const since = firstAsked.get(key) ?? started;
  let links = linkCount(raw);
  opts.onRound(1, links);
  let stalls = 0;
  const pluginsDone = () => Date.now() - since >= PLUGIN_SETTLE_MS;
  const settled = () => stalls >= (pluginsDone() ? 1 : 2) && (links > 0 || pluginsDone());
  for (let round = 2; round <= SETTLE_MAX_ROUNDS; round++) {
    if (deadline - Date.now() < ROUND_GAP_MS + 1_000) break;
    try {
      await sleep(ROUND_GAP_MS, undefined, { signal: opts.signal });
      const next = await pansouSearch(conn, { kw, src: "all" }, { signal: opts.signal, timeoutMs: Math.max(1_000, deadline - Date.now()) });
      const n = linkCount(next);
      opts.onRound(round, Math.max(n, links));
      if (n > links) {
        raw = next;
        links = n;
        stalls = 0;
        continue;
      }
      stalls++;
      if (settled()) break;
    } catch (err) {
      if (isAbortError(err)) throw err;
      log.debug({ err, round }, "PanSou 补结果那一轮失败，用已有的");
      break;
    }
  }
  const complete = settled();
  // 后开始的一趟（fresh 另起的）已经写好了：这趟的结果更旧，照样回给等着它的人，但不盖掉缓存
  const newer = settledCache.peek(key);
  if (!newer || newer.trip < trip) settledCache.set(key, { raw, complete, trip }, complete ? {} : { ttl: INCOMPLETE_TTL_MS });
  return { raw, complete, trip };
}

/* ------------------------------- 链接检测 ------------------------------- */

/**
 * 一次交给 PanSou 几条。它对一个请求里的链接按网盘近乎一条接一条地查（夸克冷查一条 0.6～0.7 秒），
 * 分成小批并行发快得多：实测夸克 10 条一批 7.2 秒，两批各 5 条并行 3.9 秒。同一批只放一家网盘的，慢的那家不拖快的
 */
const CHECK_BATCH = 5;
/** 同时最多发几批：一下子压太多给 PanSou 只会在它那边排队，还更容易被网盘风控 */
const CHECK_PARALLEL = 4;
/** 检测结果：按 PanSou 地址 + 分享 + 提取码记 10 分钟（「说不准」的不记） */
const checkCache = new LRUCache<string, { state: ResourceLinkState; summary?: string }>({ max: 5000, ttl: 10 * 60_000 });
/** 没有检测接口的 PanSou（按地址记）：一小时后再试一次，用户可能升级了 */
const unsupportedBases = new LRUCache<string, true>({ max: 8, ttl: 60 * 60_000 });

/** 交给 PanSou 检测时链接不带提取码、提取码单给：它的文档说「提取码未拼接在链接中时可传」，两边都带怕它拼两遍 */
function bareShareUrl(ref: ShareRef): string {
  return ref.kind === "115" ? `https://115.com/s/${ref.code}` : `https://pan.quark.cn/s/${ref.code}`;
}

/** 检测结果里的一个链接认成哪个分享。只认 http(s) 的：后端的 115 解析连一个词都当裸分享码，不能让乱七八糟的字段冒充 */
function checkedKey(url: string | undefined): string | undefined {
  const ref = url && /^https?:\/\//i.test(url.trim()) ? parseShareRef(url.trim()) : null;
  return ref && (ref.kind === "115" || ref.kind === "quark") ? `${ref.kind}:${ref.code}` : undefined;
}

/**
 * 检测一批链接还有没有效。只收认得出的 115 / 夸克分享，别的直接丢掉：
 * 不让这个接口变成「借 PanSou 去访问任意地址」的跳板。结果按 ResourceHit 的 key 回。
 *
 * 按网盘分小批、限着并发发（见 CHECK_BATCH），哪批先回来就先记哪批：智能体给检测限了时，超时的那批作废，
 * 已经回来的照样用上。一批都没成才算这次失败
 */
export async function checkResourceLinks(urls: string[], signal?: AbortSignal): Promise<ResourceCheckResult> {
  const conn = requirePansou();
  const base = apiBase(conn);
  if (unsupportedBases.has(base)) return { supported: false, results: [] };

  const refs = new Map<string, ShareRef>();
  for (const u of urls) {
    const text = u.trim();
    const ref = /^https?:\/\//i.test(text) ? parseShareRef(text) : null;
    if (ref && (ref.kind === "115" || ref.kind === "quark")) refs.set(`${ref.kind}:${ref.code}`, ref);
  }
  const results: ResourceCheckResult["results"] = [];
  const todo: Array<{ key: string; ref: ShareRef; cacheKey: string }> = [];
  for (const [key, ref] of refs) {
    const cacheKey = JSON.stringify([base, key, ref.password]);
    const hit = checkCache.get(cacheKey);
    if (hit) results.push({ key, ...hit });
    else todo.push({ key, ref, cacheKey });
  }
  if (todo.length === 0) return { supported: true, results };

  const byKind = new Map<string, typeof todo>();
  for (const t of todo) byKind.set(t.ref.kind, [...(byKind.get(t.ref.kind) ?? []), t]);
  const batches: Array<typeof todo> = [];
  for (const list of byKind.values()) for (let i = 0; i < list.length; i += CHECK_BATCH) batches.push(list.slice(i, i + CHECK_BATCH));
  // 最多 CHECK_PARALLEL 批同时在路上；到点（调用方掐了）就不再发新的
  const settled: Array<PromiseSettledResult<Awaited<ReturnType<typeof pansouCheckLinks>>>> = new Array(batches.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length && !signal?.aborted) {
      const i = next++;
      try {
        const items = batches[i].map((b) => ({ diskType: b.ref.kind, url: bareShareUrl(b.ref), ...(b.ref.password ? { password: b.ref.password } : {}) }));
        settled[i] = { status: "fulfilled", value: await pansouCheckLinks(conn, items, signal) };
      } catch (reason) {
        settled[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_PARALLEL, batches.length) }, worker));
  let unsupported = false;
  let answered = false;
  let failure: unknown;
  settled.forEach((outcome, i) => {
    // 到点没发出去的批次是空位（forEach 本来就跳过），当作这次没查
    if (outcome.status === "rejected") {
      failure ??= outcome.reason;
      return;
    }
    answered = true;
    if (outcome.value === "unsupported") {
      unsupported = true;
      return;
    }
    const byKey = new Map(batches[i].map((b) => [b.key, b]));
    for (const r of outcome.value) {
      // 只按链接对号，不按位置：PanSou 跳过或挪动了某一条时，按位置会把别的链接的状态安到它头上。
      // 原样带回的 url 和它规范化过的 normalized_url 各对一次
      const b = byKey.get(checkedKey(r.url) ?? "") ?? byKey.get(checkedKey(r.normalizedUrl) ?? "");
      if (!b) continue;
      byKey.delete(b.key);
      // PanSou 把「访问码错误」这类也算成 bad：分享其实还在，只是提取码不对——和转存框打不开时一个口径，记成 locked
      const state = r.state === "bad" && r.summary && SHARE_PASSWORD_PROBLEM.test(r.summary) ? "locked" : r.state;
      const entry = { state, ...(r.summary ? { summary: r.summary } : {}) };
      if (state !== "uncertain") checkCache.set(b.cacheKey, entry);
      results.push({ key: b.key, ...entry });
    }
  });
  if (unsupported) {
    unsupportedBases.set(base, true);
    return { supported: false, results };
  }
  if (!answered) throw pansouHttpError(failure);
  return { supported: true, results };
}

/* ------------------------------- 检查连接 ------------------------------- */

/**
 * 设置页的「检查连接」：用表单里还没保存的值问一次 health，开了登录的再登一次。
 * 密码还是掩码时用库里存的——但只在地址还是存着的那个时：表单里改成了别的地址（手滑、换了台机器）还没保存，
 * 存着的密码不能发给一个没确认过的服务器。
 * 不抛错：连不上、登不进都写在 message 里给人看
 */
export async function pansouStatus(input: { baseUrl?: string; username?: string; password?: string } = {}): Promise<ResourceStatus> {
  const saved = pansouSettings();
  const baseUrl = (input.baseUrl ?? saved.baseUrl ?? "").trim();
  if (!baseUrl) return { configured: false, ok: false, message: "还没填 PanSou 的地址" };
  const typed = input.password !== undefined && !isMasked(input.password);
  const sameServer = samePansouServer(baseUrl, saved.baseUrl);
  const heldBack = !typed && !sameServer && Boolean(saved.password);
  const conn: PansouConn = {
    baseUrl,
    username: (input.username ?? saved.username ?? "").trim() || undefined,
    password: (typed ? input.password : sameServer ? saved.password : undefined) || undefined,
  };
  let health: PansouHealth;
  try {
    health = await pansouHealth(conn);
  } catch (err) {
    return { configured: true, ok: false, message: messageOf(err) };
  }
  healthCache.set(apiBase(conn), health);
  healthFailed.delete(apiBase(conn));
  // 老版本升级以后点一下「检查连接」，链接检测马上重新试，不用等「不支持」那一小时过去
  unsupportedBases.delete(apiBase(conn));
  const counts = { authEnabled: health.authEnabled, plugins: health.plugins.length, channels: health.channels.length };
  if (health.authEnabled) {
    if (!conn.username) return { configured: true, ok: false, ...counts, message: "PanSou 开了登录，要填用户名和密码" };
    if (heldBack) return { configured: true, ok: false, ...counts, message: "地址改了：存着的密码不会发给新地址，把密码重新填一遍再检查" };
    try {
      await pansouLogin(conn);
    } catch (err) {
      return { configured: true, ok: false, ...counts, message: messageOf(err) };
    }
  }
  if (counts.plugins === 0 && counts.channels === 0) {
    return { configured: true, ok: true, ...counts, message: "连上了，但 PanSou 没启用任何频道和插件，搜不到东西：照它仓库里的 docker-compose.yml 配好 CHANNELS 和 ENABLED_PLUGINS" };
  }
  return { configured: true, ok: true, ...counts };
}

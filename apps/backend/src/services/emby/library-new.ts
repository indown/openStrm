/**
 * Emby 入库通知：定期问 Emby「最近收了什么新条目」，按剧聚合后发 Telegram。
 *
 * 为什么轮询而不是 Emby Webhook：webhook 要用户去 Emby 里配回调、要在管理端开免鉴权入口，
 * 各版本 payload 还不一样；而 emby.url + apiKey 本来就配好了（302 代理在用），
 * 对局域网 Emby 两分钟一次 /Items 查询可以忽略不计。
 *
 * 循环常驻、不追着设置起停：每一轮先看开关和配置，不满足就什么都不做。
 * refreshEmbyNow 成功后 30 秒会插一轮加急——入库基本都发生在我们触发刷新之后。
 * 游标 = 最新条目的 DateCreated（毫秒）+ 同一时刻的 id 集，落在 settings 表里：
 * 重启不重复报；开关关掉一阵再打开，会把这段时间的入库补报一次（超量时只报总数）。
 */
import axios from "axios";
import { readAppSettings } from "../../db/repositories/settings.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";
import { DEFAULT_TIMEOUT_MS } from "../../lib/http.js";
import { moduleLogger } from "../../lib/logger.js";
import { notify, notifyPrefs, type EmbyNewGroup, type NotifyEvent } from "../telegram/notify.js";

const log = moduleLogger("emby-new");

const POLL_MS = 120_000;
/** refreshEmbyNow 之后等扫描跑一会儿再看 */
const NUDGE_MS = 30_000;
const FETCH_LIMIT = 50;
/** 一轮新增超过这个数就只报总数：库重建、首次挂大目录时别刷屏 */
const FLOOD_LIMIT = 30;

export interface EmbyNewItem {
  id: string;
  /** Emby 的 Type：Episode / Movie / … */
  type: string;
  name: string;
  seriesName?: string;
  season?: number;
  episode?: number;
  year?: number;
  /** DateCreated 解析成毫秒；解析不了的条目直接丢弃 */
  at: number;
}

interface Cursor {
  at: number;
  /** at 这一毫秒上已经见过的条目 id：同一批入库常常共享同一个 DateCreated */
  ids: string[];
}

/* ------------------------------- 依赖注入 ------------------------------- */

interface Deps {
  /** 按 DateCreated 倒序取最近的条目；Emby 未配置时回 null */
  fetch: (limit: number) => Promise<EmbyNewItem[] | null>;
  notify: (event: NotifyEvent) => Promise<unknown>;
}

async function fetchLatestReal(limit: number): Promise<EmbyNewItem[] | null> {
  const s = readAppSettings();
  if (!s.emby?.url || !s.emby.apiKey) return null;
  const base = s.emby.url.replace(/\/+$/, "");
  const url =
    `${base}/Items?Recursive=true&IncludeItemTypes=Movie,Episode` +
    `&SortBy=DateCreated&SortOrder=Descending&Limit=${limit}` +
    `&Fields=DateCreated,SeriesName,ParentIndexNumber,IndexNumber,ProductionYear` +
    `&api_key=${encodeURIComponent(s.emby.apiKey)}`;
  const res = await axios.get<{ Items?: Array<Record<string, unknown>> }>(url, { timeout: DEFAULT_TIMEOUT_MS });
  return (res.data?.Items ?? []).map((it) => ({
    id: String(it.Id ?? ""),
    type: String(it.Type ?? ""),
    name: String(it.Name ?? ""),
    seriesName: typeof it.SeriesName === "string" ? it.SeriesName : undefined,
    season: typeof it.ParentIndexNumber === "number" ? it.ParentIndexNumber : undefined,
    episode: typeof it.IndexNumber === "number" ? it.IndexNumber : undefined,
    year: typeof it.ProductionYear === "number" ? it.ProductionYear : undefined,
    at: Date.parse(String(it.DateCreated ?? "")),
  }));
}

const realDeps: Deps = { fetch: fetchLatestReal, notify };

let deps: Deps = { ...realDeps };

/** 仅供测试：换掉会碰网络的部分；传 null 恢复 */
export function setEmbyNewDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 聚合 ------------------------------- */

/** 按 剧+季（或电影本身）聚合，顺序按这一批里第一次出现的先后 */
export function groupEmbyNewItems(items: EmbyNewItem[]): EmbyNewGroup[] {
  const groups = new Map<string, EmbyNewGroup>();
  for (const it of items) {
    const tv = it.type === "Episode";
    const name = tv ? it.seriesName || it.name : it.name;
    const key = tv ? `tv|${name}|${it.season ?? ""}` : `mv|${name}|${it.year ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { kind: tv ? "tv" : "movie", name, episodes: [], count: 0 };
      if (tv) g.season = it.season;
      else g.year = it.year;
      groups.set(key, g);
    }
    g.count += 1;
    if (tv && it.episode != null && !g.episodes.includes(it.episode)) g.episodes.push(it.episode);
  }
  for (const g of groups.values()) g.episodes.sort((a, b) => a - b);
  return [...groups.values()];
}

/* ------------------------------- 一轮 ------------------------------- */

/** 跑一轮。导出为函数是为了测试直接触发，不用等两分钟 */
export async function tickEmbyNew(): Promise<void> {
  // 开关关着连 Emby 都不问；游标会停在关掉那一刻，重新打开时把中间的入库补报一次
  if (!notifyPrefs(readAppSettings()).embyNew) return;
  const items = await deps.fetch(FETCH_LIMIT);
  if (!items) return;

  const sorted = items.filter((i) => Number.isFinite(i.at) && i.id).sort((a, b) => b.at - a.at);
  const newest = sorted[0];
  const cursor = readKv<Cursor>(KEY.embyNewCursor);
  const idsAt = (at: number) => sorted.filter((i) => i.at === at).map((i) => i.id);

  if (!cursor) {
    // 首轮只定位游标：存量不算新增
    writeKv(KEY.embyNewCursor, newest ? { at: newest.at, ids: idsAt(newest.at) } : { at: 0, ids: [] });
    return;
  }

  const fresh = sorted.filter((i) => i.at > cursor.at || (i.at === cursor.at && !cursor.ids.includes(i.id)));
  if (fresh.length === 0) return;
  writeKv(KEY.embyNewCursor, { at: newest.at, ids: idsAt(newest.at) });

  if (fresh.length >= FLOOD_LIMIT) {
    log.info(`Emby 入库 ${fresh.length} 个条目（批量，只报总数）`);
    void deps.notify({ type: "emby-new", groups: [], total: fresh.length }).catch(() => {});
    return;
  }
  const groups = groupEmbyNewItems(fresh);
  log.info(`Emby 入库 ${fresh.length} 个条目：${groups.map((g) => g.name).join("、")}`);
  void deps.notify({ type: "emby-new", groups, total: fresh.length }).catch(() => {});
}

/* ------------------------------- 循环 ------------------------------- */

let running = false;
let timer: NodeJS.Timeout | null = null;
let nudgeTimer: NodeJS.Timeout | null = null;
let ticking: Promise<void> | null = null;
let lastTickAt: number | null = null;
let lastError: string | null = null;

export function getEmbyNewWatcherStatus(): { running: boolean; lastTickAt: number | null; lastError: string | null } {
  return { running, lastTickAt, lastError };
}

export function startEmbyNewWatcher(): void {
  if (running) return;
  running = true;
  // 起得早一点：启动后先把游标定好，之后的入库才有对照
  schedule(5_000);
}

export async function stopEmbyNewWatcher(): Promise<void> {
  running = false;
  if (timer) clearTimeout(timer);
  if (nudgeTimer) clearTimeout(nudgeTimer);
  timer = null;
  nudgeTimer = null;
  await ticking;
}

/** refreshEmbyNow 成功后调：30 秒后插一轮加急，入库延迟从最多 2 分钟压到半分钟 */
export function nudgeEmbyNewWatch(): void {
  if (!running || nudgeTimer) return;
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    void runTick(false);
  }, NUDGE_MS);
  nudgeTimer.unref?.();
}

function schedule(ms: number): void {
  timer = setTimeout(() => {
    timer = null;
    void runTick(true);
  }, ms);
  timer.unref?.();
}

async function runTick(reschedule: boolean): Promise<void> {
  if (!running) return;
  if (ticking) {
    // 加急和例行撞上了：跳过这一发
    if (reschedule) schedule(POLL_MS);
    return;
  }
  ticking = tickEmbyNew()
    .then(() => {
      lastError = null;
    })
    .catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "Emby 入库检查这一轮失败");
    })
    .finally(() => {
      lastTickAt = Date.now();
      ticking = null;
    });
  await ticking;
  if (running && reschedule) schedule(POLL_MS);
}

/** 仅供测试：停循环、清游标 */
export async function __test_resetEmbyNew(): Promise<void> {
  await stopEmbyNewWatcher();
  writeKv(KEY.embyNewCursor, null);
  lastTickAt = null;
  lastError = null;
}

/**
 * 检查更新：问一次 GitHub 的发布接口，和当前版本比一下。设计见 .claude/plans/check-update.md。
 *
 *   - 只发一个匿名 GET，不带账号、路径、统计；定时检查默认关着（装上不主动联网），
 *     设置页的「立即检查」是用户自己按的，任何时候都能用。
 *   - 结果缓存在 settings 表的 `update.state`，页面读缓存——刷新页面不产生外网请求。
 *   - 查不到不是错误：如实记下原因（国内连 GitHub 本来就常失败），上一次查到的版本留着。
 *   - 跑 rc 的人要跟 rc 比，不然会被告知「有新版 2.7.0」（比手上的还旧）。
 */
import axios from "axios";
import type { AppSettings, UpdateRelease, UpdateState, UpdateStatus } from "@openstrm/shared";
import { KEY } from "../../db/keys.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { APP_VERSION, isNewerVersion, isPrerelease, parseVersion } from "../../lib/version.js";
import { moduleLogger } from "../../lib/logger.js";
import { notify } from "../telegram/notify.js";

const log = moduleLogger("update");

const REPO = "indown/openStrm";
const API = `https://api.github.com/repos/${REPO}/releases`;
/** 更新说明留这么多就够看了，别把 settings 表撑大 */
const NOTES_LIMIT = 4000;
const TIMEOUT_MS = 8000;
/** 手动连点的节流：GitHub 匿名限额 60 次/小时 */
export const MANUAL_THROTTLE_S = 5 * 60;
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_DELAY_MS = 30 * 1000;

/** GitHub 回的一条发布，只取用得上的字段 */
interface RawRelease {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
  body?: string;
}

interface Deps {
  /** 拉发布列表；includePrerelease 时多拉几条自己挑 */
  fetchReleases: (includePrerelease: boolean, signal?: AbortSignal) => Promise<RawRelease[]>;
  now: () => number;
  /** 当前跑的版本；用例要同时验「跑正式版」和「跑 rc」两条路，不能跟着仓库自己的版本号走 */
  current: () => string;
}

async function fetchFromGithub(includePrerelease: boolean, signal?: AbortSignal): Promise<RawRelease[]> {
  // 只要正式版时用 /latest（GitHub 自己就跳过预发布和草稿）；要预发布就拉一页自己挑
  const url = includePrerelease ? API : `${API}/latest`;
  const resp = await axios.get(url, {
    params: includePrerelease ? { per_page: 10 } : undefined,
    headers: { Accept: "application/vnd.github+json", "User-Agent": `OpenStrm/${APP_VERSION}` },
    timeout: TIMEOUT_MS,
    signal,
  });
  const data = resp.data as RawRelease | RawRelease[];
  return Array.isArray(data) ? data : [data];
}

const realDeps: Deps = { fetchReleases: fetchFromGithub, now: () => Math.floor(Date.now() / 1000), current: () => APP_VERSION };
let deps: Deps = { ...realDeps };

/** 仅供测试 */
export function setUpdateDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

export const EMPTY_STATE: UpdateState = { checkedAt: 0, ok: false, error: "", latest: null, notifiedVersion: "" };

export function readState(): UpdateState {
  return { ...EMPTY_STATE, ...(readKv<Partial<UpdateState>>(KEY.updateState) ?? {}) };
}

const writeState = (state: UpdateState): void => writeKv(KEY.updateState, state);

/** 定时检查开着没有（默认关） */
export const updateEnabled = (settings: AppSettings = readAppSettings()): boolean => settings.update?.enabled === true;

/** 这次要不要连预发布一起看：设置里明说了就听它，没说就看当前跑的是不是 rc */
export const wantsPrerelease = (settings: AppSettings = readAppSettings()): boolean =>
  settings.update?.includePrerelease ?? isPrerelease(deps.current());

/** 一条发布转成我们要的形状；不是正经版本号（草稿、乱打的 tag）返回 null */
function toRelease(raw: RawRelease): UpdateRelease | null {
  const tag = (raw.tag_name ?? "").trim();
  if (!tag || raw.draft) return null;
  if (!parseVersion(tag)) return null;
  const published = raw.published_at ? Math.floor(new Date(raw.published_at).getTime() / 1000) : 0;
  return {
    version: tag.replace(/^v/, ""),
    tag,
    url: raw.html_url || `https://github.com/${REPO}/releases/tag/${tag}`,
    publishedAt: Number.isFinite(published) ? published : 0,
    prerelease: !!raw.prerelease,
    notes: (raw.body ?? "").slice(0, NOTES_LIMIT),
  };
}

/** 一页发布里挑出最新的一条：不要预发布时跳过它们 */
export function pickLatest(raws: RawRelease[], includePrerelease: boolean): UpdateRelease | null {
  let best: UpdateRelease | null = null;
  for (const raw of raws) {
    const rel = toRelease(raw);
    if (!rel || (rel.prerelease && !includePrerelease)) continue;
    if (!best || isNewerVersion(rel.version, best.version)) best = rel;
  }
  return best;
}

/** 有没有比当前跑的新 */
export const isOutdated = (state: UpdateState): boolean => !!state.latest && isNewerVersion(state.latest.version, deps.current());

let checking = false;

export function updateStatus(): UpdateStatus {
  const state = readState();
  return { current: deps.current(), enabled: updateEnabled(), outdated: isOutdated(state), checking, state };
}

export class ThrottledError extends Error {
  constructor(readonly retryAfter: number) {
    super(`刚查过，${retryAfter} 秒后再试`);
    this.name = "ThrottledError";
  }
}

/**
 * 查一次。manual 是用户自己按的：定时检查关着也照查（按一下就是同意这一次请求），但有节流。
 * 查失败只记原因，上一次查到的版本留着，不当成接口错误往外抛
 */
export async function checkForUpdates(opts: { manual?: boolean; signal?: AbortSignal } = {}): Promise<UpdateState> {
  const settings = readAppSettings();
  const prev = readState();
  if (!opts.manual && !updateEnabled(settings)) return prev;
  if (opts.manual) {
    const wait = MANUAL_THROTTLE_S - (deps.now() - prev.checkedAt);
    if (prev.checkedAt > 0 && wait > 0) throw new ThrottledError(wait);
  }
  if (checking) return prev;
  checking = true;
  try {
    const includePrerelease = wantsPrerelease(settings);
    const raws = await deps.fetchReleases(includePrerelease, opts.signal);
    const latest = pickLatest(raws, includePrerelease);
    const state: UpdateState = {
      checkedAt: deps.now(),
      ok: true,
      error: "",
      // 一条都没挑出来（仓库还没发过版）：别把上次的结果抹掉
      latest: latest ?? prev.latest,
      notifiedVersion: prev.notifiedVersion,
    };
    writeState(state);
    await notifyIfNew(state, settings);
    return readState();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const state: UpdateState = { ...prev, checkedAt: deps.now(), ok: false, error: message };
    writeState(state);
    log.warn({ err }, "检查更新失败");
    return state;
  } finally {
    checking = false;
  }
}

/** 有新版本就推一条 Telegram（默认关），同一个版本只推一次 */
async function notifyIfNew(state: UpdateState, settings: AppSettings): Promise<void> {
  const latest = state.latest;
  if (!latest || !isOutdated(state) || state.notifiedVersion === latest.version) return;
  writeState({ ...state, notifiedVersion: latest.version });
  if (settings.telegram?.notify?.update !== true) return;
  try {
    await notify({ type: "update-available", version: latest.version, current: deps.current(), url: latest.url });
  } catch (err) {
    log.warn({ err }, "新版本通知没发出去");
  }
}

/** 启动时挂上：开了自动检查才有定时（延迟一会儿，别和迁移、任务恢复抢） */
export function startUpdateChecks(): void {
  const tick = () => {
    if (!updateEnabled()) return;
    void checkForUpdates().catch(() => {
      /* checkForUpdates 自己已经记过原因 */
    });
  };
  setTimeout(tick, FIRST_DELAY_MS).unref();
  setInterval(tick, INTERVAL_MS).unref();
}

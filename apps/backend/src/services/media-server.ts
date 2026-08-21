/**
 * 媒体服务器刷新通知。
 *
 * Emby 的 /Library/Refresh 是**全库扫描**，很贵。全量任务一轮只调一次没问题，
 * 但生活事件是一条一条来的——一集触发一次全库扫描会把 Emby 打瘫，
 * 所以增量侧必须走防抖：安静一段时间才发，同时给一个封顶，
 * 避免持续不断的事件流把刷新无限期推后。
 */
import axios from "axios";
import { readAppSettings } from "../db/repositories/settings.js";

/** 安静多久后触发刷新（秒） */
const DEFAULT_QUIET_SECONDS = 30;
/** 从第一次请求算起最多等多久（秒），防止事件不断导致刷新被饿死 */
const DEFAULT_MAX_WAIT_SECONDS = 300;

type Logger = (msg: string) => void;
let log: Logger = () => {};

export function setMediaServerLogger(fn: Logger): void {
  log = fn;
}

function embyEndpoint(): string | null {
  const s = readAppSettings();
  if (!s.emby?.url || !s.emby?.apiKey) return null;
  return `${s.emby.url.replace(/\/$/, "")}/Library/Refresh?api_key=${encodeURIComponent(s.emby.apiKey)}`;
}

/** 立即发一次刷新，失败只记日志不抛——通知媒体服务器不该影响主流程 */
export function refreshEmbyNow(reason = "manual"): void {
  const url = embyEndpoint();
  if (!url) return;
  axios
    .post(url)
    .then(() => log(`Emby 刷新已触发（${reason}）`))
    .catch((err) => log(`Emby 刷新失败（${reason}）：${err instanceof Error ? err.message : err}`));
}

/* ------------------------------- 防抖调度 ------------------------------- */

let quietTimer: NodeJS.Timeout | null = null;
let capTimer: NodeJS.Timeout | null = null;
let pendingSince: number | null = null;
let pendingCount = 0;

function fire(): void {
  const n = pendingCount;
  clearTimers();
  pendingSince = null;
  pendingCount = 0;
  refreshEmbyNow(`${n} 个变更事件`);
}

function clearTimers(): void {
  if (quietTimer) clearTimeout(quietTimer);
  if (capTimer) clearTimeout(capTimer);
  quietTimer = null;
  capTimer = null;
}

/**
 * 登记一次本地文件变更，稍后合并成一次刷新。
 * 反复调用只会把「安静期」往后推，但不会超过封顶时间。
 */
export function scheduleEmbyRefresh(): void {
  if (!embyEndpoint()) return;

  const cfg = readAppSettings().lifeMonitor ?? {};
  const quietMs = Math.max(1, Number(cfg.mediaServerRefreshDelay) || DEFAULT_QUIET_SECONDS) * 1000;
  const maxWaitMs =
    Math.max(1, Number(cfg.mediaServerRefreshMaxWait) || DEFAULT_MAX_WAIT_SECONDS) * 1000;

  pendingCount++;
  if (pendingSince === null) {
    pendingSince = Date.now();
    capTimer = setTimeout(fire, maxWaitMs);
    capTimer.unref?.();
  }

  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = setTimeout(fire, quietMs);
  quietTimer.unref?.();
}

/** 停机/停止监控时把攒着的刷新发出去——文件已经落盘了，没理由丢掉 */
export function flushEmbyRefresh(): void {
  if (pendingSince === null) return;
  fire();
}

/** 丢弃待发的刷新，不通知 */
export function cancelEmbyRefresh(): void {
  clearTimers();
  pendingSince = null;
  pendingCount = 0;
}

export function getEmbyRefreshState(): {
  configured: boolean;
  pendingCount: number;
  pendingSince: number | null;
} {
  return { configured: !!embyEndpoint(), pendingCount, pendingSince };
}

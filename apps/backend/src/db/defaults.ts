import type { AppSettings } from "@openstrm/shared";

export const DEFAULT_AUTH = {
  username: "admin",
  password: "admin",
} as const;

/** 网盘限流三个值的默认和上下限。只此一份：建库、services/throttle.ts 的兜底、设置接口的校验都用它 */
export const THROTTLE_DEFAULTS = {
  /** 每个账号每秒最多发几个接口请求 */
  requestsPerSecond: 2,
  /** 每个账号每条通道同时在路上的接口请求数 */
  requestConcurrency: 2,
  /** 每个账号同时下载几个文件 */
  downloadConcurrency: 5,
} as const;

export const THROTTLE_LIMITS = {
  /** 可以填小数：0.5 是两秒一个，0.1 是十秒一个 */
  requestsPerSecond: { min: 0.1, max: 100 },
  requestConcurrency: { min: 1, max: 50 },
  downloadConcurrency: { min: 1, max: 50 },
} as const;

export function buildDefaultAppSettings(): AppSettings {
  return {
    "user-agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/116.0.5845.89 Mobile/15E148 Safari/604.1",
    emby: { url: "http://172.17.0.1:8096", apiKey: "", allowAnonymousRedirect: false },
    telegram: { botToken: "", chatId: "", allowedUsers: [] },
    strmExtensions: [
      ".mp4", ".mkv", ".avi", ".iso", ".mov", ".rmvb", ".webm", ".flv",
      ".m3u8", ".mp3", ".flac", ".ogg", ".m4a", ".wav", ".opus", ".wma",
    ],
    downloadExtensions: [".srt", ".ass", ".sub", ".nfo", ".jpg", ".png"],
    download: {
      linkMaxPerSecond: THROTTLE_DEFAULTS.requestsPerSecond,
      linkMaxConcurrent: THROTTLE_DEFAULTS.requestConcurrency,
      downloadMaxConcurrent: THROTTLE_DEFAULTS.downloadConcurrency,
    },
  };
}

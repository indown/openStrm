import crypto from "node:crypto";

export const DEFAULT_AUTH = {
  username: "admin",
  password: "admin",
} as const;

export function buildDefaultAppSettings() {
  return {
    "user-agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/116.0.5845.89 Mobile/15E148 Safari/604.1",
    internalToken: crypto.randomBytes(24).toString("base64url"),
    emby: { url: "http://172.17.0.1:8096", apiKey: "" },
    telegram: { botToken: "", chatId: "", allowedUsers: [] as string[] },
    strmExtensions: [
      ".mp4", ".mkv", ".avi", ".iso", ".mov", ".rmvb", ".webm", ".flv",
      ".m3u8", ".mp3", ".flac", ".ogg", ".m4a", ".wav", ".opus", ".wma",
    ],
    downloadExtensions: [".srt", ".ass", ".sub", ".nfo", ".jpg", ".png"],
    download: {
      linkMaxPerSecond: 2,
      linkMaxConcurrent: 2,
      downloadMaxConcurrent: 5,
    },
  };
}

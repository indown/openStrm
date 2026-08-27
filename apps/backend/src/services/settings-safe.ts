/**
 * 代理进程专用的配置读取。
 *
 * 代理是独立进程，迁移由 API 进程负责。库还没建好（或干脆起不来）时，
 * readAppSettings() 会抛 "no such table"，而代理层每个请求都要读配置——
 * 不兜住的话所谓的"降级为纯反代"其实是每个请求 500。
 *
 * 兜住之后配置为空，各处的默认值生效：上游用默认 Emby 地址、
 * mediaMountPath 为空所以没有条目会被 302，全部老实回源。
 */
import type { AppSettings } from "@openstrm/shared";
import { readAppSettings } from "../db/repositories/settings.js";
import { moduleLogger } from "../lib/logger.js";

const log = moduleLogger("settings");

const EMPTY: AppSettings = {};

let warned = false;

export function readSettingsSafe(): AppSettings {
  try {
    return readAppSettings();
  } catch (err) {
    if (!warned) {
      warned = true;
      log.warn(
        `[settings] 读取配置失败，按空配置降级运行: ${err instanceof Error ? err.message : err}`,
      );
    }
    return EMPTY;
  }
}

/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/settings-safe.itest.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readAppSettings, replaceAppSettings } from "../db/repositories/settings.js";
import { readSettingsSafe, resetSettingsMemo } from "./settings-safe.js";

const baseline = readAppSettings();

after(() => {
  replaceAppSettings(baseline);
  resetSettingsMemo();
});

test("一秒内重复读走 memo，改完设置要么等过期要么显式重置", () => {
  replaceAppSettings({ ...baseline, mediaMountPath: ["/mnt/a"] });
  resetSettingsMemo();
  assert.deepEqual(readSettingsSafe().mediaMountPath, ["/mnt/a"]);

  replaceAppSettings({ ...baseline, mediaMountPath: ["/mnt/b"] });
  assert.deepEqual(readSettingsSafe().mediaMountPath, ["/mnt/a"], "memo 未过期，还是旧值");

  resetSettingsMemo();
  assert.deepEqual(readSettingsSafe().mediaMountPath, ["/mnt/b"]);
});

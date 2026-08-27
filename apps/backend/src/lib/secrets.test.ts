/**
 *   pnpm test:file src/lib/secrets.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { maskAccount, maskSecret, maskSettings, resolveSecret, unmaskAccountPatch, unmaskSettingsPatch } from "./secrets.js";

test("掩码只露末 4 位，太短的什么都不露，空值还是空", () => {
  assert.equal(maskSecret("abcdefghijkl"), "••••ijkl");
  assert.equal(maskSecret("short"), "••••");
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret(undefined), "");
});

test("回填：掩码/未提交沿用原值，空串清除，新值替换", () => {
  assert.equal(resolveSecret("••••ijkl", "abcdefghijkl"), "abcdefghijkl");
  assert.equal(resolveSecret(undefined, "old"), "old");
  assert.equal(resolveSecret("", "old"), "");
  assert.equal(resolveSecret("new", "old"), "new");
});

test("设置：只掩码密钥字段，其它原样", () => {
  const masked = maskSettings({ emby: { url: "http://e", apiKey: "emby-key-123456" }, tmdb: { language: "zh" }, "user-agent": "ua" });
  assert.deepEqual(masked.emby, { url: "http://e", apiKey: "••••3456" });
  assert.deepEqual(masked.tmdb, { language: "zh" });
  assert.equal(masked["user-agent"], "ua");
});

test("设置 patch：掩码值换回原值，其它组不受影响", () => {
  const current = { emby: { url: "http://old", apiKey: "emby-key-123456" }, telegram: { botToken: "123:abc" } };
  const out = unmaskSettingsPatch({ emby: { url: "http://new", apiKey: "••••3456" } }, current);
  assert.deepEqual(out, { emby: { url: "http://new", apiKey: "emby-key-123456" } });
});

test("账号：cookie/密码/令牌都掩码；新建时的掩码值变成 undefined", () => {
  const masked = maskAccount({ accountType: "115", name: "a", cookie: "UID=1234567890" });
  assert.equal((masked as { cookie?: string }).cookie, "••••7890");
  const created = unmaskAccountPatch({ accountType: "115", name: "a", cookie: "••••7890" }, null);
  assert.equal(created.cookie, undefined);
  const updated = unmaskAccountPatch({ name: "a", cookie: "••••7890", note: "x" }, { accountType: "115", name: "a", cookie: "UID=1234567890" });
  assert.equal(updated.cookie, "UID=1234567890");
  assert.equal(updated.note, "x");
});

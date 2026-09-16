/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/lib/version.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, isNewerVersion, isPrerelease, parseVersion } from "./version.js";

test("版本比较：大小位、v 前缀、预发布顺序", () => {
  assert.equal(compareVersions("2.7.0", "2.7.0"), 0);
  assert.equal(compareVersions("v2.7.0", "2.7.0"), 0, "v 前缀不算数");
  assert.equal(compareVersions("2.8.0", "2.7.9"), 1);
  assert.equal(compareVersions("2.7.1", "2.7.10"), -1, "按数字比，不是字典序");
  assert.equal(compareVersions("3.0.0", "2.99.99"), 1);
  // 预发布小于正式版；rc 之间按数字
  assert.equal(compareVersions("2.7.0-rc.2", "2.7.0"), -1);
  assert.equal(compareVersions("2.7.0", "2.7.0-rc.2"), 1);
  assert.equal(compareVersions("2.7.0-rc.2", "2.7.0-rc.10"), -1);
  assert.equal(compareVersions("2.7.0-rc", "2.7.0-rc.1"), -1, "段少的小");
  assert.equal(compareVersions("2.8.0-rc.1", "2.7.0"), 1, "下一个大版本的 rc 比上一个正式版新");
  assert.equal(compareVersions("2.7.0+build.5", "2.7.0"), 0, "构建元数据不参与比较");
});

test("版本比较：认不出的版本号返回 null，当作没有更新", () => {
  assert.equal(compareVersions("dev", "2.7.0"), null);
  assert.equal(compareVersions("2.7", "2.7.0"), null);
  assert.equal(compareVersions("", "2.7.0"), null);
  assert.equal(isNewerVersion("dev", "2.7.0"), false);
  assert.equal(isNewerVersion("2.8.0", "2.7.0"), true);
  assert.equal(isNewerVersion("2.7.0", "2.7.0"), false);
});

test("解析与预发布判断", () => {
  assert.deepEqual(parseVersion("v2.7.0-rc.2"), { nums: [2, 7, 0], pre: ["rc", 2] });
  assert.deepEqual(parseVersion("2.7.0"), { nums: [2, 7, 0], pre: [] });
  assert.equal(parseVersion("nightly"), null);
  assert.equal(isPrerelease("2.8.0-rc.1"), true);
  assert.equal(isPrerelease("2.8.0"), false);
  assert.equal(isPrerelease("dev"), false, "认不出的当正式版，别默认去比 rc");
});

/**
 * 网盘路径 ↔ OpenList 路径的换算。纯函数，不碰库也不碰网络。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/copy/paths.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppSettings } from "@openstrm/shared";
import { baseName, copyOptionsFor, copySettingsGap, dstDirFor, joinPath, normDir, parentDir, relativeTo, toOpenlistPath } from "./paths.js";

test("normDir：补头斜杠、去尾斜杠、收起连着的斜杠", () => {
  assert.equal(normDir("/115"), "/115");
  assert.equal(normDir("115"), "/115");
  assert.equal(normDir("/115/"), "/115");
  assert.equal(normDir("/115//云下载//"), "/115/云下载");
  assert.equal(normDir("/"), "/");
  assert.equal(normDir(""), "");
  assert.equal(normDir(undefined), "");
});

test("名字和父目录不 trim：网盘上真有结尾带空格的目录名", () => {
  assert.equal(baseName("/tv/Season 1 /E01.mkv"), "E01.mkv");
  assert.equal(parentDir("/tv/Season 1 /E01.mkv"), "/tv/Season 1 ");
  assert.equal(baseName("/tv/某剧 "), "某剧 ");
  assert.equal(parentDir("/tv"), "/");
});

test("toOpenlistPath：挂载根拼在网盘绝对路径前面", () => {
  const mounts = { my115: "/115", quark1: "/quark", root: "/" };
  assert.equal(toOpenlistPath(mounts, "my115", "/tv/某剧/S01E01.mkv"), "/115/tv/某剧/S01E01.mkv");
  assert.equal(toOpenlistPath(mounts, "quark1", "/来自：分享"), "/quark/来自：分享");
  assert.equal(toOpenlistPath(mounts, "root", "/tv"), "/tv", "挂载根是 / 时不多一层");
  assert.equal(toOpenlistPath(mounts, "没配过的账号", "/tv"), null);
});

test("relativeTo：不在根下面的返回 null", () => {
  assert.equal(relativeTo("/tv", "/tv/某剧/S01/E01.mkv"), "某剧/S01/E01.mkv");
  assert.equal(relativeTo("/tv", "/tv"), "");
  assert.equal(relativeTo("/tv", "/movies/别的"), null);
  assert.equal(relativeTo("/tv", "/tvshows/像但不是"), null, "只认整段前缀");
  assert.equal(relativeTo("/", "/tv/某剧"), "tv/某剧");
});

test("dstDirFor：目录层级原样搬到目标下面，不平铺", () => {
  assert.deepEqual(dstDirFor("/local/media", "/tv", "/tv/某剧/S01/E01.mkv"), { dstDir: "/local/media/某剧/S01", flattened: false });
  assert.deepEqual(dstDirFor("/local/media", "/tv", "/tv/某剧"), { dstDir: "/local/media", flattened: false });
  assert.deepEqual(dstDirFor("/local/media/", "/tv", "/tv/a/b.mkv"), { dstDir: "/local/media/a", flattened: false });
});

test("dstDirFor：没给根、或路径不在根下面，就平铺到目标目录", () => {
  assert.deepEqual(dstDirFor("/local/media", undefined, "/云下载/Show.S01"), { dstDir: "/local/media", flattened: false });
  assert.deepEqual(dstDirFor("/local/media", "/tv", "/别处/Show.S01"), { dstDir: "/local/media", flattened: true });
});

test("joinPath：中间只留一个斜杠", () => {
  assert.equal(joinPath("/115", "/tv"), "/115/tv");
  assert.equal(joinPath("/115/", "tv"), "/115/tv");
  assert.equal(joinPath("/", "tv"), "/tv");
  assert.equal(joinPath("/115", ""), "/115");
});

const withCopy = (openlistCopy: AppSettings["openlistCopy"]) => ({ openlistCopy }) as unknown as AppSettings;

test("copySettingsGap：按设置页从上到下说缺哪样；同类型的两个账号各看各的挂载根", () => {
  assert.match(copySettingsGap("115-a", withCopy(undefined)) ?? "", /还没选 OpenList 账号/);
  const s = withCopy({ account: "ol", dstDir: "/local", mounts: { "115-a": "/115", "115-b": "  " } });
  assert.equal(copySettingsGap("115-a", s), null);
  assert.match(copySettingsGap("115-b", s) ?? "", /账号 115-b 还没填「在 OpenList 里的挂载根」/, "只填了空白等于没填");
  assert.match(copySettingsGap("夸克", s) ?? "", /账号 夸克 还没填/);
  const noDst = withCopy({ account: "ol", mounts: { "115-a": "/115" } });
  assert.match(copySettingsGap("115-a", noDst) ?? "", /没有目标目录/);
  assert.equal(copySettingsGap("115-a", noDst, "/local/tv"), null, "任务上填了目标目录也行");
});

test("copyOptionsFor：要复制却配不齐就当关，blocked 说卡在哪；本来就不复制的不带 blocked", () => {
  const s = withCopy({ account: "ol", dstDir: "/local", mounts: { "115-a": "/115" } });
  // 老数据只有 deleteSource：读成 delete
  const on = { enabled: true, deleteSource: true };
  assert.deepEqual(copyOptionsFor({ account: "115-a", copyToOpenlist: on }, undefined, s), { enabled: true, dstDir: undefined, afterCopy: "delete" });
  assert.equal(copyOptionsFor({ account: "115-a", copyToOpenlist: { enabled: true, afterCopy: "archive" } }, undefined, s).afterCopy, "archive");
  assert.equal(copyOptionsFor({ account: "115-a", copyToOpenlist: { enabled: true } }, undefined, s).afterCopy, "keep");
  const blocked = copyOptionsFor({ account: "115-b", copyToOpenlist: on }, undefined, s);
  assert.equal(blocked.enabled, false);
  assert.equal(blocked.afterCopy, "keep");
  assert.match(blocked.blocked ?? "", /115-b 还没填/, "第二个 115 没填挂载根：任务开着复制也不复制，但要说出来");
  assert.match(copyOptionsFor({ account: "115-b" }, true, s).blocked ?? "", /115-b/, "一次性勾的也算要复制");
  assert.equal(copyOptionsFor({ account: "115-b", copyToOpenlist: on }, false, s).blocked, undefined, "这次明说不复制");
  assert.equal(copyOptionsFor({ account: "115-b" }, undefined, s).blocked, undefined, "任务上没开");
  assert.deepEqual(copyOptionsFor({ account: "115-a" }, true, s), { enabled: true, dstDir: undefined, afterCopy: "keep" }, "一次性勾选不动源文件");
  assert.equal(copyOptionsFor({ account: "115-a", copyToOpenlist: { enabled: false, afterCopy: "archive" } }, true, s).afterCopy, "keep", "任务没开复制：一次性勾的不认任务上留着的去向");
});

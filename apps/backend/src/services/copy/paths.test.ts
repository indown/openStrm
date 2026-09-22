/**
 * 网盘路径 ↔ OpenList 路径的换算。纯函数，不碰库也不碰网络。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/copy/paths.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { baseName, dstDirFor, joinPath, normDir, parentDir, relativeTo, toOpenlistPath } from "./paths.js";

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

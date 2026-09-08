/**
 * strm 内容检查规则：期望内容从本地路径推算、内容只取扩展名、编码开关两个方向都不重复编码。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/strm/inspect.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskDefinition } from "@openstrm/shared";
import { strmContent } from "./naming.js";
import { episodeKey, inspectStrm, isForeignStrm, showDirOf } from "./inspect.js";

const plain: TaskDefinition = { id: "t", account: "a", originPath: "tv", targetPath: "tv", strmPrefix: "/mnt/pan" };
const enc: TaskDefinition = { ...plain, id: "e", strmPrefix: "http://h/d", enablePathEncoding: true };

test("未编码任务：内容和本地路径对得上就是一致，网盘路径原样解析出来", () => {
  const r = inspectStrm(plain, "Show/S1/ep1.strm", "/mnt/pan/tv/Show/S1/ep1.mkv");
  assert.equal(r.matches, true);
  assert.equal(r.rewritable, true);
  assert.equal(r.reason, undefined);
  assert.equal(r.ext, ".mkv");
  assert.equal(r.expectedRemote, "tv/Show/S1/ep1.mkv");
  assert.equal(r.actualRemote, "tv/Show/S1/ep1.mkv");
});

test("originPath 带前导 / 时期望内容照写入方的样子带双斜杠", () => {
  const t = { ...plain, originPath: "/tv" };
  const r = inspectStrm(t, "Show/ep1.strm", "/mnt/pan//tv/Show/ep1.mkv");
  assert.equal(r.matches, true);
  assert.equal(r.actualRemote, "/tv/Show/ep1.mkv");
});

test("编码任务：期望按段编码；旧版整串 encodeURI 的内容判过期但可重写，路径能解回来", () => {
  const rel = "Why? (2020)/Re#1 100%.strm";
  const old = encodeURI("http://h/d/tv/Why? (2020)/Re#1 100%.mkv");
  const r = inspectStrm(enc, rel, old);
  assert.equal(r.matches, false);
  assert.equal(r.rewritable, true);
  assert.equal(r.expectedContent, "http://h/d/tv/Why%3F%20(2020)/Re%231%20100%25.mkv");
  assert.equal(r.actualRemote, "tv/Why? (2020)/Re#1 100%.mkv");
  assert.equal(inspectStrm(enc, rel, r.expectedContent).matches, true, "重写后的内容就是一致的");
});

test("编码开关两个方向：都按本地路径重算，不会出现 %2520", () => {
  const encodedContent = "/mnt/pan/tv/A%20B/ep%201.mkv";
  const off = inspectStrm(plain, "A B/ep 1.strm", encodedContent);
  assert.equal(off.matches, false);
  assert.equal(off.rewritable, true);
  assert.equal(off.expectedContent, "/mnt/pan/tv/A B/ep 1.mkv");
  assert.equal(off.actualRemote, "tv/A B/ep 1.mkv");

  const onTask = { ...plain, enablePathEncoding: true };
  const on = inspectStrm(onTask, "A B/ep 1.strm", "/mnt/pan/tv/A B/ep 1.mkv");
  assert.equal(on.matches, false);
  assert.equal(on.expectedContent, "/mnt/pan/tv/A%20B/ep%201.mkv");
  assert.ok(!on.expectedContent.includes("%2520"));
  assert.equal(inspectStrm(onTask, "A B/ep 1.strm", on.expectedContent).matches, true);
});

test("文件名里字面的 % 原样对得上就不解码", () => {
  const r = inspectStrm(plain, "100%25 done.strm", "/mnt/pan/tv/100%25 done.mkv");
  assert.equal(r.matches, true);
  assert.equal(r.actualRemote, "tv/100%25 done.mkv");
});

test("前缀已改：prefix-mismatch，解析不出网盘路径，但期望内容正确且可重写", () => {
  const t = { ...plain, strmPrefix: "/new" };
  const r = inspectStrm(t, "Show/ep1.strm", "/old/tv/Show/ep1.mkv");
  assert.equal(r.reason, "prefix-mismatch");
  assert.equal(r.actualRemote, null);
  assert.equal(r.rewritable, true);
  assert.equal(r.matches, false);
  assert.equal(r.expectedContent, "/new/tv/Show/ep1.mkv");
});

test("内容里的文件名和本地文件名对不上：name-mismatch，不可重写，但仍给出应有内容", () => {
  const r = inspectStrm(plain, "Show/ep1.strm", "/mnt/pan/tv/Show/ep2.mkv");
  assert.equal(r.reason, "name-mismatch");
  assert.equal(r.rewritable, false);
  assert.equal(r.actualRemote, null);
  assert.equal(r.expectedContent, "/mnt/pan/tv/Show/ep1.mkv");
});

test("空内容 / 没有扩展名 / 指向另一个 strm：empty、no-ext，不可重写", () => {
  assert.equal(inspectStrm(plain, "a.strm", "   \n").reason, "empty");
  assert.equal(inspectStrm(plain, "a.strm", "/mnt/pan/tv/a").reason, "no-ext");
  assert.equal(inspectStrm(plain, "a.strm", "/mnt/pan/tv/a.strm").reason, "no-ext");
  assert.equal(inspectStrm(plain, "a.strm", "/mnt/pan/tv/a").rewritable, false);
});

test("尾部换行算过期，可重写成规范内容", () => {
  const r = inspectStrm(plain, "Show/ep1.strm", "/mnt/pan/tv/Show/ep1.mkv\n");
  assert.equal(r.matches, false);
  assert.equal(r.rewritable, true);
  assert.equal(r.actualRemote, "tv/Show/ep1.mkv");
  assert.equal(r.expectedContent, "/mnt/pan/tv/Show/ep1.mkv");
});

test("文件名里带点：a.b.strm 的期望是 a.b.mkv，不是 a.mkv", () => {
  const r = inspectStrm(plain, "Show/a.b.strm", "/mnt/pan/tv/Show/a.b.mkv");
  assert.equal(r.matches, true);
  assert.equal(r.expectedRemote, "tv/Show/a.b.mkv");
  assert.equal(strmContent(plain.strmPrefix, r.expectedRemote, false), r.expectedContent);
});

test("isForeignStrm：命中兄弟任务的前缀 + originPath 才算别人的；本任务改了 originPath 的旧内容仍归本任务", () => {
  const sib: TaskDefinition = { ...plain, id: "s", originPath: "tv2" };
  assert.equal(isForeignStrm("/mnt/pan/tv2/x.mkv", plain, [sib]), true);
  assert.equal(isForeignStrm("/mnt/pan/tv2/x%20y.mkv", plain, [sib]), true, "编码过的也认");
  assert.equal(isForeignStrm("/mnt/pan/tv/x.mkv", plain, [sib]), false);
  const renamed = { ...plain, originPath: "tv_new" };
  assert.equal(isForeignStrm("/mnt/pan/tv/x.mkv", renamed, [sib]), false, "谁也不命中 → 本任务的旧内容");
  assert.equal(isForeignStrm("/mnt/pan/tv/x.mkv", plain, [plain]), false, "自己不算兄弟");
});

test("episodeKey / showDirOf", () => {
  assert.deepEqual(episodeKey("Show.S01E01.1080p.mkv"), { season: 1, episode: 1 });
  assert.deepEqual(episodeKey("show s1e1.strm"), { season: 1, episode: 1 });
  assert.deepEqual(episodeKey("Show.S01E01E02.mkv"), { season: 1, episode: 1 });
  assert.equal(episodeKey("movie.mkv"), null);
  assert.equal(showDirOf("tv/Show/Season 01/ep.strm"), "tv/Show");
  assert.equal(showDirOf("Show/S02/ep.strm"), "Show");
  assert.equal(showDirOf("Show/第2季/ep.strm"), "Show");
  assert.equal(showDirOf("Show/Specials/ep.strm"), "Show");
  assert.equal(showDirOf("Show/ep.strm"), "Show");
  assert.equal(showDirOf("ep.strm"), "");
  assert.equal(showDirOf("Season 1/ep.strm"), "");
});

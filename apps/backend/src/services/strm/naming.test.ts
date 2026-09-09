/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/strm/naming.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePathSegments, normalizeStrmPrefix, strmContent } from "./naming.js";
import { safeDecode } from "../resolve/direct-link.js";

test("不编码：前缀 + 路径原样拼接", () => {
  assert.equal(strmContent("http://h:5244/d", "tv/Show S01/ep 1.mkv", false), "http://h:5244/d/tv/Show S01/ep 1.mkv");
  assert.equal(strmContent(undefined, "tv/a.mkv", false), "/tv/a.mkv");
});

test("编码：空格、#、?、%、中文按段转义，/ 保留，前缀的 scheme 和 host 不动", () => {
  const out = strmContent("http://h:5244/d", "tv/Why? (2020)/Re#1 100%.mkv", true);
  assert.equal(out, "http://h:5244/d/tv/Why%3F%20(2020)/Re%231%20100%25.mkv");
  assert.equal(strmContent("http://h/d", "电影/流浪 地球.mkv", true), "http://h/d/%E7%94%B5%E5%BD%B1/%E6%B5%81%E6%B5%AA%20%E5%9C%B0%E7%90%83.mkv");
  // 前缀里的空格、中文也转，但只过 encodeURI
  assert.equal(strmContent("http://h/我的 盘", "a.mkv", true), "http://h/%E6%88%91%E7%9A%84%20%E7%9B%98/a.mkv");
});

test("编码后的内容能被代理那头的 safeDecode 原样还原", () => {
  const plain = "tv/Why? (2020)/Re#1 100% 中文 a+b&c=d.mkv";
  const encoded = strmContent("/mnt/pan", plain, true);
  assert.equal(safeDecode(encoded), `/mnt/pan/${plain}`);
  assert.equal(encodePathSegments("a/b c/d"), "a/b%20c/d");
});

test("normalizeStrmPrefix：去首尾空白和尾斜杠，拼出来的内容里没有 //", () => {
  assert.equal(normalizeStrmPrefix(" http://h:5244/d/ "), "http://h:5244/d");
  assert.equal(normalizeStrmPrefix("/mnt/pan//"), "/mnt/pan");
  assert.equal(normalizeStrmPrefix("http://h:5244/d"), "http://h:5244/d", "本来就干净的原样返回");
  assert.equal(strmContent(normalizeStrmPrefix("http://h:5244/d/"), "tv/a.mkv", false), "http://h:5244/d/tv/a.mkv");
  assert.equal(strmContent(normalizeStrmPrefix("http://h:5244/d/"), "tv/a b.mkv", true), "http://h:5244/d/tv/a%20b.mkv");
});

test("normalizeStrmPrefix：只有斜杠的前缀保留一个 /，不会被剥成空串", () => {
  assert.equal(normalizeStrmPrefix("/"), "/");
  assert.equal(normalizeStrmPrefix("///"), "/");
  assert.equal(normalizeStrmPrefix("  "), "");
});

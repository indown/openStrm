/**
 * 分享链接的纯解析：两家各认自家的，注册表按严格程度排先后，Telegram 消息里挑链接。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/drive/share-links.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse115ShareLink } from "./providers/cloud115.js";
import { parseQuarkShareLink } from "./providers/quark.js";
import { findShareLink, parseShareRef } from "./registry.js";

test("夸克：只认 pan.quark.cn/s/<pwd_id>；提取码在 pwd= 或后面的「提取码：」里", () => {
  assert.deepEqual(parseQuarkShareLink("https://pan.quark.cn/s/1ed94d530d63"), {
    kind: "quark",
    code: "1ed94d530d63",
    password: "",
    url: "https://pan.quark.cn/s/1ed94d530d63",
  });
  assert.equal(parseQuarkShareLink("https://pan.quark.cn/s/abc123?pwd=xK9m")?.password, "xK9m");
  const withText = parseQuarkShareLink("链接：https://pan.quark.cn/s/abc123 提取码：ab12");
  assert.equal(withText?.password, "ab12");
  assert.equal(withText?.url, "https://pan.quark.cn/s/abc123?pwd=ab12");
  assert.equal(parseQuarkShareLink("https://115.com/s/abc123"), null);
  assert.equal(parseQuarkShareLink("abc123"), null);
});

test("115：自家域名的 URL、裸分享码、码-提取码；别家 URL 和带空格的句子不认", () => {
  assert.equal(parse115ShareLink("https://115cdn.com/s/swhk9bx3wwq?password=sff1")?.password, "sff1");
  assert.equal(parse115ShareLink("swhk9bx3wwq")?.code, "swhk9bx3wwq");
  assert.equal(parse115ShareLink("swhk9bx3wwq-sff1")?.password, "sff1");
  assert.equal(parse115ShareLink("https://pan.quark.cn/s/abc123"), null);
  assert.equal(parse115ShareLink("看看这个 https://115.com/s/abc123"), null);
});

test("parseShareRef：严格认域名的先来，裸码归 115", () => {
  assert.equal(parseShareRef("https://pan.quark.cn/s/abc123")?.kind, "quark");
  assert.equal(parseShareRef("https://anxia.com/s/abc123")?.kind, "115");
  assert.equal(parseShareRef("abc123")?.kind, "115");
  assert.equal(parseShareRef("https://example.com/s/abc123"), null);
});

test("findShareLink：从整句话里挑出链接，只认 URL 不认裸码，提取码可以在句子里", () => {
  assert.equal(findShareLink("看看这个 https://115cdn.com/s/swhk9bx3wwq?password=sff1 不错")?.url, "https://115cdn.com/s/swhk9bx3wwq?password=sff1");
  const q = findShareLink("夸克 https://pan.quark.cn/s/abc123 提取码：zz11，速存");
  assert.equal(q?.kind, "quark");
  assert.equal(q?.password, "zz11");
  const v = findShareLink("https://115.com/s/abc123 提取码 ab12");
  assert.equal(v?.password, "ab12");
  assert.equal(v?.url, "https://115.com/s/abc123?password=ab12");
  assert.equal(findShareLink("abc123 这是一句话"), null);
  assert.equal(findShareLink("thunder://abc"), null);
});

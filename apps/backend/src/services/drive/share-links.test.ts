/**
 * 分享链接的纯解析：两家各认自家的，注册表按严格程度排先后，Telegram 消息里挑链接。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/drive/share-links.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse115ShareLink } from "./providers/cloud115.js";
import { parseQuarkShareLink } from "./providers/quark.js";
import { findShareLink, parseShareRef, parseShareText, withPassword } from "./registry.js";

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

test("夸克：?pwd= 后面跟着网页片段（#/list/share）或中文标点，提取码只读到那里为止", () => {
  const frag = parseQuarkShareLink("https://pan.quark.cn/s/abc123?pwd=ab12#/list/share");
  assert.equal(frag?.password, "ab12");
  assert.equal(frag?.url, "https://pan.quark.cn/s/abc123?pwd=ab12");
  assert.equal(parseQuarkShareLink("https://pan.quark.cn/s/abc123#/list/share")?.code, "abc123");
  assert.equal(parseQuarkShareLink("「https://pan.quark.cn/s/abc123def?pwd=ab12」")?.password, "ab12");
  assert.equal(parseQuarkShareLink("【https://pan.quark.cn/s/abc123def?pwd=ab12】")?.password, "ab12");
  assert.equal(parseQuarkShareLink("(https://pan.quark.cn/s/abc123def?pwd=ab12).")?.password, "ab12");
});

test("115：链接里的提取码到片段、中文标点为止；裸分享码的几种写法（不分大小写）都认，?password= 读的是后面的码", () => {
  assert.equal(parse115ShareLink("https://115.com/s/swabc123xyz?password=u796#/list")?.password, "u796");
  assert.equal(parse115ShareLink("https://115.com/s/swabc123xyz?password=u796】")?.password, "u796");
  for (const [text, code, password] of [
    ["swzjt593ztd", "swzjt593ztd", ""],
    ["swzjt593ztd-v421", "swzjt593ztd", "v421"],
    ["swzjt593ztd?password=v421", "swzjt593ztd", "v421"],
    ["SWZJT593ZTD?PASSWORD=V421", "SWZJT593ZTD", "V421"],
    ["SWZJT593ZTD-V421", "SWZJT593ZTD", "V421"],
    ["swzjt593ztd?v421", "swzjt593ztd", "v421"],
    ["swzjt593ztd?password=v421#", "swzjt593ztd", "v421"],
  ]) {
    const ref = parse115ShareLink(text);
    assert.equal(ref?.code, code, text);
    assert.equal(ref?.password, password, text);
  }
  assert.equal(parse115ShareLink("swzjt593ztd?password=v421")?.url, "https://115.com/s/swzjt593ztd?password=v421");
  // 分享接口认一整段也一样
  assert.equal(parseShareText("swzjt593ztd?password=v421")?.password, "v421");
  assert.equal(parseShareText("  SWZJT593ZTD-V421 ")?.password, "V421");
});

test("一段话里的链接到中文标点为止：【】「」！跟着链接的不算链接的一部分", () => {
  const bracketed = findShareLink("【https://115.com/s/swabc123xyz?password=u796】");
  assert.equal(bracketed?.code, "swabc123xyz");
  assert.equal(bracketed?.password, "u796");
  const labelled = findShareLink("【链接：https://115.com/s/swabc123xyz】");
  assert.equal(labelled?.code, "swabc123xyz");
  assert.equal(labelled?.password, "");
  const bang = findShareLink("链接：https://115.com/s/swabc123xyz！提取码：u796");
  assert.equal(bang?.code, "swabc123xyz");
  assert.equal(bang?.password, "u796");
  assert.equal(findShareLink("「https://pan.quark.cn/s/abc123def?pwd=ab12」")?.password, "ab12");
  assert.equal(findShareLink("看这个（https://115.com/s/swabc123xyz?password=u796）。")?.password, "u796");
  assert.equal(findShareLink("see https://115.com/s/swabc123xyz?password=u796).")?.password, "u796");
});

test("链接后面另写的提取码：提取码 / 访问码 / 密码 / 口令都认，「解压密码」不是", () => {
  for (const label of ["提取码：", "访问码：", "密码:", "口令 ", "提取码", "访问码 ："]) {
    assert.equal(findShareLink(`https://115.com/s/swabc123xyz ${label}u796`)?.password, "u796", label);
    assert.equal(parseQuarkShareLink(`https://pan.quark.cn/s/abc123 ${label}ab12`)?.password, "ab12", label);
  }
  assert.equal(findShareLink("https://115.com/s/swabc123xyz 解压密码：1234")?.password, "");
  assert.equal(parseQuarkShareLink("https://pan.quark.cn/s/abc123 解压密码：1234")?.password, "");
  assert.equal(findShareLink("https://115.com/s/swabc123xyz 提取码：u796 解压密码：1234")?.password, "u796");
});

test("withPassword：提取码拼在 # 前面（115 的链接常以 # 结尾），链接里本来就有的不动", () => {
  const ref = { kind: "115" as const, code: "swabc123xyz", password: "", url: "https://115.com/s/swabc123xyz#" };
  const withCode = withPassword(ref, "u796");
  assert.equal(withCode.url, "https://115.com/s/swabc123xyz?password=u796");
  assert.equal(parse115ShareLink(withCode.url)?.password, "u796", "拼出来的再解析读得到");
  assert.equal(withPassword({ ...ref, url: "https://115.com/s/swabc123xyz?foo=1#/x" }, "u796").url, "https://115.com/s/swabc123xyz?foo=1&password=u796");
  assert.equal(withPassword({ kind: "quark", code: "abc", password: "", url: "https://pan.quark.cn/s/abc#/list/share" }, "ab12").url, "https://pan.quark.cn/s/abc?pwd=ab12");
  assert.equal(withPassword({ ...ref, password: "zzzz" }, "u796").password, "zzzz");
});

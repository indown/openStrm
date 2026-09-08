/**
 * 夸克客户端里不碰网络的三个纯函数：cookie 合并、Set-Cookie 取值、文件名反转义。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/quark/client.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cookieFromSetCookie, mergeCookie, unescapeHtml } from "./client.js";

test("mergeCookie：已有的键替换、没有就追加，其它键和顺序原样", () => {
  assert.equal(mergeCookie("a=1; __puus=old; b=2", "__puus", "new"), "a=1; __puus=new; b=2");
  assert.equal(mergeCookie("a=1", "__puus", "x"), "a=1; __puus=x");
  assert.equal(mergeCookie("", "__puus", "x"), "__puus=x");
  // 值里带 = 也只按第一个 = 切键
  assert.equal(mergeCookie("__puus=a=b; c=3", "__puus", "z"), "__puus=z; c=3");
});

test("cookieFromSetCookie：只看分号前的键值对，属性忽略；缺失返回 null", () => {
  assert.equal(cookieFromSetCookie(["other=1", "__puus=abc; Path=/; HttpOnly; Secure"], "__puus"), "abc");
  assert.equal(cookieFromSetCookie("__puus=solo; Path=/", "__puus"), "solo");
  assert.equal(cookieFromSetCookie(undefined, "__puus"), null);
  assert.equal(cookieFromSetCookie(["__pus=1"], "__puus"), null);
});

test("unescapeHtml：命名实体、十进制和十六进制实体；不认识的原样留下", () => {
  assert.equal(unescapeHtml("A &amp; B &#39;x&#39; &lt;3&gt; &#x4e2d;&quot;"), `A & B 'x' <3> 中"`);
  assert.equal(unescapeHtml("plain name.mkv"), "plain name.mkv");
  assert.equal(unescapeHtml("&unknown; &#xZZ;"), "&unknown; &#xZZ;");
});

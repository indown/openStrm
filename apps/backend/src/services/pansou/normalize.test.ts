/**
 * PanSou 结果的归一化：认链接（提取码拼进去、115 三个域名合一、磁力去 tracker）、去重、清标题、日期、来源、按账号标能做什么。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/pansou/normalize.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountInfo } from "@openstrm/shared";
import { SAMPLE } from "../../test/fake-pansou.js";
import type { PansouLink } from "./client.js";
import {
  accountCaps,
  cleanDate,
  cleanTitle,
  keywordFromName,
  normalizeLink,
  normalizeResults,
  parseSource,
  type AccountCaps,
} from "./normalize.js";

const ALL: AccountCaps = { share: new Set(["115", "quark"]), offline: true };
const NONE: AccountCaps = { share: new Set(), offline: false };

const link = (l: { url: string; password?: string; note?: string; datetime?: string; source?: string }): PansouLink => ({
  url: l.url,
  password: l.password ?? "",
  note: l.note ?? "",
  datetime: l.datetime ?? "",
  source: l.source ?? "",
});

test("115：三个域名是同一个分享，链接统一成 115.com，提取码带着", () => {
  for (const url of ["https://115.com/s/swabc123xyz?password=u796", "https://anxia.com/s/swabc123xyz?password=u796", "https://115cdn.com/s/swabc123xyz?password=u796#"]) {
    const n = normalizeLink("115", url, "u796");
    assert.equal(n.kind, "115");
    assert.equal(n.key, "115:swabc123xyz");
    assert.equal(n.url, "https://115.com/s/swabc123xyz?password=u796");
    assert.equal(n.password, "u796");
  }
  // 提取码只在 password 字段里：拼进链接
  assert.equal(normalizeLink("115", "https://115.com/s/swabc123xyz", "u796").url, "https://115.com/s/swabc123xyz?password=u796");
  // 没有提取码
  const bare = normalizeLink("115", "https://115.com/s/swabc123xyz", "");
  assert.equal(bare.url, "https://115.com/s/swabc123xyz");
  assert.equal(bare.password, undefined);
});

test("夸克：提取码拼成 ?pwd=；认不出的分享降成 other（只能复制）", () => {
  const n = normalizeLink("quark", "https://pan.quark.cn/s/157e84553650", "ab12");
  assert.deepEqual(n, { kind: "quark", key: "quark:157e84553650", url: "https://pan.quark.cn/s/157e84553650?pwd=ab12", password: "ab12" });
  // PanSou 说是 115，其实是别家的地址：不认
  const odd = normalizeLink("115", "https://example.com/s/abc", "");
  assert.equal(odd.kind, "other");
  // 不是网址的也不当分享码：后端的 115 解析认裸分享码，这里不能让一个词冒充
  assert.equal(normalizeLink("115", "swabc123xyz", "").kind, "other");
  // 夸克的类型却是 115 的链接：两边对不上，也不认
  assert.equal(normalizeLink("quark", "https://115.com/s/swabc123xyz", "").kind, "other");
});

test("磁力去掉 tracker 和文件名、hash 小写；电驴按 hash 去重；别家的原样", () => {
  const m = normalizeLink("magnet", SAMPLE.magnet.url, "");
  assert.equal(m.url, "magnet:?xt=urn:btih:b1caf2a9c5cabc705b056c06dc5365f1eaf4c098");
  assert.equal(m.key, "magnet:b1caf2a9c5cabc705b056c06dc5365f1eaf4c098");
  // base32 的 hash 原样（大小写有意义的写法不去碰），去重键还是小写
  const b32 = normalizeLink("magnet", "magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", "");
  assert.equal(b32.url, "magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
  assert.equal(b32.key, "magnet:abcdefghijklmnopqrstuvwxyz234567");
  const ed = normalizeLink("ed2k", "ed2k://|file|Dune.mkv|123456|0123456789ABCDEF0123456789ABCDEF|/", "");
  assert.equal(ed.kind, "ed2k");
  assert.equal(ed.key, "ed2k:0123456789abcdef0123456789abcdef");
  const baidu = normalizeLink("baidu", SAMPLE.baidu.url, "1234");
  assert.deepEqual(baidu, { kind: "other", key: `other:${SAMPLE.baidu.url}`, url: SAMPLE.baidu.url, password: "1234" });
});

test("标题：去掉「名称：」前缀、零宽和控制字符，压空白；过长截断", () => {
  assert.equal(cleanTitle("名称: 沙丘2 4K"), "沙丘2 4K");
  assert.equal(cleanTitle("资源名称：沙丘2"), "沙丘2");
  assert.equal(cleanTitle("片名：漫长的季节 (2023) 4K 全集"), "漫长的季节 (2023) 4K 全集");
  assert.equal(cleanTitle("📚名称：《漫长的季节》（2023）"), "《漫长的季节》（2023）");
  assert.equal(cleanTitle("🎬《沙丘2（2024）》"), "🎬《沙丘2（2024）》", "没有冒号的前缀不去");
  assert.equal(cleanTitle("片名 漫长的季节"), "片名 漫长的季节");
  assert.equal(cleanTitle("沙\u200b丘2\n\n4K\t原盘"), "沙丘2 4K 原盘");
  assert.equal(cleanTitle("  "), "");
  const long = cleanTitle("长".repeat(500));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith("…"));
});

test("日期：0001 年这类占位的、解析不了的当没有；来源拆成类型和名字", () => {
  assert.equal(cleanDate("0001-01-01T00:00:00Z"), undefined);
  assert.equal(cleanDate(""), undefined);
  assert.equal(cleanDate("not a date"), undefined);
  assert.equal(cleanDate("2024-07-24T14:15:00Z"), "2024-07-24T14:15:00.000Z");
  assert.deepEqual(parseSource("tg:Lsp115"), { type: "tg", name: "Lsp115" });
  assert.deepEqual(parseSource("plugin:wanou"), { type: "plugin", name: "wanou" });
  assert.deepEqual(parseSource("unknown"), { type: "unknown", name: "" });
  assert.deepEqual(parseSource(""), { type: "unknown", name: "" });
});

test("整组结果：按 115、夸克、磁力、其它排，类内保持 PanSou 的顺序；重复的留第一条、时间取新的", () => {
  const r = normalizeResults(
    "沙丘2",
    {
      baidu: [link(SAMPLE.baidu)],
      magnet: [link(SAMPLE.magnet)],
      quark: [link(SAMPLE.quark), link(SAMPLE.quarkPwd)],
      "115": [link(SAMPLE.l115), link(SAMPLE.l115b), link(SAMPLE.l115anxia)],
    },
    ALL,
  );
  assert.deepEqual(
    r.items.map((h) => h.key),
    ["115:swabc123xyz", "115:swdef456uvw", "quark:4efe86519372", "quark:157e84553650", "magnet:b1caf2a9c5cabc705b056c06dc5365f1eaf4c098", `other:${SAMPLE.baidu.url}`],
  );
  assert.deepEqual(r.counts, { "115": 2, quark: 2, magnet: 1, other: 1 });
  const first = r.items[0];
  assert.equal(first.title, "沙丘2 4K 原盘", "留第一条的标题");
  assert.equal(first.publishedAt, "2025-01-01T04:32:44.000Z", "时间取两条里新的那个");
  assert.deepEqual(first.source, { type: "tg", name: "Lsp115" });
  assert.equal(r.items.find((h) => h.key === "quark:4efe86519372")?.publishedAt, undefined);
  assert.equal(r.items.find((h) => h.kind === "other")?.panType, "baidu");
  assert.equal(r.items.find((h) => h.kind === "other")?.panLabel, "百度");
  assert.equal(r.items[0].panLabel, "115");
});

test("能做什么按账号算：分享要有同类账号，磁力要有 115 账号，别家的只能复制", () => {
  const all = normalizeResults("k", { "115": [link(SAMPLE.l115)], quark: [link(SAMPLE.quark)], magnet: [link(SAMPLE.magnet)], baidu: [link(SAMPLE.baidu)] }, ALL);
  assert.deepEqual(all.items.map((h) => h.action), ["share", "share", "offline", null]);
  const none = normalizeResults("k", { "115": [link(SAMPLE.l115)], magnet: [link(SAMPLE.magnet)] }, NONE);
  assert.deepEqual(none.items.map((h) => h.action), [null, null]);
  const quarkOnly = normalizeResults("k", { "115": [link(SAMPLE.l115)], quark: [link(SAMPLE.quark)] }, { share: new Set(["quark"]), offline: false });
  assert.deepEqual(quarkOnly.items.map((h) => h.action), [null, "share"]);
});

test("账号能力：115、夸克有分享能力，OpenList 没有；有 115 账号才能云下载", () => {
  const a115: AccountInfo = { accountType: "115", name: "a", cookie: "c" };
  const q: AccountInfo = { accountType: "quark", name: "q", cookie: "c" };
  const ol: AccountInfo = { accountType: "openlist", name: "o", url: "http://ol", account: "u", password: "p" };
  const caps = accountCaps([q, ol]);
  assert.deepEqual([...caps.share], ["quark"]);
  assert.equal(caps.offline, false);
  const both = accountCaps([a115, q]);
  assert.deepEqual([...both.share].sort(), ["115", "quark"]);
  assert.equal(both.offline, true);
});

test("从名字拿关键词：追更名只要标题；【】[]{} 标签、括号里的年份去掉；去完是空的用原样；截到 100 字", () => {
  assert.equal(keywordFromName("繁花 / S1"), "繁花");
  assert.equal(keywordFromName("【完结】繁花 (2023) [4K]"), "繁花");
  assert.equal(keywordFromName("沙丘2（2024）{tmdb-693134}"), "沙丘2");
  assert.equal(keywordFromName("2046 (2004)"), "2046", "片名本身是数字的留着");
  assert.equal(keywordFromName("【合集】"), "【合集】");
  assert.equal(keywordFromName("x".repeat(150)).length, 100);
});

test("标签跟着结果走：从清过的标题里认（「名称：」前缀去掉以后）；认不出的不带 tags", () => {
  const r = normalizeResults("k", { "115": [link(SAMPLE.l115)], quark: [link(SAMPLE.quark)], magnet: [link(SAMPLE.magnet)] }, ALL);
  assert.deepEqual(
    r.items.map((h) => [h.title, h.tags]),
    [
      ["沙丘2 4K 原盘", ["4K", "原盘"]],
      ["沙丘2", undefined],
      ["沙丘2-Dune.Part.Two.2024.1080p.WEBRip[1.6G]", ["1080p", "WEB", "1.6G"]],
    ],
  );
});

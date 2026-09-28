/**
 * library_search：影库里按名字找目录，给得出判断对不对的东西（文件名、画质、大小、位置）和直接转存要的 id；
 * 失效分享里的只报个数；没找到给下一步。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/agent/tools/library.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgentToken } from "@openstrm/shared";
import { createApiToken, deleteAllApiTokens } from "../../../db/repositories/api-tokens.js";
import { writeAppSetting } from "../../../db/repositories/settings.js";
import { seedLibrarySource, unseedLibrarySource } from "../../../test/library-seed.js";
import { callTool, type ToolOutcome } from "../calls.js";
import { librarySearchTool } from "./library.js";

let reader: AgentToken;

const A = { id: "lib-a", shareCode: "swpacka", shareUrl: "https://115.com/s/swpacka?password=ab12", shareTitle: "老K" };
const B = { id: "lib-b", shareCode: "swpackb", shareUrl: "https://115.com/s/swpackb?password=cd34", shareTitle: "旧包" };

before(() => {
  writeAppSetting("agent", { enabled: true });
  reader = createApiToken({ name: "只读", scopes: ["read"], toolsets: ["transfer"], expiresAt: null }).info;
  seedLibrarySource({
    ...A,
    files: {
      "老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界/Forrest.Gump.1994.2160p.BluRay.REMUX.mkv": 50 * 1024 ** 3,
      "老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界/阿甘正传.jpg": 1024,
      "老K/2. 剧集/神探夏洛克/神探夏洛克 第1季/Sherlock.S01E01.mkv": 10,
      "老K/2. 剧集/神探夏洛克/神探夏洛克 第2季/Sherlock.S02E01.mkv": 10,
    },
  });
  seedLibrarySource({ ...B, status: "expired", files: { "旧包/阿甘正传 1080P/Forrest.Gump.1994.1080p.mkv": 8 } });
});

after(() => {
  unseedLibrarySource(A.id, A.shareCode);
  unseedLibrarySource(B.id, B.shareCode);
  deleteAllApiTokens();
});

async function run(args: Record<string, unknown>): Promise<Record<string, any>> {
  const out: ToolOutcome = await callTool(librarySearchTool, args, { token: reader, ip: "127.0.0.1" }, { signal: new AbortController().signal, progress: () => {} });
  assert.equal(out.ok, true, out.ok ? "" : JSON.stringify(out.failure));
  return (out as { ok: true; data: Record<string, any> }).data;
}

test("中文名、英文文件名都找得到；每条带判断用的信息和转存要的 id", async () => {
  const d = await run({ keyword: "阿甘正传" });
  assert.equal(d.total, 1, "失效分享里的那条不算");
  assert.equal(d.expired, 1);
  const [item] = d.items;
  assert.equal(item.title, "阿甘正传 4K原盘REMUX 杜比视界");
  assert.equal(item.share, "老K");
  assert.equal(item.link, A.shareUrl);
  assert.equal(item.itemId, "d:老K/1. 电影/阿甘正传 4K原盘REMUX 杜比视界");
  assert.equal(item.dirId, "d:老K/1. 电影");
  assert.deepEqual(item.files, ["Forrest.Gump.1994.2160p.BluRay.REMUX.mkv"]);
  assert.equal(item.size, "50.0 GB");
  assert.ok(item.tags.includes("4K"));
  assert.equal(item.shareStatus, "ok");
  assert.match(d.next, /share_inspect.*itemId.*share_save/);
  assert.equal((await run({ keyword: "forrest gump 1994" })).items[0].title, "阿甘正传 4K原盘REMUX 杜比视界");
});

test("剧的各季收进剧目录；limit 截断时说怎么缩小；没找到给下一步", async () => {
  const d = await run({ keyword: "sherlock" });
  assert.deepEqual(
    d.items.map((i: { title: string }) => i.title),
    ["神探夏洛克 第1季", "神探夏洛克 第2季"],
    "sherlock 只在文件名里，剧目录本身不含它，各季各一条",
  );
  const byName = await run({ keyword: "神探夏洛克" });
  assert.equal(byName.items.length, 1);
  assert.equal(byName.items[0].alsoMatchedInside, 2);

  const one = await run({ keyword: "sherlock", limit: 1 });
  assert.equal(one.items.length, 1);
  assert.match(one.truncated, /加词缩小范围/);

  const none = await run({ keyword: "不存在的片名" });
  assert.equal(none.items.length, 0);
  assert.match(none.message, /resource_search/);
});

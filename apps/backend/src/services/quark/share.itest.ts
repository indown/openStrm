/**
 * 夸克分享客户端对着本地假服务跑：stoken 缓存、分享目录翻页（带 share_fid_token）、转存 + 任务轮询、各种失败。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/quark/share.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import type { AccountQuark } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { clearRateLimiters } from "../download/rate-limited.js";
import { clearQuarkCaches, setQuarkApiBase } from "./client.js";
import {
  clearQuarkShareCaches,
  QuarkShareError,
  QuarkTaskError,
  quarkShareList,
  quarkShareSave,
  quarkShareToken,
  quarkWaitTask,
} from "./share.js";

type RawFile = { fid: string; file_name: string; dir: boolean; size?: number; updated_at?: number; share_fid_token: string };
const shareTree: Record<string, RawFile[]> = {
  "0": [
    { fid: "d-s1", file_name: "Season 1", dir: true, share_fid_token: "tok-d-s1" },
    { fid: "f-nfo", file_name: "show &amp; more.nfo", dir: false, size: 3, share_fid_token: "tok-f-nfo" },
  ],
  "d-s1": Array.from({ length: 120 }, (_, i) => ({ fid: `f-${i + 1}`, file_name: `E${i + 1}.mkv`, dir: false, size: 10, share_fid_token: `tok-f-${i + 1}` })),
};
const calls = { token: 0, detail: 0, save: 0, task: 0 };
let saved: { fid_list: string[]; fid_token_list: string[]; to_pdir_fid: string; pwd_id: string; stoken: string } | null = null;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (url.pathname === "/share/sharepage/token") {
      calls.token++;
      if (body.pwd_id === "gone") return json(400, { status: 400, code: 41007, message: "share not exist" });
      if (body.pwd_id === "locked" && body.passcode !== "abcd") return json(400, { status: 400, code: 41010, message: "passcode error" });
      return json(200, { status: 200, code: 0, data: { stoken: `stk-${body.pwd_id}`, title: "The &amp; Show" } });
    }
    if (url.pathname === "/share/sharepage/detail") {
      calls.detail++;
      if (url.searchParams.get("stoken") !== `stk-${url.searchParams.get("pwd_id")}`) return json(400, { status: 400, code: 41008, message: "stoken invalid" });
      const all = shareTree[url.searchParams.get("pdir_fid") ?? "0"] ?? [];
      const page = Number(url.searchParams.get("_page") ?? 1);
      const size = Number(url.searchParams.get("_size") ?? 50);
      return json(200, { status: 200, code: 0, data: { list: all.slice((page - 1) * size, page * size) }, metadata: { _total: all.length } });
    }
    if (url.pathname === "/share/sharepage/save") {
      calls.save++;
      saved = body as typeof saved;
      return json(200, { status: 200, code: 0, data: { task_id: body.to_pdir_fid === "full" ? "t-fail" : "t-ok" } });
    }
    if (url.pathname === "/task") {
      calls.task++;
      const id = url.searchParams.get("task_id");
      const retry = Number(url.searchParams.get("retry_index") ?? 0);
      if (id === "t-fail") return json(200, { status: 200, code: 0, data: { status: 3, task_title: "空间不足" } });
      // 第一次还在跑，第二次完成
      if (retry === 0) return json(200, { status: 200, code: 0, data: { status: 1, task_title: "转存" } });
      return json(200, { status: 200, code: 0, data: { status: 2, task_title: "转存", save_as: { save_as_top_fids: ["n-1", "n-2"] } } });
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const account: AccountQuark = { accountType: "quark", name: "qs-itest", cookie: "a=1" };
const baseline = listAccounts();

before(() => {
  setQuarkApiBase(base);
  replaceAccounts([{ ...account }]);
});

after(async () => {
  setQuarkApiBase(null);
  clearQuarkCaches();
  clearQuarkShareCaches();
  clearRateLimiters();
  replaceAccounts(baseline);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

test("stoken 按 pwd_id + 提取码缓存；标题反转义", async () => {
  const a = await quarkShareToken(account, "abc", "");
  assert.equal(a.stoken, "stk-abc");
  assert.equal(a.title, "The & Show");
  await quarkShareToken(account, "abc", "");
  assert.equal(calls.token, 1, "第二次走缓存");
});

test("分享不存在 / 提取码错：QuarkShareError 带错误码", async () => {
  await assert.rejects(quarkShareToken(account, "gone", ""), (e: unknown) => e instanceof QuarkShareError && e.code === 41007 && /share not exist/.test(e.message));
  await assert.rejects(quarkShareToken(account, "locked", "xxxx"), (e: unknown) => e instanceof QuarkShareError && e.code === 41010);
  assert.equal((await quarkShareToken(account, "locked", "abcd")).stoken, "stk-locked");
});

test("列分享目录：翻页拼齐、目录标记、名字反转义、带 share_fid_token；stoken 不对是 QuarkShareError", async () => {
  const root = await quarkShareList(account, "abc", "stk-abc", "0", 1);
  assert.equal(root.total, 2);
  assert.deepEqual(root.list.map((f) => [f.name, f.isDir, f.token]), [["Season 1", true, "tok-d-s1"], ["show & more.nfo", false, "tok-f-nfo"]]);
  const p1 = await quarkShareList(account, "abc", "stk-abc", "d-s1", 1);
  const p3 = await quarkShareList(account, "abc", "stk-abc", "d-s1", 3);
  assert.equal(p1.total, 120);
  assert.equal(p1.list.length, 50);
  assert.equal(p3.list.length, 20);
  assert.equal(p3.list[19].fid, "f-120");
  await assert.rejects(quarkShareList(account, "abc", "bad", "0", 1), (e: unknown) => e instanceof QuarkShareError && e.code === 41008);
});

test("转存：fid 和 token 一一对应地提交，轮询到完成拿到顶层 fid；任务失败是 QuarkTaskError", async () => {
  const { taskId } = await quarkShareSave(account, { pwdId: "abc", stoken: "stk-abc", items: [{ id: "d-s1", token: "tok-d-s1" }, { id: "f-nfo", token: "tok-f-nfo" }], toPdirFid: "dst" });
  assert.equal(taskId, "t-ok");
  assert.deepEqual(saved, { fid_list: ["d-s1", "f-nfo"], fid_token_list: ["tok-d-s1", "tok-f-nfo"], to_pdir_fid: "dst", pwd_id: "abc", stoken: "stk-abc", pdir_fid: "0", scene: "link" } as unknown);
  const done = await quarkWaitTask(account, taskId);
  assert.equal(done.status, 2);
  assert.deepEqual(done.topIds, ["n-1", "n-2"]);
  assert.ok(calls.task >= 2, "第一次还在跑，轮询到第二次才完成");

  const failing = await quarkShareSave(account, { pwdId: "abc", stoken: "stk-abc", items: [{ id: "f-1", token: "tok-f-1" }], toPdirFid: "full" });
  await assert.rejects(quarkWaitTask(account, failing.taskId), (e: unknown) => e instanceof QuarkTaskError && /空间不足/.test(e.message));
});

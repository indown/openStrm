/**
 * 夸克客户端对着本地假服务跑：请求头 / 查询参数、翻页、按路径找 fid 与缓存、__puus 写回、错误壳、直链。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/quark/client.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import type { AccountQuark } from "@openstrm/shared";
import { getAccount, listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { PermanentError } from "../../lib/errors.js";
import { clearRateLimiters } from "../download/rate-limited.js";
import {
  clearQuarkCaches,
  QUARK_REFERER,
  QUARK_UA,
  QuarkError,
  quarkDownloadLink,
  quarkListDir,
  quarkResolvePath,
  setQuarkApiBase,
} from "./client.js";

type RawFile = { fid: string; file_name: string; file: boolean; size?: number; category?: number };
const tree: Record<string, RawFile[]> = {
  "0": [
    { fid: "d-tv", file_name: "tv", file: false },
    { fid: "d-big", file_name: "big", file: false },
    { fid: "f-root", file_name: "root.txt", file: true, size: 3 },
  ],
  "d-tv": [{ fid: "d-show", file_name: "Show &amp; Co", file: false }],
  "d-show": [{ fid: "f-ep1", file_name: "ep1.mkv", file: true, size: 10, category: 1 }],
  "d-big": Array.from({ length: 250 }, (_, i) => ({ fid: `f-big-${i + 1}`, file_name: `big-${i + 1}.mkv`, file: true })),
};

let rotate = false;
let failMode: "none" | "code" | "http401" = "none";
const sortCalls = new Map<string, number>();
/** path_list 每次问了哪些路径 */
let pathListCalls: string[][] = [];
/** path_list 只认目录、只认精确路径（真机行为） */
const dirPaths: Record<string, RawFile & { file_path: string }> = {
  "/tv": { fid: "d-tv", file_name: "tv", file: false, file_path: "/tv" },
  "/tv/Show & Co": { fid: "d-show", file_name: "Show &amp; Co", file: false, file_path: "/tv/Show & Co" },
  "/big": { fid: "d-big", file_name: "big", file: false, file_path: "/big" },
};
let lastSort: { headers: http.IncomingHttpHeaders; query: URLSearchParams } | null = null;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...extra });
    res.end(JSON.stringify(body));
  };
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (url.pathname === "/file/sort") {
      const pdir = url.searchParams.get("pdir_fid") ?? "";
      sortCalls.set(pdir, (sortCalls.get(pdir) ?? 0) + 1);
      lastSort = { headers: req.headers, query: url.searchParams };
      if (failMode === "code") return json(200, { status: 200, code: 31001, message: "require login [guest]" });
      if (failMode === "http401") return json(401, { status: 401, code: 31001, message: "require login [guest]" });
      const all = tree[pdir] ?? [];
      const page = Number(url.searchParams.get("_page") ?? 1);
      const size = Number(url.searchParams.get("_size") ?? 100);
      const list = all.slice((page - 1) * size, page * size);
      const extra: Record<string, string> = rotate ? { "set-cookie": "__puus=new-puus; Path=/; HttpOnly" } : {};
      return json(
        200,
        { status: 200, code: 0, message: "ok", data: { list }, metadata: { _total: all.length, _page: page, _size: size } },
        extra,
      );
    }
    if (url.pathname === "/file/info/path_list") {
      const body = JSON.parse(raw) as { file_path: string[]; namespace: string };
      pathListCalls.push(body.file_path);
      if (body.namespace !== "0") return json(400, { status: 400, code: 14001, message: "Bad Parameter" });
      return json(200, { status: 200, code: 0, data: body.file_path.filter((p) => dirPaths[p]).map((p) => dirPaths[p]) });
    }
    if (url.pathname === "/file/download") {
      const body = JSON.parse(raw) as { fids: string[] };
      return json(200, { status: 200, code: 0, data: body.fids.map((fid) => ({ fid, download_url: `${base}/dl/${fid}` })) });
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const NAME = "qk-itest";
/** 写回测试会改这个对象的 cookie，所以它必须和库里那行是两份 */
const account: AccountQuark = { accountType: "quark", name: NAME, cookie: "a=1; __puus=old-puus" };
const baseline = listAccounts();

before(() => {
  setQuarkApiBase(base);
  replaceAccounts([{ ...account }]);
});

after(async () => {
  setQuarkApiBase(null);
  clearQuarkCaches();
  clearRateLimiters();
  replaceAccounts(baseline);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

test("列目录：带 pr / fr、Cookie、Referer、固定 UA；文件名反转义、按 file 判目录", async () => {
  const entries = await quarkListDir(account, "0");
  assert.deepEqual(
    entries.map((e) => [e.name, e.isDir]),
    [["tv", true], ["big", true], ["root.txt", false]],
  );
  assert.equal(lastSort?.query.get("pr"), "ucpro");
  assert.equal(lastSort?.query.get("fr"), "pc");
  assert.equal(lastSort?.query.get("fetch_all_file"), "1");
  assert.equal(lastSort?.headers.cookie, account.cookie);
  assert.equal(lastSort?.headers.referer, QUARK_REFERER);
  assert.equal(lastSort?.headers["user-agent"], QUARK_UA);
  const show = await quarkListDir(account, "d-tv");
  assert.equal(show[0].name, "Show & Co");
});

test("翻页：_total 250 分三页拼齐后停下", async () => {
  const entries = await quarkListDir(account, "d-big");
  assert.equal(entries.length, 250);
  assert.equal(sortCalls.get("d-big"), 3);
  assert.equal(entries[249].fid, "f-big-250");
});

test("按路径找 fid：两段以上先用 path_list 一次拿到目录；文件退回父目录再列一层；缓存命中不再请求；找不到 / 中间段是文件都是 PermanentError", async () => {
  clearQuarkCaches();
  sortCalls.clear();
  pathListCalls = [];
  const r = await quarkResolvePath(account, "tv/Show & Co");
  assert.equal(r.fid, "d-show");
  assert.equal(r.entry?.isDir, true);
  assert.equal(r.entry?.name, "Show & Co", "path_list 回来的名字同样反转义");
  assert.deepEqual(pathListCalls, [["/tv/Show & Co", "/tv"]], "整条路径和父目录一起问");
  assert.equal(sortCalls.size, 0, "path_list 命中就不用列目录");

  const again = await quarkResolvePath(account, "/tv/Show & Co/");
  assert.equal(again.fid, "d-show");
  assert.equal(pathListCalls.length, 1, "缓存命中，不再请求");
  assert.equal(sortCalls.size, 0);

  // 文件：父目录走缓存，只剩最后一段，直接列一次 d-show（不再问 path_list）
  const file = await quarkResolvePath(account, "tv/Show & Co/ep1.mkv");
  assert.equal(file.fid, "f-ep1");
  assert.equal(file.entry?.isDir, false);
  assert.equal(sortCalls.get("d-show"), 1);
  assert.equal(pathListCalls.length, 1);

  // 冷缓存找文件：path_list 拿不到文件但拿到父目录 → 只列一次父目录
  clearQuarkCaches();
  sortCalls.clear();
  const cold = await quarkResolvePath(account, "tv/Show & Co/ep1.mkv");
  assert.equal(cold.fid, "f-ep1");
  assert.deepEqual(pathListCalls.at(-1), ["/tv/Show & Co/ep1.mkv", "/tv/Show & Co"]);
  assert.deepEqual([...sortCalls.keys()], ["d-show"]);

  assert.deepEqual(await quarkResolvePath(account, ""), { fid: "0", entry: null });
  await assert.rejects(quarkResolvePath(account, "tv/nope"), PermanentError);
  // path_list 两个都不认（父目录是文件）：退回逐段列，照样是「不是目录」
  clearQuarkCaches();
  sortCalls.clear();
  await assert.rejects(quarkResolvePath(account, "root.txt/x"), PermanentError);
  assert.equal(sortCalls.get("0"), 1, "path_list 没命中就退回从根列");
});

test("响应的 Set-Cookie 轮换了 __puus：传入的对象和账号表里的 cookie 都更新", async () => {
  rotate = true;
  try {
    await quarkListDir(account, "0");
  } finally {
    rotate = false;
  }
  assert.equal(account.cookie, "a=1; __puus=new-puus");
  assert.equal((getAccount(NAME) as AccountQuark).cookie, "a=1; __puus=new-puus");
});

test("壳里 code != 0、HTTP 401 都是 QuarkError，带 message 和 code / status", async () => {
  failMode = "code";
  try {
    await assert.rejects(
      quarkListDir(account, "0"),
      (err: unknown) => err instanceof QuarkError && /require login/.test(err.message) && err.code === 31001,
    );
    failMode = "http401";
    await assert.rejects(quarkListDir(account, "0"), (err: unknown) => err instanceof QuarkError && err.status === 401);
  } finally {
    failMode = "none";
  }
});

test("直链：url 加上取文件必须带的 Cookie / Referer / UA", async () => {
  const link = await quarkDownloadLink(account, "f-ep1");
  assert.equal(link.url, `${base}/dl/f-ep1`);
  assert.equal(link.headers.Cookie, account.cookie);
  assert.equal(link.headers.Referer, QUARK_REFERER);
  assert.equal(link.headers["User-Agent"], QUARK_UA);
});

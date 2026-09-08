/**
 * 远程目录浏览接口的夸克分支：按路径找到目录再列子目录、id 给 fid；路径不存在 404、指向文件 400、接口报错 500 带原话。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/directory/remote.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import remoteRoute from "./remote.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { clearRateLimiters } from "../../services/download/rate-limited.js";
import { clearQuarkCaches, setQuarkApiBase } from "../../services/quark/client.js";

const tree: Record<string, Array<{ fid: string; file_name: string; file: boolean }>> = {
  "0": [
    { fid: "d-tv", file_name: "tv", file: false },
    { fid: "f-x", file_name: "x.txt", file: true },
  ],
  "d-tv": [
    { fid: "d-a", file_name: "A", file: false },
    { fid: "d-b", file_name: "B &amp; C", file: false },
    { fid: "f-y", file_name: "y.mkv", file: true },
  ],
};
let failMode: "none" | "code" = "none";
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname !== "/file/sort") {
    res.writeHead(404);
    return res.end();
  }
  if (failMode === "code") return json(200, { status: 200, code: 31001, message: "require login [guest]" });
  const list = tree[url.searchParams.get("pdir_fid") ?? ""] ?? [];
  json(200, { status: 200, code: 0, data: { list }, metadata: { _total: list.length } });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

let app: FastifyInstance;
let auth: Record<string, string>;
const baseline = listAccounts();

before(async () => {
  setQuarkApiBase(base);
  replaceAccounts([{ accountType: "quark", name: "qk", cookie: "c=1" }]);
  // 默认口令下除改密外一律 403，先换掉
  await writeAuthPassword("remote-itest-pw");
  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(remoteRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  setQuarkApiBase(null);
  clearQuarkCaches();
  clearRateLimiters();
  replaceAccounts(baseline);
  await writeAuthPassword(DEFAULT_AUTH.password);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const list = (path: string) =>
  app.inject({ method: "POST", url: "/api/directory/remote/list", headers: auth, payload: { account: "qk", path } });

test("夸克：根目录只列子目录，id 是 fid", async () => {
  const res = await list("");
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), [{ name: "tv", id: "d-tv", isDir: true, hasChildren: true }]);
});

test("夸克：按名字逐段进入子目录，名字反转义", async () => {
  const res = await list("tv");
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    res.json().map((n: { name: string; id: string }) => [n.name, n.id]),
    [["A", "d-a"], ["B & C", "d-b"]],
  );
});

test("夸克：路径不存在 404，指向文件 400，接口报错 500 且 message 是接口原话", async () => {
  assert.equal((await list("tv/nope")).statusCode, 404);
  assert.equal((await list("x.txt")).statusCode, 400);
  failMode = "code";
  try {
    clearQuarkCaches();
    const res = await list("tv");
    assert.equal(res.statusCode, 500);
    assert.match(res.json().message, /require login/);
    assert.equal(res.json().code, 31001);
  } finally {
    failMode = "none";
  }
});

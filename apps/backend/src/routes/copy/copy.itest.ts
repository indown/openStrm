/**
 * 「复制到 OpenList」队列的路由：看队列、重试、不跟了。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/copy/copy.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, AppSettings } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import copyRoute from "./index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { __test_resetCopy, enqueueCopy, listCopies, setCopyServiceDeps } from "../../services/copy/service.js";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { accounts: AccountInfo[]; openlistCopy: AppSettings["openlistCopy"] };

const drive: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const olAccount: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };

const call = (method: "GET" | "POST" | "DELETE", url: string) => app.inject({ method, url, headers: auth });

before(async () => {
  baseline = { accounts: listAccounts(), openlistCopy: readAppSettings().openlistCopy };
  replaceAccounts([drive, olAccount]);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { acc: "/115" } } });
  await writeAuthPassword("copy-itest-pw");

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(copyRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

beforeEach(async () => {
  await __test_resetCopy();
});

after(async () => {
  await __test_resetCopy();
  setCopyServiceDeps(null);
  await app.close();
  await writeAuthPassword(DEFAULT_AUTH.password);
  replaceAccounts(baseline.accounts);
  patchAppSettings({ openlistCopy: baseline.openlistCopy });
});

test("没有 token 一律 401", async () => {
  const res = await app.inject({ method: "GET", url: "/api/copy" });
  assert.equal(res.statusCode, 401);
});

test("GET /api/copy：队列和循环状态一起给", async () => {
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", trigger: "monitor" });
  const res = await call("GET", "/api/copy");
  assert.equal(res.statusCode, 200);
  const body = res.json() as { items: Array<{ name: string; dstDir: string }>; total: number; watcher: { pending: number } };
  assert.equal(body.items.length, 1);
  assert.equal(body.total, 1);
  assert.equal(body.items[0].name, "E01.mkv");
  assert.equal(body.items[0].dstDir, "/local/media/某剧/S01");
  assert.equal(body.watcher.pending, 1);
});

test("重试：只有办完/失败的才让重试，不存在的 404", async () => {
  enqueueCopy({ account: "acc", sources: ["/tv/a.mkv"], trigger: "manual" });
  const [c] = listCopies();
  const running = await call("POST", `/api/copy/${c.id}/retry`);
  assert.equal(running.statusCode, 409, "还在跑的不用重试");

  const missing = await call("POST", "/api/copy/没这个 id/retry");
  assert.equal(missing.statusCode, 404);
});

test("DELETE /api/copy/:id：从队列里去掉", async () => {
  enqueueCopy({ account: "acc", sources: ["/tv/a.mkv"], trigger: "manual" });
  const [c] = listCopies();
  const res = await call("DELETE", `/api/copy/${c.id}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { success: true });
  assert.equal(listCopies().length, 0);
});

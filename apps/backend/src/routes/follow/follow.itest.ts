/**
 * 追更路由的闭环：鉴权、校验、建 / 列 / 改 / 删 / 立即检查。分享和网盘换成内存假网盘。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/follow/follow.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, AppSettings, ShareFollowSummary, TaskDefinition } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import followRoute from "./index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../../services/drive/registry.js";
import { __test_resetFollows, setFollowServiceDeps } from "../../services/follow/service.js";
import { FakeDrive, type FakeTree } from "../../test/fake-drive.js";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; settings: AppSettings };
const account: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "115", originPath: "tv", targetPath: "follow-itest/tv", strmPrefix: "/mnt" };

const drive = new FakeDrive("115", account, { share: true });
let share: FakeTree;

before(async () => {
  baseline = { tasks: listTasks(), accounts: listAccounts(), settings: readAppSettings() };
  replaceTasks([task]);
  replaceAccounts([account]);
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"] });
  await writeAuthPassword("follow-itest-pw");
  drive.tree.addDir("/tv/The Show");
  share = drive.share!.define("abc", { title: "The Show", password: "1234" });
  share.addFile("/E01.mkv", { hash: "a" });
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
  setFollowServiceDeps({ notify: async () => {}, random: () => 0.5, gapMs: 0 });

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(followRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  await __test_resetFollows();
  setFollowServiceDeps(null);
  setDriveProviderFactory(null);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(path.join(DATA_DIR, "follow-itest"), { recursive: true, force: true });
  await writeAuthPassword(DEFAULT_AUTH.password);
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth, payload: payload as Record<string, unknown> | undefined });

test("不带令牌一律 401", async () => {
  const res = await app.inject({ method: "GET", url: "/api/follow" });
  assert.equal(res.statusCode, 401);
});

test("建订阅：校验、201、列表、重复 409、改、检查、删", async () => {
  assert.equal((await call("POST", "/api/follow", { shareCode: "abc" })).statusCode, 400, "taskId 必填");

  const created = await call("POST", "/api/follow", {
    shareUrl: "https://115.com/s/abc?password=1234",
    watchCid: "0",
    watchPath: "The Show",
    taskId: "t1",
    subPath: "The Show",
    intervalMinutes: 60,
    name: "The Show",
  });
  assert.equal(created.statusCode, 201, created.body);
  const follow = created.json<ShareFollowSummary>();
  assert.equal(follow.shareCode, "abc");
  assert.equal(follow.receiveCode, "1234");
  assert.equal(follow.knownCount, 1);
  assert.equal(follow.intervalMinutes, 60);
  assert.ok(!("known" in follow));

  const dup = await call("POST", "/api/follow", { shareCode: "abc", taskId: "t1" });
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json<{ data: ShareFollowSummary }>().data.id, follow.id);

  const list = await call("GET", "/api/follow");
  assert.equal(list.statusCode, 200);
  const body = list.json<{ follows: ShareFollowSummary[]; watcher: { running: boolean } }>();
  assert.deepEqual(body.follows.map((f) => f.id), [follow.id]);
  assert.equal(typeof body.watcher.running, "boolean");

  const updated = await call("PUT", `/api/follow/${follow.id}`, { name: "剧集", enabled: false });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json<ShareFollowSummary>().name, "剧集");
  assert.equal(updated.json<ShareFollowSummary>().enabled, false);
  assert.equal((await call("PUT", "/api/follow/nope", { name: "x" })).statusCode, 404);

  share.addFile("/E02.mkv", { hash: "b" });
  const checked = await call("POST", `/api/follow/${follow.id}/check`);
  assert.equal(checked.statusCode, 200, checked.body);
  const r = checked.json<{ follow: ShareFollowSummary; run: { added: string[]; generated: number } | null }>();
  assert.deepEqual(r.run?.added, ["E02.mkv"]);
  assert.equal(r.follow.knownCount, 2);
  assert.equal(drive.share!.calls.receive, 1);
  assert.ok(drive.tree.get("/tv/The Show/E02.mkv"), "转存进了任务目录");
  assert.ok(fs.existsSync(path.join(DATA_DIR, "follow-itest", "tv", "The Show", "E02.strm")), "生成了 strm");
  assert.equal((await call("POST", "/api/follow/nope/check")).statusCode, 404);

  assert.equal((await call("DELETE", `/api/follow/${follow.id}`)).statusCode, 200);
  assert.equal((await call("DELETE", `/api/follow/${follow.id}`)).statusCode, 404);
  assert.equal((await call("GET", "/api/follow")).json<{ follows: unknown[] }>().follows.length, 0);
});

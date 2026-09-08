/**
 * 分享接口的闭环：按链接挑账号、info / list / receive、跨网盘类型 400、没账号 400、转存后生成 strm、顺手建追更。
 * 115 和夸克各一个内存假网盘。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/share/share.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import shareRoute from "./index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../../services/drive/registry.js";
import { __test_resetFollows, setFollowServiceDeps } from "../../services/follow/service.js";
import { FakeDrive } from "../../test/fake-drive.js";

const a115: AccountInfo = { accountType: "115", name: "a", cookie: "c" };
const aQuark: AccountInfo = { accountType: "quark", name: "q", cookie: "c" };
const t115: TaskDefinition = { id: "s-115", account: "a", accountType: "115", originPath: "tv", targetPath: "share-itest/tv", strmPrefix: "/mnt/pan" };
const tQuark: TaskDefinition = { id: "s-quark", account: "q", accountType: "quark", originPath: "kk", targetPath: "share-itest/kk", strmPrefix: "/mnt/kk" };

const d115 = new FakeDrive("115", a115, { share: true });
const dQuark = new FakeDrive("quark", aQuark, { share: true });
const LINK_115 = "https://115.com/s/abc?password=1234";
const LINK_QUARK = "https://pan.quark.cn/s/qk123?pwd=abcd";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; settings: AppSettings };

before(async () => {
  baseline = { tasks: listTasks(), accounts: listAccounts(), settings: readAppSettings() };
  replaceTasks([t115, tQuark]);
  replaceAccounts([a115, aQuark]);
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"] });
  await writeAuthPassword("share-itest-pw");

  d115.tree.addDir("/tv/Show");
  const s115 = d115.share!.define("abc", { title: "115 剧", password: "1234" });
  s115.addFile("/S1/E01.mkv", { hash: "a" });
  s115.addFile("/S1/E02.mkv", { hash: "b" });
  s115.addFile("/readme.txt");

  dQuark.tree.addDir("/kk/Show");
  const sQuark = dQuark.share!.define("qk123", { title: "夸克剧", password: "abcd" });
  sQuark.addFile("/E01.mkv");
  sQuark.addFile("/E02.mkv");
  setDriveProviderFactory((account) => (account.name === "a" ? d115 : account.name === "q" ? dQuark : null));
  setFollowServiceDeps({ notify: async () => {}, random: () => 0.5, gapMs: 0 });

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(shareRoute);
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
  fs.rmSync(path.join(DATA_DIR, "share-itest"), { recursive: true, force: true });
  await writeAuthPassword(DEFAULT_AUTH.password);
});

const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/share", headers: auth, payload });

test("不带令牌 401；不认识的链接 400", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/share", payload: { action: "info", url: LINK_115 } })).statusCode, 401);
  const bad = await post({ action: "info", url: "https://example.com/s/xyz" });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /不认识这个分享链接/);
});

test("info / list：按链接挑同类账号，条目归一化，夸克条目带 token", async () => {
  const info = await post({ action: "info", url: LINK_115 });
  assert.equal(info.statusCode, 200, info.body);
  assert.deepEqual(info.json(), { kind: "115", account: "a", title: "115 剧", fileCount: 2 });

  const list = await post({ action: "list", url: LINK_115 });
  assert.equal(list.statusCode, 200, list.body);
  const entries = list.json().entries as Array<{ name: string; isDir: boolean; hash?: string }>;
  assert.deepEqual(entries.map((e) => [e.name, e.isDir]).sort(), [["S1", true], ["readme.txt", false]]);
  assert.equal(list.json().kind, "115");

  const qinfo = await post({ action: "info", url: LINK_QUARK });
  assert.equal(qinfo.json().account, "q");
  const qlist = await post({ action: "list", url: LINK_QUARK, dirId: "0" });
  const qentries = qlist.json().entries as Array<{ id: string; name: string; token?: string }>;
  assert.equal(qentries.length, 2);
  assert.ok(qentries.every((e) => e.token?.startsWith("tok-")), "夸克转存要的 token 跟着条目一起给前端");
});

test("提取码不对 → 500 且说明分享不可用；指定了打不开的账号 → 400", async () => {
  const wrong = await post({ action: "info", url: "https://115.com/s/abc?password=0000" });
  assert.equal(wrong.statusCode, 500);
  assert.match(wrong.json().message, /分享不可用/);
  const other = await post({ action: "info", url: LINK_115, account: "q" });
  assert.equal(other.statusCode, 400);
});

test("receive 到任务目录（sync）：转存进网盘、按子树生成 strm；跨网盘类型 400；顺手建追更", async () => {
  const list = await post({ action: "list", url: LINK_115 });
  const s1 = (list.json().entries as Array<{ id: string; name: string; isDir: boolean }>).find((e) => e.name === "S1")!;
  const res = await post({ action: "receive", url: LINK_115, taskId: "s-115", subPath: "Show", mode: "sync", items: [s1], follow: { intervalMinutes: 60 }, watchDirId: "0", watchPath: "", name: "115 剧" });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.mode, "sync");
  assert.equal(body.generatedCount, 2);
  assert.equal(body.strmGenerated, true);
  assert.ok(d115.tree.get("/tv/Show/S1/E02.mkv"), "整个目录转存进了任务目录的 Show 下");
  assert.equal(fs.readFileSync(path.join(DATA_DIR, "share-itest", "tv", "Show", "S1", "E01.strm"), "utf8"), "/mnt/pan/tv/Show/S1/E01.mkv");
  assert.equal(body.follow?.name, "115 剧", "顺手建了追更");
  assert.equal(body.follow?.taskId, "s-115");

  const cross = await post({ action: "receive", url: LINK_QUARK, taskId: "s-115", items: [{ id: "x", name: "x", isDir: false }] });
  assert.equal(cross.statusCode, 400);
  assert.match(cross.json().message, /夸克网盘的分享，不能转存到115 网盘/);
});

test("夸克 receive：带 token 转存，夸克给的顶层 id 直接用来列子树", async () => {
  const qlist = await post({ action: "list", url: LINK_QUARK });
  const items = qlist.json().entries as Array<{ id: string; name: string; isDir: boolean; token?: string }>;
  const res = await post({ action: "receive", url: LINK_QUARK, taskId: "s-quark", subPath: "Show", mode: "sync", items });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().generatedCount, 2);
  assert.ok(dQuark.tree.get("/kk/Show/E01.mkv"));
  assert.ok(fs.existsSync(path.join(DATA_DIR, "share-itest", "kk", "Show", "E02.strm")));
  assert.equal(dQuark.share!.calls.receive, 1);
});

test("receive 到网盘目录（不生成 strm）：toDirId 或 toPath 二选一，都没有 400", async () => {
  const list = await post({ action: "list", url: LINK_115 });
  const readme = (list.json().entries as Array<{ id: string; name: string; isDir: boolean }>).find((e) => e.name === "readme.txt")!;
  d115.tree.addDir("/inbox");
  const byPath = await post({ action: "receive", url: LINK_115, toPath: "inbox", items: [readme] });
  assert.equal(byPath.statusCode, 200, byPath.body);
  assert.equal(byPath.json().received, 1);
  assert.ok(d115.tree.get("/inbox/readme.txt"));
  const byId = await post({ action: "receive", url: LINK_115, toDirId: d115.tree.get("/inbox")!.id, items: [readme] });
  assert.equal(byId.statusCode, 200, byId.body);
  assert.equal((await post({ action: "receive", url: LINK_115, items: [readme] })).statusCode, 400);
  assert.equal((await post({ action: "receive", url: LINK_115, toPath: "nope", items: [readme] })).statusCode, 404);
});

test("没有同类账号：说清楚要加哪种账号", async () => {
  replaceAccounts([a115]);
  try {
    const res = await post({ action: "info", url: LINK_QUARK });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /添加一个夸克网盘账号/);
  } finally {
    replaceAccounts([a115, aQuark]);
  }
});

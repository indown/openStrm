/**
 * strm 管理路由的闭环：鉴权、校验、各接口形状、任务运行中 409。网盘走内存假网盘（test/fake-drive.ts）。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/strm/strm.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  AccountInfo,
  StrmDeleteResult,
  StrmFileInfo,
  StrmListResult,
  StrmRegenerateResult,
  StrmRewriteResult,
  StrmScanResult,
  StrmSearchResult,
  StrmVerifyEvent,
  StrmVerifyResult,
  TaskDefinition,
} from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import strmRoute from "./index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { DATA_DIR } from "../../paths.js";
import { releaseTaskStart, reserveTaskStart } from "../../services/task/registry.js";
import { setDriveProviderFactory } from "../../services/drive/registry.js";
import { FakeDrive } from "../../test/fake-drive.js";
import { verify, verify$ } from "../../services/strm/manage.js";
import type { DriveEntry } from "../../services/drive/types.js";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[] };

const acc115: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const accOl: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://x" };
const t115: TaskDefinition = { id: "r-main", account: "acc", accountType: "115", originPath: "tv", targetPath: "strm-itest/tv", strmPrefix: "/mnt/pan" };
const tOl: TaskDefinition = { id: "r-ol", account: "ol", accountType: "openlist", originPath: "x", targetPath: "strm-itest/ol", strmPrefix: "/mnt/ol" };

const ROOT = path.join(DATA_DIR, "strm-itest", "tv");
const drives = new Map<string, FakeDrive>();
const write = (rel: string, content: string) => {
  const p = path.join(ROOT, ...rel.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

before(async () => {
  baseline = { tasks: listTasks(), accounts: listAccounts() };
  replaceTasks([t115, tOl]);
  replaceAccounts([acc115, accOl]);
  await writeAuthPassword("strm-itest-pw");
  fs.rmSync(path.join(DATA_DIR, "strm-itest"), { recursive: true, force: true });
  write("Show/Season 1/ep1.strm", "/mnt/pan/tv/Show/Season 1/ep1.mkv");
  write("Show/Season 1/ep2.strm", "/old/tv/Show/Season 1/ep2.mkv");
  write("Show/x.part", "");

  // 115 账号的网盘：tv/Show/Season 1 下有 ep1 和 ep3；OpenList 账号的网盘是空的
  const d115 = new FakeDrive("115", acc115);
  d115.tree.addFile("/tv/Show/Season 1/ep1.mkv");
  d115.tree.addFile("/tv/Show/Season 1/ep3.mkv");
  drives.set("acc", d115);
  drives.set("ol", new FakeDrive("openlist", accOl));
  setDriveProviderFactory((account) => drives.get(account.name) ?? null);

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(strmRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  setDriveProviderFactory(null);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  fs.rmSync(path.join(DATA_DIR, "strm-itest"), { recursive: true, force: true });
  await writeAuthPassword(DEFAULT_AUTH.password);
});

const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers: auth, payload: payload as Record<string, unknown> });
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

test("不带令牌一律 401", async () => {
  assert.equal((await app.inject({ method: "GET", url: `/api/strm/list?${q({ taskId: "r-main" })}` })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/strm/scan", payload: { taskId: "r-main" } })).statusCode, 401);
});

test("任务不存在 404；入参校验 400", async () => {
  assert.equal((await get(`/api/strm/list?${q({ taskId: "nope" })}`)).statusCode, 404);
  assert.equal((await get("/api/strm/list")).statusCode, 400, "缺 taskId");
  assert.equal((await get(`/api/strm/file?${q({ taskId: "r-main" })}`)).statusCode, 400, "缺 path");
  assert.equal((await get(`/api/strm/search?${q({ taskId: "r-main", q: "  " })}`)).statusCode, 400, "q 空");
  assert.equal((await get(`/api/strm/search?${q({ taskId: "r-main", q: "a", limit: "9999" })}`)).statusCode, 400, "limit 超限");
  assert.equal((await post("/api/strm/delete", { taskId: "r-main", paths: [] })).statusCode, 400, "paths 空");
  assert.equal((await post("/api/strm/regenerate", { taskId: "r-main" })).statusCode, 400, "缺 path");
  assert.equal((await post("/api/strm/regenerate", { taskId: "r-main", path: "Show", mode: "nuke" })).statusCode, 400, "mode 不认识");
  assert.equal((await get(`/api/strm/list?${q({ taskId: "r-main", path: "../x" })}`)).statusCode, 400, "越界");
});

test("list / file / search 的形状", async () => {
  const root = await get(`/api/strm/list?${q({ taskId: "r-main" })}`);
  assert.equal(root.statusCode, 200, root.body);
  const rootBody = root.json<StrmListResult>();
  assert.equal(rootBody.exists, true);
  assert.deepEqual(rootBody.entries.map((e) => `${e.kind}:${e.name}`), ["dir:Show"]);

  const season = (await get(`/api/strm/list?${q({ taskId: "r-main", path: "Show/Season 1" })}`)).json<StrmListResult>();
  assert.equal(season.path, "Show/Season 1");
  assert.deepEqual(season.entries.map((e) => e.name), ["ep1.strm", "ep2.strm"]);
  assert.equal((await get(`/api/strm/list?${q({ taskId: "r-main", path: "Nope" })}`)).statusCode, 404);
  assert.deepEqual((await get(`/api/strm/list?${q({ taskId: "r-ol" })}`)).json<StrmListResult>(), { path: "", exists: false, entries: [] });

  const file = (await get(`/api/strm/file?${q({ taskId: "r-main", path: "Show/Season 1/ep2.strm" })}`)).json<StrmFileInfo>();
  assert.equal(file.reason, "prefix-mismatch");
  assert.equal(file.matches, false);
  assert.equal(file.expectedContent, "/mnt/pan/tv/Show/Season 1/ep2.mkv");

  const found = (await get(`/api/strm/search?${q({ taskId: "r-main", q: "EP" })}`)).json<StrmSearchResult>();
  assert.deepEqual(found.hits.map((h) => h.path), ["Show/Season 1/ep1.strm", "Show/Season 1/ep2.strm"]);
  assert.equal(found.truncated, false);
});

test("scan / rewrite / delete", async () => {
  const scanRes = await post("/api/strm/scan", { taskId: "r-main" });
  assert.equal(scanRes.statusCode, 200, scanRes.body);
  const scanned = scanRes.json<StrmScanResult>();
  assert.equal(scanned.counts["stale-content"], 1);
  assert.equal(scanned.counts["leftover-part"], 1);
  assert.equal(scanned.strm, 2);

  const dryRes = await post("/api/strm/rewrite", { taskId: "r-main", path: "Show", dryRun: true });
  assert.equal(dryRes.statusCode, 200, dryRes.body);
  const dry = dryRes.json<StrmRewriteResult>();
  assert.equal(dry.dryRun, true);
  assert.equal(dry.changed, 1);
  const appliedRes = await post("/api/strm/rewrite", { taskId: "r-main", path: "Show" });
  assert.equal(appliedRes.statusCode, 200, appliedRes.body);
  const applied = appliedRes.json<StrmRewriteResult>();
  assert.equal(applied.dryRun, false);
  assert.equal(applied.changed, 1);
  assert.equal(fs.readFileSync(path.join(ROOT, "Show", "Season 1", "ep2.strm"), "utf8"), "/mnt/pan/tv/Show/Season 1/ep2.mkv");

  assert.equal((await post("/api/strm/delete", { taskId: "r-main", paths: ["Show/x.part", ""] })).statusCode, 400, "空路径过不了校验");
  const delRes = await post("/api/strm/delete", { taskId: "r-main", paths: ["Show/x.part", "Nope/none"] });
  assert.equal(delRes.statusCode, 200, delRes.body);
  const del = delRes.json<StrmDeleteResult>();
  assert.equal(del.deleted, 1);
  assert.equal(del.failed.length, 1);
  assert.equal(fs.existsSync(path.join(ROOT, "Show", "x.part")), false);
});

test("regenerate / verify：任何网盘类型都能做（OpenList 本地目录不存在 404 / 校验 0 条）；115 任务 200；任务运行中写操作 409", async () => {
  assert.equal((await post("/api/strm/regenerate", { taskId: "r-ol", path: "Show" })).statusCode, 404, "本地还没有这个目录");
  const olVerify = await post("/api/strm/verify", { taskId: "r-ol" });
  assert.equal(olVerify.statusCode, 200, olVerify.body);
  assert.equal(olVerify.json<StrmVerifyResult>().checked, 0);

  const regen = await post("/api/strm/regenerate", { taskId: "r-main", path: "Show" });
  assert.equal(regen.statusCode, 200, regen.body);
  assert.deepEqual(regen.json<StrmRegenerateResult>(), { mode: "fill", remoteFiles: 2, generated: 1, skipped: 1, removed: 0 });
  assert.equal((await post("/api/strm/regenerate", { taskId: "r-main", path: "" })).statusCode, 400, "根目录");

  const verified = await post("/api/strm/verify", { taskId: "r-main", path: "Show" });
  assert.equal(verified.statusCode, 200, verified.body);
  const v = verified.json<StrmVerifyResult>();
  assert.equal(v.checked, 3);
  assert.deepEqual(v.missing.map((m) => `${m.path}:${m.reason}`), ["Show/Season 1/ep2.strm:file-missing"]);

  assert.ok(reserveTaskStart("r-main"));
  try {
    assert.equal((await post("/api/strm/regenerate", { taskId: "r-main", path: "Show" })).statusCode, 409);
    assert.equal((await post("/api/strm/delete", { taskId: "r-main", paths: ["Show/Season 1/ep3.strm"] })).statusCode, 409);
    assert.equal((await post("/api/strm/rewrite", { taskId: "r-main", path: "Show" })).statusCode, 409);
    assert.equal((await post("/api/strm/rewrite", { taskId: "r-main", path: "Show", dryRun: true })).statusCode, 200, "dryRun 不拦");
    assert.equal((await post("/api/strm/verify", { taskId: "r-main", path: "Show" })).statusCode, 200, "校验不拦");
  } finally {
    releaseTaskStart("r-main");
  }
});

const sseEvents = (body: string): StrmVerifyEvent[] =>
  body
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as StrmVerifyEvent);

test("校验的流式版：先推进度再推结果，结论和阻塞版一致", async () => {
  const res = await post("/api/strm/verify/stream", { taskId: "r-main", path: "Show" });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.headers["content-type"] ?? "", /text\/event-stream/);

  const events = sseEvents(res.body);
  const first = events[0];
  assert.equal(first?.type, "progress", "开头就该有一条进度，不能让弹框空着");
  assert.equal(first.type === "progress" ? first.progress.phase : "", "collect");

  const last = events.at(-1);
  assert.equal(last?.type, "done");
  const streamed = last?.type === "done" ? last.result : null;
  const blocking = (await post("/api/strm/verify", { taskId: "r-main", path: "Show" })).json<StrmVerifyResult>();
  assert.deepEqual(streamed, blocking, "两条路的结论必须一样");
});

test("流式版的失败走事件，不回 5xx（响应头早发了，Cloudflare 还会把 5xx 换成自己的页面）", async () => {
  const res = await post("/api/strm/verify/stream", { taskId: "r-main", path: "没有这个目录" });
  assert.equal(res.statusCode, 200, "已经是 200 的事件流了，改不了状态码");
  const last = sseEvents(res.body).at(-1);
  assert.equal(last?.type, "error");
  assert.match(last?.type === "error" ? last.message : "", /不存在/);
});

test("流式版：任务不存在还是普通 404（流还没开）；入参照样校验", async () => {
  assert.equal((await post("/api/strm/verify/stream", { taskId: "nope" })).statusCode, 404);
  assert.equal((await post("/api/strm/verify/stream", {})).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/strm/verify/stream", payload: { taskId: "r-main" } })).statusCode, 401);
});

test("校验流退订：中止信号跟着传到网盘请求上，活儿立刻停", async () => {
  const drive = drives.get("acc")!;
  const real = drive.listDir.bind(drive);
  const patchable = drive as unknown as { listDir: (id: string, signal?: AbortSignal) => Promise<DriveEntry[]> };
  let seen: AbortSignal | undefined;
  let entered!: () => void;
  const inFlight = new Promise<void>((resolve) => (entered = resolve));
  patchable.listDir = async (id, signal) => {
    seen = signal;
    entered();
    // 挂住，好在「正在问网盘」的当口退订
    await new Promise((r) => setTimeout(r, 500));
    return real(id);
  };
  try {
    const sub = verify$(t115, drive, "Show").subscribe({ next: () => {}, error: () => {} });
    await inFlight;
    assert.equal(seen?.aborted, false, "还在跑，不该是中止的");
    sub.unsubscribe();
    assert.equal(seen?.aborted, true, "退订（关弹框 / 断连）要把中止传到网盘请求上");
  } finally {
    patchable.listDir = real;
  }
});

test("校验被取消：整轮以中止收场，不会假装「缺失 0」顺利跑完", async () => {
  const already = new AbortController();
  already.abort();
  await assert.rejects(
    verify(t115, drives.get("acc")!, "Show", { signal: already.signal }),
    (err: Error) => err.name === "AbortError",
    "已经掐了还从头跑一遍本地目录，等于取消不算数",
  );

  // 跑到一半掐：假网盘不认 signal，得靠阶段边界那道检查兜住
  const drive = drives.get("acc")!;
  const real = drive.listDir.bind(drive);
  const patchable = drive as unknown as { listDir: (id: string, signal?: AbortSignal) => Promise<DriveEntry[]> };
  const midway = new AbortController();
  patchable.listDir = async (id) => {
    midway.abort();
    return real(id);
  };
  try {
    await assert.rejects(
      verify(t115, drive, "Show", { signal: midway.signal }),
      (err: Error) => err.name === "AbortError",
    );
  } finally {
    patchable.listDir = real;
  }
});

test("流式校验走真的 HTTP：进度和结论都推得出去", async () => {
  // 必须是真连接：app.inject() 不触发 req/res 的 'close'，曾经整条流一开就自关都测不出来
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const res = await fetch(`http://127.0.0.1:${port}/api/strm/verify/stream`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ taskId: "r-main", path: "Show" }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = (await res.text())
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as StrmVerifyEvent);
  assert.ok(events.length >= 2, `至少该有进度和结论两条，实际 ${events.length} 条`);
  assert.equal(events[0]?.type, "progress");
  assert.equal(events.at(-1)?.type, "done");
});

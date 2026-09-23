/**
 * P3 工具的闭环：起真实端口，用官方 SDK 的客户端连 /mcp，网盘用内存假网盘，TMDB 换成桩。
 *   - 整理：预览 → 清单（要拿主意的在前）→ 改清单（编号不变、planVersion 变）→ 旧版本执行被拒 → 执行 → 撤销；
 *     删除项要 danger 档加 confirmDelete；服务重启后清单改不了但能执行；同范围预览不重做；转存带回 runId
 *   - 当面确认：新协议、声明了 elicitation 的客户端弹确认框（同意 / 拒绝），老协议的照常执行
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/mcp/mcp-p3.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import mcpRoute from "./index.js";
import organizeRoute from "../organize/index.js";
import followRoute from "../follow/index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { createApiToken, deleteAllApiTokens } from "../../db/repositories/api-tokens.js";
import { __test_resetOrganize } from "../../db/repositories/organize.js";
import { patchAppSettings, readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../../services/drive/registry.js";
import { __test_resetAgentQuota } from "../../services/agent/rate-limit.js";
import { __test_resetJobs } from "../../services/agent/jobs.js";
import { __test_resetTransferCaches } from "../../services/agent/tools/transfer.js";
import { __test_resetAutoOrganize } from "../../services/organize/auto.js";
import { __test_resetFollows, listFollows, setFollowServiceDeps } from "../../services/follow/service.js";
import { __test_dropPlanState, cancelAllRuns, setOrganizeDeps, waitForRun } from "../../services/organize/run.js";
import type { TmdbApi } from "../../services/organize/identify.js";
import type { TmdbDetails, TmdbEpisode, TmdbSearchResult } from "../../services/tmdb.js";
import { cancelAllRunningTasks } from "../../services/task/registry.js";
import { FakeDrive } from "../../test/fake-drive.js";

const quark: AccountInfo = { accountType: "quark", name: "q", cookie: "c" };
const tv: TaskDefinition = { id: "p3-tv", account: "q", accountType: "quark", originPath: "tv", targetPath: "mcp-p3/tv", strmPrefix: "/mnt" };
const LOCAL = path.join(DATA_DIR, "mcp-p3");

const hit = (id: number, mediaType: "movie" | "tv", title: string, year: string): TmdbSearchResult => ({ id, mediaType, title, year, posterUrl: "", overview: "" });
class StubTmdb implements TmdbApi {
  /** 设了就让查 999 的详情停在这里，测「等 TMDB 的时候界面上有人改了清单」 */
  static gate: Promise<void> | null = null;
  async search(query: string): Promise<TmdbSearchResult[]> {
    const q = query.toLowerCase();
    if (q === "beef" || q === "怒呛人生") return [hit(153312, "tv", "BEEF", "2023")];
    if (q === "另一部剧") return [hit(999, "tv", "另一部剧", "2020")];
    return [];
  }
  async details(kind: "movie" | "tv", id: number): Promise<TmdbDetails | null> {
    if (id === 999 && StubTmdb.gate) await StubTmdb.gate;
    const base = { id, mediaType: kind, enTitle: "", posterUrl: "", imdbId: "", genreIds: [], countries: [], originalLanguage: "", aliases: [] };
    if (id === 153312) return { ...base, title: "怒呛人生", originalTitle: "BEEF", year: "2023", seasons: [{ season: 1, episodeCount: 10 }] };
    if (id === 999) return { ...base, title: "另一部剧", originalTitle: "Other", year: "2020", seasons: [{ season: 1, episodeCount: 5 }, { season: 2, episodeCount: 5 }] };
    return null;
  }
  async season(): Promise<TmdbEpisode[]> {
    return [];
  }
}

let drive: FakeDrive;
let app: FastifyInstance;
let url: string;
let readToken: string;
let runToken: string;
let dailyToken: string;
let fullToken: string;
/** 升级前建的老令牌：日常档，只有同步、转存两组 */
let transferOnlyToken: string;
let session: Record<string, string>;
let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; settings: AppSettings };

const TARGET_E01 = "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv";

/** 一季剧（把握一般）+ 一部认不出的剧；目标位置上已经有一个 E01，撞出一个冲突 */
function seed(): void {
  drive = new FakeDrive("quark", quark, { share: true });
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  drive.tree.addFile("/tv/inbox/Mystery.Show.S01/Mystery.Show.S01E01.mkv");
  drive.tree.addFile(TARGET_E01);
  setDriveProviderFactory((a) => (a.name === "q" ? drive : null));
  fs.rmSync(LOCAL, { recursive: true, force: true });
}

before(async () => {
  baseline = { tasks: listTasks(), accounts: listAccounts(), settings: readAppSettings() };
  replaceAccounts([quark]);
  replaceTasks([tv]);
  replaceAppSettings({
    ...baseline.settings,
    strmExtensions: [".mkv"],
    downloadExtensions: [],
    tmdb: { apiKey: "x", language: "zh-CN" },
    organize: {},
    agent: { enabled: true, uiBaseUrl: "http://nas:3000" },
  });
  setOrganizeDeps({ tmdb: () => new StubTmdb(), notify: async () => true, retryDelayMs: 5 });
  setFollowServiceDeps({ notify: async () => {}, random: () => 0.5, gapMs: 0 });
  await writeAuthPassword("mcp-p3-pw");
  const all = ["sync", "transfer", "organize", "follow", "strm"] as const;
  readToken = createApiToken({ name: "只读", scopes: ["read"], toolsets: [...all], expiresAt: null }).token;
  dailyToken = createApiToken({ name: "日常", scopes: ["read", "run", "write"], toolsets: [...all], expiresAt: null }).token;
  fullToken = createApiToken({ name: "完全", scopes: ["read", "run", "write", "danger"], toolsets: [...all], expiresAt: null }).token;
  runToken = createApiToken({ name: "查看加运行", scopes: ["read", "run"], toolsets: [...all], expiresAt: null }).token;
  transferOnlyToken = createApiToken({ name: "老令牌", scopes: ["read", "run", "write"], toolsets: ["sync", "transfer"], expiresAt: null }).token;

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(mcpRoute);
  await app.register(organizeRoute);
  await app.register(followRoute);
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
  session = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

/** 调 REST：令牌或者会话 */
const rest = (headers: Record<string, string>, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  StubTmdb.gate = null;
  await __test_resetFollows();
  cancelAllRuns();
  __test_resetOrganize();
  __test_resetAutoOrganize();
  __test_resetAgentQuota();
  __test_resetJobs();
  __test_resetTransferCaches();
  seed();
});

after(async () => {
  cancelAllRuns();
  cancelAllRunningTasks();
  await app.close();
  setOrganizeDeps(null);
  await __test_resetFollows();
  setFollowServiceDeps(null);
  setDriveProviderFactory(null);
  __test_resetOrganize();
  __test_resetAutoOrganize();
  __test_resetJobs();
  __test_resetTransferCaches();
  __test_resetAgentQuota();
  deleteAllApiTokens();
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(LOCAL, { recursive: true, force: true });
  await writeAuthPassword(DEFAULT_AUTH.password);
});

interface ConnectOpts {
  modern?: boolean;
  /** 声明 elicitation 并按这个答复确认框；不给就不声明 */
  elicit?: (message: string) => { action: "accept" | "decline" | "cancel"; content?: Record<string, string | number | boolean | string[]> };
}

async function connect(token: string, opts: ConnectOpts = {}): Promise<Client> {
  const client = new Client(
    { name: "mcp-p3", version: "1.0.0" },
    {
      ...(opts.modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}),
      ...(opts.elicit ? { capabilities: { elicitation: {} } } : {}),
    },
  );
  if (opts.elicit) {
    const answer = opts.elicit;
    client.setRequestHandler("elicitation/create", async (request) => answer((request.params as { message: string }).message));
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

/** 调一个工具，把 text 块里的 JSON 解出来 */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const block = (res.content as Array<{ type: string; text?: string }>)[0];
  assert.equal(block?.type, "text", `${name} 没回 text 块`);
  return { isError: res.isError === true, data: JSON.parse(block.text!) as Record<string, any>, size: block.text!.length };
}

/** 清单里按原始名字找单元 */
const unitBySource = (views: Array<Record<string, any>>, needle: string) => views.find((u) => String(u.source).includes(needle));

/* ------------------------------- 整理 ------------------------------- */

test("整理：预览带回清单，要拿主意的在前；改清单编号不变、planVersion 变；旧版本执行被拒；执行、撤销", async () => {
  const client = await connect(dailyToken);
  try {
    const preview = await call(client, "organize_preview", { task: "tv", subPath: "inbox" });
    assert.equal(preview.isError, false, JSON.stringify(preview.data));
    assert.equal(preview.data.state, "ready");
    const runId = preview.data.runId as string;
    const pv1 = preview.data.planVersion as string;
    assert.match(pv1, /^[0-9a-f]{10}$/);
    assert.match(preview.data.confirmText, /115|tv/);
    assert.equal(preview.data.openInUi, `http://nas:3000/organize?run=${runId}`);

    const attention = preview.data.attention as Array<Record<string, any>>;
    const mystery = unitBySource(attention, "Mystery")!;
    const beef = unitBySource(attention, "BEEF")!;
    assert.deepEqual(mystery.why, ["unmatched"]);
    assert.equal(mystery.match, null);
    assert.ok(beef.why.includes("conflict") && beef.why.includes("medium"), JSON.stringify(beef.why));
    assert.equal(beef.match.tmdbId, 153312);
    assert.equal(beef.episodes.files, "S01: E01–E02");
    assert.equal(beef.episodes.tmdb, "S01 共 10 集");
    assert.equal(attention[0].ref, mystery.ref, "认不出的排最前");

    // 单元的文件：冲突的在前，编号是「单元.哈希」
    const files1 = await call(client, "organize_detail", { run: runId, unit: beef.ref });
    const list1 = files1.data.files as Array<Record<string, any>>;
    const conflict = list1.find((f) => f.action === "conflict")!;
    const e02 = list1.find((f) => String(f.from).includes("E02"))!;
    assert.match(conflict.ref, new RegExp(`^${beef.ref}\\.[0-9a-f]{8}$`));
    assert.equal(list1[0].action, "conflict");

    // 改清单：认不出的那部换成手动找到的，冲突统一改名保留
    const search = await call(client, "tmdb_search", { query: "另一部剧", type: "tv" });
    assert.equal(search.data.results[0].tmdbId, 999);
    const byId = await call(client, "tmdb_search", { tmdbId: 999, type: "tv" });
    assert.deepEqual(byId.data.results[0].seasons, [
      { season: 1, episodes: 5 },
      { season: 2, episodes: 5 },
    ]);
    const adjusted = await call(client, "organize_adjust", {
      run: runId,
      conflicts: "rename",
      changes: [{ target: mystery.ref, tmdbId: 999, mediaType: "tv" }],
    });
    assert.equal(adjusted.isError, false, JSON.stringify(adjusted.data));
    assert.equal(adjusted.data.changed, 2);
    const pv2 = adjusted.data.planVersion as string;
    assert.notEqual(pv2, pv1);
    const mysteryAfter = (adjusted.data.units as Array<Record<string, any>>).find((u) => u.ref === mystery.ref)!;
    assert.equal(mysteryAfter.match.tmdbId, 999);
    assert.equal(mysteryAfter.match.reason, "手动指定");
    assert.match(adjusted.data.confirmText, /手动指定 1/);

    // 重规划之后编号还是那些
    const files2 = await call(client, "organize_detail", { run: runId, unit: beef.ref });
    const list2 = files2.data.files as Array<Record<string, any>>;
    assert.ok(list2.some((f) => f.ref === e02.ref));
    const renamed = list2.find((f) => f.ref === conflict.ref)!;
    assert.deepEqual(renamed.resolve, { how: "rename" });
    assert.notEqual(renamed.action, "conflict");

    // 执行：不带版本、带旧版本都被拒
    const noVersion = await call(client, "organize_apply", { run: runId });
    assert.equal(noVersion.data.code, "PLAN_VERSION_REQUIRED");
    const stale = await call(client, "organize_apply", { run: runId, planVersion: pv1 });
    assert.equal(stale.isError, true);
    assert.equal(stale.data.code, "PLAN_CHANGED");
    assert.equal(stale.data.planVersion, pv2);

    const applied = await call(client, "organize_apply", { run: runId, planVersion: pv2 });
    assert.equal(applied.isError, false, JSON.stringify(applied.data));
    await waitForRun(runId);
    const done = await call(client, "organize_status", { run: runId, waitSeconds: 5 });
    assert.equal(done.data.run.status, "done", JSON.stringify(done.data));
    assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv"));
    assert.ok(drive.tree.get(TARGET_E01), "原来那份不动");
    assert.ok(drive.tree.get("/tv/另一部剧 (2020) [tmdbid=999]/Season 01/另一部剧 - S01E01.mkv"));
    assert.equal(done.data.revertable.ok, true);

    const reverted = await call(client, "organize_revert", { run: runId });
    assert.equal(reverted.isError, false, JSON.stringify(reverted.data));
    await waitForRun(runId);
    const back = await call(client, "organize_status", { run: runId });
    assert.equal(back.data.run.status, "reverted", JSON.stringify(back.data));
    assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"));
  } finally {
    await client.close();
  }
});

test("整理：删掉 / 覆盖要 danger 档；执行有删除项的清单要 confirmDelete", async () => {
  const daily = await connect(dailyToken);
  const full = await connect(fullToken);
  try {
    const preview = await call(daily, "organize_preview", { task: "tv", subPath: "inbox" });
    const runId = preview.data.runId as string;
    const beef = unitBySource(preview.data.attention, "BEEF")!;
    const files = await call(daily, "organize_detail", { run: runId, unit: beef.ref });
    const conflict = (files.data.files as Array<Record<string, any>>).find((f) => f.action === "conflict")!;

    const denied = await call(daily, "organize_adjust", { run: runId, changes: [{ target: conflict.ref, resolve: "delete" }] });
    assert.equal(denied.data.code, "INSUFFICIENT_SCOPE");

    const adjusted = await call(full, "organize_adjust", { run: runId, changes: [{ target: conflict.ref, resolve: "delete" }] });
    assert.equal(adjusted.isError, false, JSON.stringify(adjusted.data));
    assert.match(adjusted.data.confirmText, /会删掉 1 个文件/);
    const pv = adjusted.data.planVersion as string;

    const dailyApply = await call(daily, "organize_apply", { run: runId, planVersion: pv });
    assert.equal(dailyApply.data.code, "INSUFFICIENT_SCOPE");
    const noConfirm = await call(full, "organize_apply", { run: runId, planVersion: pv });
    assert.equal(noConfirm.data.code, "CONFIRM_DELETE");
    const ok = await call(full, "organize_apply", { run: runId, planVersion: pv, confirmDelete: 1 });
    assert.equal(ok.isError, false, JSON.stringify(ok.data));
    await waitForRun(runId);
    assert.equal(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), undefined, "选了删掉的那份进了回收站");
  } finally {
    await daily.close();
    await full.close();
  }
});

test("整理：同范围已有待确认的清单不重新预览；fresh 才重来；服务重启后清单改不了、但能执行", async () => {
  const client = await connect(dailyToken);
  try {
    const first = await call(client, "organize_preview", { task: "tv", subPath: "inbox" });
    const runId = first.data.runId as string;
    const again = await call(client, "organize_preview", { task: "tv", subPath: "inbox" });
    assert.equal(again.data.existing, true);
    assert.equal(again.data.runs[0].runId, runId);
    // 整个任务的范围也盖住了它
    const wider = await call(client, "organize_preview", { task: "tv" });
    assert.equal(wider.data.existing, true);

    __test_dropPlanState(runId);
    const status = await call(client, "organize_status", { task: "tv" });
    assert.equal(status.data.run.runId, runId, "只给任务时取要人管的那条");
    assert.equal(status.data.editable, false);
    const adjust = await call(client, "organize_adjust", { run: runId, select: "none" });
    assert.equal(adjust.data.code, "NOT_EDITABLE");
    assert.match(adjust.data.hint, /organize_preview/);

    const fresh = await call(client, "organize_preview", { task: "tv", subPath: "inbox", fresh: true });
    assert.equal(fresh.data.state, "ready");
    assert.notEqual(fresh.data.runId, runId);
    const old = await call(client, "organize_status", { run: runId });
    assert.equal(old.data.run.status, "cancelled", "旧的那份被新预览作废");
  } finally {
    await client.close();
  }
});

test("整理：只读令牌只看得到看的工具；清单输出不超过几 KB；编号大小写都认", async () => {
  const reader = await connect(readToken);
  const daily = await connect(dailyToken);
  try {
    const names = (await reader.listTools()).tools.map((t) => t.name);
    for (const n of ["organize_list", "organize_status", "organize_detail", "tmdb_search"]) assert.ok(names.includes(n), n);
    for (const n of ["organize_preview", "organize_adjust", "organize_apply", "organize_revert", "organize_skip", "organize_cancel"]) assert.ok(!names.includes(n), n);

    const preview = await call(daily, "organize_preview", { task: "tv", subPath: "inbox" });
    const runId = preview.data.runId as string;
    const listed = await call(reader, "organize_list", {});
    assert.equal(listed.data.runs[0].runId, runId);
    assert.equal(listed.data.runs[0].reason, "ready");
    const detail = await call(reader, "organize_detail", { run: runId });
    assert.ok(detail.size < 16 * 1024, `清单 ${detail.size} 字节`);
    const upper = await call(reader, "organize_detail", { run: runId, unit: String(detail.data.attention[0].ref).toUpperCase() });
    assert.equal(upper.isError, false, JSON.stringify(upper.data));
    const bad = await call(reader, "organize_detail", { run: runId, unit: "u99" });
    assert.equal(bad.data.code, "UNIT_NOT_FOUND");
  } finally {
    await reader.close();
    await daily.close();
  }
});

test("整理：转存时要整理，结果里带回清单的 runId", async () => {
  const share = drive.share!.define("abcdef123456", { title: "怒呛人生" });
  share.addFile("/BEEF.S01.2023.1080p/BEEF.S01E03.1080p.WEB-DL.mkv");
  const client = await connect(dailyToken);
  try {
    const saved = await call(client, "share_save", { link: "https://pan.quark.cn/s/abcdef123456", task: "tv", organize: true });
    assert.equal(saved.isError, false, JSON.stringify(saved.data));
    const organize = saved.data.organize as Record<string, any>;
    assert.ok(organize?.runId, JSON.stringify(saved.data));
    assert.equal(organize.openInUi, `http://nas:3000/organize?run=${organize.runId}`);
    const status = await call(client, "organize_status", { run: organize.runId, waitSeconds: 10 });
    assert.equal(status.data.run.status, "ready", JSON.stringify(status.data));
    assert.equal(status.data.run.trigger, "转存");
  } finally {
    await client.close();
  }
});

test("整理：批量「只选把握大的」只动识别出来的单元；改了清单再按旧编号改照样认；参数和目标对不上整批不改", async () => {
  const client = await connect(dailyToken);
  try {
    const preview = await call(client, "organize_preview", { task: "tv", subPath: "inbox" });
    const runId = preview.data.runId as string;
    const beef = unitBySource(preview.data.attention, "BEEF")!;
    const mystery = unitBySource(preview.data.attention, "Mystery")!;

    const confident = await call(client, "organize_adjust", { run: runId, select: "confident" });
    assert.equal(confident.data.changed, 1, JSON.stringify(confident.data));
    assert.equal(confident.data.units[0].ref, beef.ref);
    assert.equal(confident.data.units[0].selected, false, "把握一般的取消勾选");

    const bad = await call(client, "organize_adjust", {
      run: runId,
      changes: [
        { target: beef.ref, selected: true },
        { target: mystery.ref, selected: true },
      ],
    });
    assert.equal(bad.data.code, "VALIDATION", "认不出来的单元不能勾");
    assert.match(bad.data.error, /changes\[1\]/);
    const wrongField = await call(client, "organize_adjust", { run: runId, changes: [{ target: beef.ref, resolve: "rename" }] });
    assert.equal(wrongField.data.code, "VALIDATION");
    const typo = await call(client, "organize_adjust", { run: runId, changes: [{ target: beef.ref, tmdb_id: 1 }] });
    assert.equal(typo.data.code, "VALIDATION", "拼错的字段名直接报错");
    const status = await call(client, "organize_status", { run: runId });
    assert.equal(status.data.planVersion, confident.data.planVersion, "整批拒掉时清单没动");
  } finally {
    await client.close();
  }
});

test("整理：没配 TMDB 时说清楚只能用户去设置页填，别让模型去试", async () => {
  const client = await connect(dailyToken);
  patchAppSettings({ tmdb: { apiKey: "" } });
  try {
    for (const [name, args] of [
      ["tmdb_search", { query: "BEEF" }],
      ["organize_preview", { task: "tv" }],
    ] as const) {
      const r = await call(client, name, args);
      assert.equal(r.data.code, "TMDB_NOT_CONFIGURED", `${name} ${JSON.stringify(r.data)}`);
      assert.match(r.data.hint, /设置页/);
    }
  } finally {
    patchAppSettings({ tmdb: { apiKey: "x", language: "zh-CN" } });
    await client.close();
  }
});

/* ------------------------------- 当面确认 ------------------------------- */

test("当面确认：新协议、声明了 elicitation 的客户端先弹确认框（内容是 confirmText），同意才执行、拒绝不执行", async () => {
  const asked: string[] = [];
  const declining = await connect(dailyToken, { modern: true, elicit: (m) => (asked.push(m), { action: "decline" }) });
  const accepting = await connect(dailyToken, { modern: true, elicit: (m) => (asked.push(m), { action: "accept", content: { confirm: true } }) });
  try {
    const preview = await call(declining, "organize_preview", { task: "tv", subPath: "inbox" });
    const runId = preview.data.runId as string;
    const pv = preview.data.planVersion as string;

    const no = await call(declining, "organize_apply", { run: runId, planVersion: pv });
    assert.equal(no.isError, true);
    assert.equal(no.data.code, "DECLINED");
    assert.equal(asked.length, 1);
    assert.match(asked[0], /执行整理/);
    const still = await call(declining, "organize_status", { run: runId });
    assert.equal(still.data.run.status, "ready", "拒绝了就不执行");

    const yes = await call(accepting, "organize_apply", { run: runId, planVersion: pv });
    assert.equal(yes.isError, false, JSON.stringify(yes.data));
    assert.equal(asked.length, 2);
    await waitForRun(runId);
    const done = await call(accepting, "organize_status", { run: runId });
    assert.equal(done.data.run.status, "done");
  } finally {
    await declining.close();
    await accepting.close();
  }
});

test("当面确认：老协议的客户端声明了 elicitation 也不弹（服务端拿不到能力），照常执行", async () => {
  const asked: string[] = [];
  const legacy = await connect(dailyToken, { elicit: (m) => (asked.push(m), { action: "decline" }) });
  try {
    const preview = await call(legacy, "organize_preview", { task: "tv", subPath: "inbox" });
    const applied = await call(legacy, "organize_apply", { run: preview.data.runId, planVersion: preview.data.planVersion });
    assert.equal(applied.isError, false, JSON.stringify(applied.data));
    assert.equal(asked.length, 0);
    await waitForRun(preview.data.runId);
  } finally {
    await legacy.close();
  }
});

/* ------------------------------- 追更 ------------------------------- */

test("追更：转存时建订阅 → 列表（不带提取码）→ 暂停 / 恢复 → 立即检查转存新增 → 删除要删除档，新协议客户端先确认", async () => {
  const share = drive.share!.define("fol1234567ab", { title: "新剧", password: "abcd" });
  share.addFile("/New.Show.S01E01.mkv");
  const asked: string[] = [];
  const daily = await connect(dailyToken);
  const full = await connect(fullToken, { modern: true, elicit: (m) => (asked.push(m), { action: "accept", content: { confirm: true } }) });
  try {
    const saved = await call(daily, "share_save", { link: "https://pan.quark.cn/s/fol1234567ab?pwd=abcd", task: "tv", subPath: "follow", follow: true });
    assert.equal(saved.data.state, "done", JSON.stringify(saved.data));
    const followId = saved.data.follow.id as string;

    const list = await call(daily, "follow_list", {});
    assert.equal(list.data.total, 1);
    assert.equal(list.data.follows[0].name, "新剧");
    assert.equal(list.data.follows[0].statusText, "正常");
    const one = await call(daily, "follow_list", { follow: "新剧" });
    assert.equal(one.data.follow.link, "https://pan.quark.cn/s/fol1234567ab");
    assert.ok(!JSON.stringify(one.data).includes("abcd"), "提取码不回给模型");

    const paused = await call(daily, "follow_update", { follow: "新剧", enabled: false });
    assert.equal(paused.data.follow.enabled, false);
    const resumed = await call(daily, "follow_update", { follow: followId, enabled: true, intervalMinutes: 60 });
    assert.equal(resumed.data.follow.enabled, true);
    assert.equal(resumed.data.follow.intervalMinutes, 60);
    const empty = await call(daily, "follow_update", { follow: followId });
    assert.equal(empty.data.code, "VALIDATION");

    share.addFile("/New.Show.S01E02.mkv");
    const checked = await call(daily, "follow_check", { follow: followId });
    assert.equal(checked.data.state, "done", JSON.stringify(checked.data));
    assert.equal(checked.data.run.added, 1);
    assert.ok(drive.tree.get("/tv/follow/New.Show.S01E02.mkv"));
    const again = await call(daily, "follow_check", { follow: followId });
    assert.equal(again.data.message, "没有新增。");

    const dailyTools = (await daily.listTools()).tools.map((t) => t.name);
    assert.ok(!dailyTools.includes("follow_delete"), "日常档看不到删除");
    const deleted = await call(full, "follow_delete", { follow: followId });
    assert.equal(deleted.data.deleted, true, JSON.stringify(deleted.data));
    assert.equal(asked.length, 1);
    assert.ok(!asked[0].includes("新剧"), "确认框里不放订阅名（默认就是分享标题）");
    assert.match(asked[0], /转存到「q · tv」下的一个子目录/);
    assert.equal(listFollows().follows.length, 0);
    const gone = await call(daily, "follow_list", { follow: followId });
    assert.equal(gone.data.code, "FOLLOW_NOT_FOUND");
  } finally {
    await daily.close();
    await full.close();
  }
});

/* ------------------------------- strm ------------------------------- */

function writeStrm(rel: string, content: string): void {
  const full = path.join(LOCAL, "tv", ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
const readLocal = (rel: string) => fs.readFileSync(path.join(LOCAL, "tv", ...rel.split("/")), "utf8");
const localExists = (rel: string) => fs.existsSync(path.join(LOCAL, "tv", ...rel.split("/")));

test("strm：找、体检、网盘核对、修正先看后改；删除和重建要删除档", async () => {
  writeStrm("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm", "/mnt/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  writeStrm("inbox/Mystery.Show.S01/Mystery.Show.S01E01.strm", "/old/tv/inbox/Mystery.Show.S01/Mystery.Show.S01E01.mkv");
  writeStrm("inbox/Gone/Gone.S01E01.strm", "/mnt/tv/inbox/Gone/Gone.S01E01.mkv");
  const daily = await connect(dailyToken);
  const full = await connect(fullToken);
  try {
    const found = await call(daily, "strm_search", { task: "tv", query: "beef.s01e01" });
    const hit = (found.data.hits as Array<Record<string, any>>).find((h) => h.kind === "strm")!;
    assert.equal(hit.matches, true, JSON.stringify(found.data));
    assert.match(hit.remotePath, /BEEF\.S01E01/);

    const check = await call(daily, "strm_check", { task: "tv" });
    assert.equal(check.data.state, "done", JSON.stringify(check.data));
    const types = (check.data.problems as Array<{ type: string }>).map((p) => p.type);
    assert.ok(types.includes("stale-content"), JSON.stringify(check.data.problems));

    const verify = await call(daily, "strm_verify", { task: "tv" });
    assert.equal(verify.data.state, "done", JSON.stringify(verify.data));
    assert.equal(verify.data.missing, 1);
    assert.match(verify.data.missingSample[0].path, /Gone/);

    const dry = await call(daily, "strm_fix", { task: "tv" });
    assert.equal(dry.data.dryRun, true);
    assert.equal(dry.data.wouldChange, 1);
    assert.match(readLocal("inbox/Mystery.Show.S01/Mystery.Show.S01E01.strm"), /^\/old/, "dryRun 不改");
    const fixed = await call(daily, "strm_fix", { task: "tv", dryRun: false });
    assert.equal(fixed.data.changed, 1);
    assert.equal(readLocal("inbox/Mystery.Show.S01/Mystery.Show.S01E01.strm"), "/mnt/tv/inbox/Mystery.Show.S01/Mystery.Show.S01E01.mkv");

    const dailyTools = (await daily.listTools()).tools.map((t) => t.name);
    assert.ok(!dailyTools.includes("strm_delete") && !dailyTools.includes("strm_rebuild"));
    const root = await call(full, "strm_delete", { task: "tv", paths: ["/"] });
    assert.equal(root.data.code, "VALIDATION");
    const del = await call(full, "strm_delete", { task: "tv", paths: ["inbox/Gone"] });
    assert.equal(del.data.deleted, 1, JSON.stringify(del.data));
    assert.ok(!localExists("inbox/Gone"));

    const wholeTask = await call(full, "strm_rebuild", { task: "tv", path: "/" });
    assert.equal(wholeTask.data.code, "VALIDATION");
    writeStrm("inbox/BEEF.S01.1080p/Extra.strm", "/mnt/tv/inbox/BEEF.S01.1080p/Extra.mkv");
    const rebuilt = await call(full, "strm_rebuild", { task: "tv", path: "inbox/BEEF.S01.1080p" });
    assert.equal(rebuilt.data.state, "done", JSON.stringify(rebuilt.data));
    assert.equal(rebuilt.data.removed, 1);
    assert.ok(localExists("inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.strm"), "网盘上有的补齐");
    assert.ok(!localExists("inbox/BEEF.S01.1080p/Extra.strm"), "本地多出来的删掉");
  } finally {
    await daily.close();
    await full.close();
  }
});

/* ------------------------------- 评审修补（2026-09-23） ------------------------------- */

/** 预览 inbox，拿到 runId 和两个单元（BEEF 有一个冲突） */
async function previewInbox(client: Client) {
  const preview = await call(client, "organize_preview", { task: "tv", subPath: "inbox" });
  assert.equal(preview.data.state, "ready", JSON.stringify(preview.data));
  const runId = preview.data.runId as string;
  const beef = unitBySource(preview.data.attention, "BEEF")!;
  const mystery = unitBySource(preview.data.attention, "Mystery")!;
  const files = await call(client, "organize_detail", { run: runId, unit: beef.ref });
  const conflict = (files.data.files as Array<Record<string, any>>).find((f) => f.action === "conflict")!;
  return { runId, planVersion: preview.data.planVersion as string, beef, mystery, conflict };
}

test("修补：界面上执行带着打开时的 planVersion，之后被智能体改过就不执行；令牌走 REST 执行待确认的清单必须带版本", async () => {
  const client = await connect(dailyToken);
  try {
    const { runId, planVersion } = await previewInbox(client);
    const detail = (await rest(session, "GET", `/api/organize/runs/${runId}`)).json();
    assert.equal(detail.planVersion, planVersion, "详情里带着同一个指纹");
    await call(client, "organize_adjust", { run: runId, conflicts: "rename" });
    const stale = await rest(session, "POST", `/api/organize/runs/${runId}/apply`, { planVersion });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().code, "PLAN_CHANGED");
    const noVersion = await rest(bearer(dailyToken), "POST", `/api/organize/runs/${runId}/apply`, {});
    assert.equal(noVersion.json().code, "PLAN_VERSION_REQUIRED");
    const fresh = (await rest(session, "GET", `/api/organize/runs/${runId}`)).json().planVersion as string;
    assert.equal((await rest(session, "POST", `/api/organize/runs/${runId}/apply`, { planVersion: fresh })).statusCode, 200);
    await waitForRun(runId);
  } finally {
    await client.close();
  }
});

test("修补：重新勾上一个冲突选过「删掉」的单元等于重新安排删除，没有删除档的令牌不行（工具和 REST 一样）", async () => {
  const full = await connect(fullToken);
  const daily = await connect(dailyToken);
  try {
    const { runId, beef, conflict } = await previewInbox(full);
    assert.equal((await call(full, "organize_adjust", { run: runId, changes: [{ target: conflict.ref, resolve: "delete" }] })).isError, false);
    const off = await call(daily, "organize_adjust", { run: runId, changes: [{ target: beef.ref, selected: false }] });
    assert.equal(off.isError, false, "取消勾选谁都能做");
    for (const args of [{ select: "all" }, { changes: [{ target: beef.ref, selected: true }] }]) {
      const r = await call(daily, "organize_adjust", { run: runId, ...args });
      assert.equal(r.data.code, "INSUFFICIENT_SCOPE", JSON.stringify(r.data));
    }
    const beefKey = (await rest(session, "GET", `/api/organize/runs/${runId}`)).json().units.find((u: { rawName: string }) => u.rawName.includes("BEEF")).key;
    const viaRest = await rest(bearer(dailyToken), "PUT", `/api/organize/runs/${runId}/units`, { keys: [beefKey], selected: true });
    assert.equal(viaRest.statusCode, 403);
    assert.equal(viaRest.json().required, "danger");
    const ok = await call(full, "organize_adjust", { run: runId, select: "all" });
    assert.equal(ok.isError, false, JSON.stringify(ok.data));
    assert.match(ok.data.confirmText, /会删掉 1 个文件/);
  } finally {
    await full.close();
    await daily.close();
  }
});

test("修补：批量「冲突统一改名保留」按落库那一刻定——等 TMDB 的时候用户在界面上取消勾选的冲突不会被改回去", async () => {
  const client = await connect(dailyToken);
  try {
    const { runId, mystery } = await previewInbox(client);
    let release!: () => void;
    StubTmdb.gate = new Promise((r) => (release = r));
    const adjusting = call(client, "organize_adjust", { run: runId, conflicts: "rename", changes: [{ target: mystery.ref, tmdbId: 999, mediaType: "tv" }] });
    await new Promise((r) => setTimeout(r, 50));
    // 这时候智能体还卡在 TMDB 上：用户在界面上把那个冲突文件取消勾选
    const units = (await rest(session, "GET", `/api/organize/runs/${runId}`)).json().units as Array<{ key: string; rawName: string }>;
    const beefKey = units.find((u) => u.rawName.includes("BEEF"))!.key;
    const items = (await rest(session, "GET", `/api/organize/runs/${runId}/items?unit=${encodeURIComponent(beefKey)}`)).json().items as Array<{ id: string; action: string }>;
    const uiId = items.find((i) => i.action === "conflict")!.id;
    assert.equal((await rest(session, "PUT", `/api/organize/runs/${runId}/items`, { ids: [uiId], selected: false })).statusCode, 200);
    release();
    const adjusted = await adjusting;
    assert.equal(adjusted.isError, false, JSON.stringify(adjusted.data));
    const beef = (await rest(session, "GET", `/api/organize/runs/${runId}`)).json().units.find((u: { key: string }) => u.key === beefKey);
    assert.equal(beef.resolutions[`/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv`], undefined, "用户取消勾选的冲突没被批量改名盖回去");
    assert.ok(beef.excluded.includes("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"));
  } finally {
    StubTmdb.gate = null;
    await client.close();
  }
});

test("修补：同一个字幕挂在两个单元下（Alien / Aliens），按文件取消勾选落在点的那个单元上（界面和智能体都是）", async () => {
  drive.tree.addFile("/tv/pair/Alien.mkv");
  drive.tree.addFile("/tv/pair/Aliens.mkv");
  drive.tree.addFile("/tv/pair/Aliens.chs.srt");
  const client = await connect(dailyToken);
  try {
    const preview = await call(client, "organize_preview", { task: "tv", subPath: "pair" });
    const runId = preview.data.runId as string;
    const units = (await rest(session, "GET", `/api/organize/runs/${runId}`)).json().units as Array<{ key: string; rawName: string; excluded: string[] }>;
    const srt = "/tv/pair/Aliens.chs.srt";
    const holders: string[] = [];
    for (const u of units) {
      const items = (await rest(session, "GET", `/api/organize/runs/${runId}/items?unit=${encodeURIComponent(u.key)}`)).json().items as Array<{ id: string; srcPath: string }>;
      if (items.some((i) => i.srcPath === srt)) holders.push(u.key);
    }
    assert.equal(holders.length, 2, `字幕按名字前缀跟到了两个单元：${JSON.stringify(units.map((u) => u.rawName))}`);
    const [first, second] = holders;
    const secondItems = (await rest(session, "GET", `/api/organize/runs/${runId}/items?unit=${encodeURIComponent(second)}`)).json().items as Array<{ id: string; srcPath: string }>;
    const id = secondItems.find((i) => i.srcPath === srt)!.id;
    assert.equal((await rest(session, "PUT", `/api/organize/runs/${runId}/items`, { ids: [id], selected: false })).json().changed, 1);
    const after = (await rest(session, "GET", `/api/organize/runs/${runId}`)).json().units as Array<{ key: string; excluded: string[] }>;
    assert.ok(after.find((u) => u.key === second)!.excluded.includes(srt), "点的那个单元记下了");
    assert.ok(!after.find((u) => u.key === first)!.excluded.includes(srt), "另一个单元不受影响");

    // 智能体按编号改：编号带着单元，落在对应的那个单元上（单元编号就是详情里单元的顺序）
    const firstRef = `u${units.findIndex((u) => u.key === first) + 1}`;
    const firstFiles = await call(client, "organize_detail", { run: runId, unit: firstRef });
    const srtRef = (firstFiles.data.files as Array<Record<string, any>>).find((f) => String(f.from).endsWith("Aliens.chs.srt"))!.ref;
    assert.equal((await call(client, "organize_adjust", { run: runId, changes: [{ target: srtRef, selected: false }] })).data.changed, 1);
    const final = (await rest(session, "GET", `/api/organize/runs/${runId}`)).json().units as Array<{ key: string; excluded: string[] }>;
    assert.ok(final.find((u) => u.key === first)!.excluded.includes(srt));
  } finally {
    await client.close();
  }
});

test("修补：执行过的整理再拿着 planVersion 来不会悄悄变成重试；要重试得说 retry，没东西可重试也不当错误", async () => {
  const client = await connect(dailyToken);
  try {
    const { runId, planVersion } = await previewInbox(client);
    assert.equal((await call(client, "organize_apply", { run: runId, planVersion })).isError, false);
    await waitForRun(runId);
    const again = await call(client, "organize_apply", { run: runId, planVersion });
    assert.equal(again.isError, false, JSON.stringify(again.data));
    assert.match(again.data.message, /已经不是待确认的了/);
    assert.equal(again.data.run.status, "done");
    const retry = await call(client, "organize_apply", { run: runId, retry: true });
    assert.equal(retry.isError, false);
    assert.match(retry.data.message, /没有要重试的项/);
  } finally {
    await client.close();
  }
});

test("修补：作废待确认的清单要明说、要改网盘档；重新预览要作废现有清单也一样；令牌走 REST 同样拦下", async () => {
  const run = await connect(runToken);
  const daily = await connect(dailyToken);
  try {
    const { runId } = await previewInbox(daily);
    assert.equal((await call(run, "organize_cancel", { run: runId })).data.code, "DISCARD_REQUIRED");
    assert.equal((await call(run, "organize_cancel", { run: runId, discard: true })).data.code, "INSUFFICIENT_SCOPE");
    assert.equal((await call(run, "organize_preview", { task: "tv", subPath: "inbox", fresh: true })).data.code, "INSUFFICIENT_SCOPE");

    const blocked = await rest(bearer(dailyToken), "POST", "/api/organize/runs", { taskId: tv.id, subPath: "inbox" });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().code, "READY_PLANS_EXIST");
    assert.deepEqual(blocked.json().runs, [runId]);
    assert.equal((await rest(bearer(runToken), "POST", "/api/organize/runs", { taskId: tv.id, subPath: "inbox", fresh: true })).statusCode, 403);
    assert.equal((await rest(bearer(runToken), "POST", `/api/organize/runs/${runId}/cancel`)).statusCode, 403);
    const tooMany = await rest(bearer(dailyToken), "POST", "/api/organize/runs", { taskId: tv.id, paths: Array.from({ length: 51 }, (_, i) => `d${i}`) });
    assert.equal(tooMany.statusCode, 400);

    const discarded = await call(daily, "organize_cancel", { run: runId, discard: true });
    assert.equal(discarded.isError, false, JSON.stringify(discarded.data));
    assert.equal(discarded.data.run.status, "cancelled");
  } finally {
    await run.close();
    await daily.close();
  }
});

test("修补：「覆盖」带出来的删除项不给编号，说清怎么撤回；对象数组里写成 null 的字段当没填", async () => {
  const client = await connect(fullToken);
  try {
    const { runId, beef, conflict } = await previewInbox(client);
    const nulls = await call(client, "organize_adjust", {
      run: runId,
      changes: [{ target: conflict.ref, resolve: "replace", selected: null, newName: null, tmdbId: null, mediaType: null, season: null, episodeOffset: null, remember: null }],
    });
    assert.equal(nulls.isError, false, JSON.stringify(nulls.data));
    const files = await call(client, "organize_detail", { run: runId, unit: beef.ref });
    const del = (files.data.files as Array<Record<string, any>>).find((f) => f.action === "delete")!;
    assert.equal(del.ref, undefined);
    assert.match(del.note, /要撤回就把选了覆盖的那一项/);
  } finally {
    await client.close();
  }
});

test("修补：没开「整理」组的老令牌转存后整理，下一步是请用户去整理页确认，不指向调不了的工具", async () => {
  const share = drive.share!.define("old123456789", { title: "老令牌" });
  share.addFile("/BEEF.S01.2023.1080p/BEEF.S01E04.1080p.WEB-DL.mkv");
  const client = await connect(transferOnlyToken);
  try {
    const saved = await call(client, "share_save", { link: "https://pan.quark.cn/s/old123456789", task: "tv", organize: true });
    assert.equal(saved.isError, false, JSON.stringify(saved.data));
    assert.match(saved.data.organize.next, /「整理」页确认/);
    assert.ok(!String(saved.data.organize.next).includes("organize_status"));
  } finally {
    await client.close();
  }
});

test("修补：追更——立即检查要改网盘档、暂停着的不查；令牌不能建订阅、不能改转存目标；列表不带提取码", async () => {
  const share = drive.share!.define("pau1234567ab", { title: "暂停剧", password: "wxyz" });
  share.addFile("/P.S01E01.mkv");
  const daily = await connect(dailyToken);
  const run = await connect(runToken);
  try {
    const saved = await call(daily, "share_save", { link: "https://pan.quark.cn/s/pau1234567ab?pwd=wxyz", task: "tv", subPath: "pause", follow: true });
    const id = saved.data.follow.id as string;
    assert.ok(!(await run.listTools()).tools.some((t) => t.name === "follow_check"), "查看加运行的令牌看不到立即检查");

    await call(daily, "follow_update", { follow: id, enabled: false });
    share.addFile("/P.S01E02.mkv");
    assert.equal((await call(daily, "follow_check", { follow: id })).data.code, "FOLLOW_PAUSED");
    const restCheck = await rest(bearer(dailyToken), "POST", `/api/follow/${id}/check`);
    assert.equal(restCheck.statusCode, 409);
    assert.equal(restCheck.json().code, "FOLLOW_PAUSED");
    assert.equal(drive.tree.get("/tv/pause/P.S01E02.mkv"), undefined, "暂停着就没转存");

    assert.equal((await rest(bearer(dailyToken), "POST", "/api/follow", { shareUrl: "https://pan.quark.cn/s/pau1234567ab", taskId: tv.id })).statusCode, 403);
    const retarget = await rest(bearer(dailyToken), "PUT", `/api/follow/${id}`, { taskId: tv.id, subPath: "elsewhere" });
    assert.equal(retarget.statusCode, 403);
    assert.equal(retarget.json().code, "FIELD_NOT_ALLOWED");
    assert.equal((await rest(bearer(dailyToken), "PUT", `/api/follow/${id}`, { enabled: true })).statusCode, 200);

    const listed = await rest(bearer(readToken), "GET", "/api/follow");
    assert.equal(listed.statusCode, 200);
    assert.ok(!listed.body.includes("wxyz"), "给令牌的列表不带提取码");
    assert.ok((await rest(session, "GET", "/api/follow")).body.includes("wxyz"), "管理界面照旧看得到");
  } finally {
    await daily.close();
    await run.close();
  }
});

test("修补：strm 路径每段原样保留（目录名后面带空格的也找得到、删得准）；确认框里只有数量不带名字", async () => {
  writeStrm("凡人修仙传/Season 1 /E01.strm", "/mnt/tv/凡人修仙传/Season 1 /E01.mkv");
  writeStrm("凡人修仙传/Season 1 /E02.strm", "/mnt/tv/凡人修仙传/Season 1 /E02.mkv");
  writeStrm("凡人修仙传/Season 1/别删我.strm", "/mnt/tv/凡人修仙传/Season 1/别删我.mkv");
  const asked: string[] = [];
  const full = await connect(fullToken, { modern: true, elicit: (m) => (asked.push(m), { action: "accept", content: { confirm: true } }) });
  try {
    const check = await call(full, "strm_check", { task: "tv", path: "凡人修仙传/Season 1 " });
    assert.equal(check.data.strm, 2, JSON.stringify(check.data));
    const del = await call(full, "strm_delete", { task: "tv", paths: ["凡人修仙传/Season 1 "] });
    assert.equal(del.data.deleted, 1, JSON.stringify(del.data));
    assert.ok(!localExists("凡人修仙传/Season 1 "));
    assert.ok(localExists("凡人修仙传/Season 1/别删我.strm"), "名字只差一个空格的那个目录没被删");
    assert.equal(asked.length, 1);
    assert.match(asked[0], /1 个目录；一共会删掉 2 个 strm/);
    assert.ok(!asked[0].includes("凡人修仙传"), asked[0]);
  } finally {
    await full.close();
  }
});

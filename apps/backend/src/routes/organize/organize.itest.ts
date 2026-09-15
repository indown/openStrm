/**
 * 整理路由的闭环：鉴权、校验、建 run / 看详情 / 改单元 / 执行 / 撤销 / 删除、模板试算、识别记忆。
 * 网盘换成内存假网盘，TMDB 换成桩。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/organize/organize.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, AppSettings, OrganizeItem, OrganizeRun, OrganizeRunDetail, OrganizeRunSummary, OrganizeTemplatePreview, OrganizeUnit, TaskDefinition } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import organizeRoute from "./index.js";
import settingsRoute from "../settings/index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { __test_resetOrganize, rememberMatch } from "../../db/repositories/organize.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../../services/drive/registry.js";
import type { TmdbDetails, TmdbEpisode, TmdbSearchResult } from "../../services/tmdb.js";
import type { TmdbApi } from "../../services/organize/identify.js";
import { setOrganizeDeps, waitForRun } from "../../services/organize/run.js";
import { FakeDrive } from "../../test/fake-drive.js";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; settings: AppSettings };
const account: AccountInfo = { accountType: "quark", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "quark", originPath: "movies", targetPath: "organize-route-itest/movies", strmPrefix: "/mnt" };
const drive = new FakeDrive("quark", account);

class StubTmdb implements TmdbApi {
  async search(query: string): Promise<TmdbSearchResult[]> {
    return query.toLowerCase() === "dune part two" ? [{ id: 693134, mediaType: "movie", title: "沙丘：第二部", year: "2024", posterUrl: "", overview: "" }] : [];
  }
  async details(kind: "movie" | "tv", id: number): Promise<TmdbDetails | null> {
    const base = { id, mediaType: kind, enTitle: "", posterUrl: "", imdbId: "", genreIds: [], countries: [], originalLanguage: "", aliases: [] };
    if (id === 693134) return { ...base, title: "沙丘：第二部", originalTitle: "Dune: Part Two", year: "2024" };
    if (id === 438631) return { ...base, title: "沙丘", originalTitle: "Dune", year: "2021" };
    return null;
  }
  async season(): Promise<TmdbEpisode[]> {
    return [];
  }
}

const json = async <T,>(method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>, expect = 200): Promise<T> => {
  const res = await app.inject({ method, url, headers: auth, ...(payload !== undefined ? { payload } : {}) });
  assert.equal(res.statusCode, expect, `${method} ${url} → ${res.statusCode} ${res.body}`);
  return res.json() as T;
};

async function untilStatus(id: string, statuses: OrganizeRun["status"][]): Promise<OrganizeRunDetail> {
  for (let i = 0; i < 200; i++) {
    await waitForRun(id);
    const d = await json<OrganizeRunDetail>("GET", `/api/organize/runs/${id}`);
    if (statuses.includes(d.run.status)) return d;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("run 没有到预期状态");
}

before(async () => {
  baseline = { tasks: listTasks(), accounts: listAccounts(), settings: readAppSettings() };
  replaceTasks([task]);
  replaceAccounts([account]);
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"], downloadExtensions: [], tmdb: { apiKey: "x" }, organize: {} });
  await writeAuthPassword("organize-itest-pw");
  drive.tree.addFile("/movies/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv");
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
  setOrganizeDeps({ tmdb: () => new StubTmdb(), notify: async () => true, retryDelayMs: 5 });

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(organizeRoute);
  await app.register(settingsRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  setOrganizeDeps(null);
  setDriveProviderFactory(null);
  __test_resetOrganize();
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(path.join(DATA_DIR, "organize-route-itest"), { recursive: true, force: true });
});

test("没带 token 一律 401；坏输入 400", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/organize/runs" })).statusCode, 401);
  const bad = await app.inject({ method: "POST", url: "/api/organize/runs", headers: auth, payload: {} });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, "VALIDATION");
  const missing = await app.inject({ method: "POST", url: "/api/organize/runs", headers: auth, payload: { taskId: "nope" } });
  assert.equal(missing.statusCode, 404);
});

test("建 run → 详情 → 改匹配 → 执行 → 撤销 → 删除", async () => {
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "inbox" }, 201);
  assert.equal(run.status, "planning");
  const ready = await untilStatus(run.id, ["ready"]);
  assert.equal(ready.units.length, 1);
  assert.equal(ready.units[0].match?.tmdbId, 693134);
  assert.equal(ready.revertable.ok, false);
  assert.equal(ready.editable, true);

  const list = await json<{ runs: OrganizeRun[] }>("GET", "/api/organize/runs?taskId=t1");
  assert.equal(list.runs.length, 1);

  const unit = await json<OrganizeUnit>("PUT", `/api/organize/runs/${run.id}/unit`, { key: ready.units[0].key, match: { mediaType: "movie", tmdbId: 438631 }, remember: true });
  assert.equal(unit.match?.title, "沙丘");
  assert.equal(unit.dstRoot, "沙丘 (2021) [tmdbid=438631]");

  const applying = await json<OrganizeRun>("POST", `/api/organize/runs/${run.id}/apply`);
  assert.equal(applying.status, "applying");
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.run.stats.failed, 0);
  assert.ok(drive.tree.get("/movies/沙丘 (2021) [tmdbid=438631]/沙丘 (2021) - 2160p.mkv"));
  assert.equal(done.revertable.ok, true);
  // 记住了：记忆接口能看到、能删
  const matches = await json<{ matches: Array<{ srcPath: string }> }>("GET", "/api/organize/matches?account=acc");
  assert.equal(matches.matches.length, 1);
  assert.equal(matches.matches[0].srcPath, "/movies/沙丘 (2021) [tmdbid=438631]");

  // 正在进行中不能再建
  await json("POST", `/api/organize/runs/${run.id}/revert`);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.run.status, "reverted");
  assert.ok(drive.tree.get("/movies/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"));

  await json("DELETE", `/api/organize/runs/${run.id}`);
  await json("GET", `/api/organize/runs/${run.id}`, undefined, 404);
  await json("DELETE", "/api/organize/matches", { accountName: "acc", srcPath: "/movies/沙丘 (2021) [tmdbid=438631]" });
  assert.equal((await json<{ matches: unknown[] }>("GET", "/api/organize/matches")).matches.length, 0);
});

test("失败项：执行带 ids 只重试点名的；放弃接口标掉失败项；详情里有 applicable", async () => {
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("沙丘：第二部 (2024) - 2160p.mkv") ? new Error("改不了") : null);
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "inbox" }, 201);
  await untilStatus(run.id, ["ready"]);
  await json("POST", `/api/organize/runs/${run.id}/apply`);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.run.stats.failed, 1);
  assert.equal(done.run.stats.failedByKind.transient, 1);
  assert.equal(done.applicable.ok, true);
  assert.equal(done.applicable.count, 1);
  const bad = (await json<{ items: OrganizeItem[] }>("GET", `/api/organize/runs/${run.id}/items?group=transient`)).items[0];
  assert.equal(bad.status, "failed");
  assert.equal(bad.errorKind, "transient");
  assert.equal(bad.attempts, 1);
  // 入参校验
  assert.equal((await app.inject({ method: "POST", url: `/api/organize/runs/${run.id}/skip`, headers: auth, payload: { ids: [] } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: `/api/organize/runs/${run.id}/apply`, headers: auth, payload: { ids: "x" } })).statusCode, 400);
  // 点名重试：这次成功
  drive.failWriteOn = null;
  await json("POST", `/api/organize/runs/${run.id}/apply`, { ids: [bad.id] });
  const again = await untilStatus(run.id, ["done"]);
  assert.equal(again.run.stats.failed, 0);
  assert.equal(again.applicable.ok, false);
  assert.ok(drive.tree.get("/movies/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv"));
  // 放弃：没有失败项时全是 refused
  const r = await json<{ skipped: number; refused: unknown[] }>("POST", `/api/organize/runs/${run.id}/skip`, { ids: [bad.id] });
  assert.equal(r.skipped, 0);
  assert.equal(r.refused.length, 1);
  await json("POST", `/api/organize/runs/${run.id}/revert`);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.run.stage, "revert");
  assert.equal(reverted.applicable.ok, false);
  assert.equal((await app.inject({ method: "POST", url: `/api/organize/runs/${run.id}/apply`, headers: auth })).statusCode, 409);
  await json("DELETE", `/api/organize/runs/${run.id}`);
});

test("重新预览：按原范围建一个新的手动预览（201）；没有的 run 404", async () => {
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "inbox" }, 201);
  await untilStatus(run.id, ["ready"]);
  const again = await json<OrganizeRun>("POST", `/api/organize/runs/${run.id}/repreview`, undefined, 201);
  assert.notEqual(again.id, run.id);
  assert.deepEqual([again.scopePath, again.mode, again.trigger], ["inbox", "manual", "manual"]);
  await untilStatus(again.id, ["ready"]);
  await json("POST", "/api/organize/runs/nope/repreview", undefined, 404);
  await json("DELETE", `/api/organize/runs/${run.id}`);
  await json("DELETE", `/api/organize/runs/${again.id}`);
});

test("待处理接口：要鉴权，返回 runs 数组，每条带原因、不带日志", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/organize/attention" })).statusCode, 401);
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "inbox" }, 201);
  await untilStatus(run.id, ["ready"]);
  const r = await json<{ runs: Array<{ run: OrganizeRun; reason: string }> }>("GET", "/api/organize/attention");
  const mine = r.runs.find((a) => a.run.id === run.id);
  assert.equal(mine?.reason, "ready");
  assert.deepEqual(mine?.run.log, []);
  await json("DELETE", `/api/organize/runs/${run.id}`);
});

test("详情不带项、带按单元的计数；summary 只有 run 和开关；items 按单元 / 分组按需拉，参数都没给 400", async () => {
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "inbox" }, 201);
  const d = await untilStatus(run.id, ["ready"]);
  assert.equal((d as unknown as { items?: unknown }).items, undefined, "详情不再带全部项");
  const key = d.units[0].key;
  assert.equal(d.counts[key].changing, 1);
  assert.ok(d.dirCount >= 1, "建作品目录那一项");
  const s = await json<OrganizeRunSummary>("GET", `/api/organize/runs/${run.id}/summary`);
  assert.equal(s.run.id, run.id);
  assert.equal((s as unknown as { units?: unknown }).units, undefined);
  const mine = await json<{ items: OrganizeItem[] }>("GET", `/api/organize/runs/${run.id}/items?unit=${encodeURIComponent(key)}`);
  assert.ok(mine.items.length > 0 && mine.items.every((i) => i.unitKey === key));
  const dirs = await json<{ items: OrganizeItem[] }>("GET", `/api/organize/runs/${run.id}/items?unit=`);
  assert.equal(dirs.items.length, d.dirCount);
  assert.equal((await app.inject({ method: "GET", url: `/api/organize/runs/${run.id}/items`, headers: auth })).statusCode, 400);
  await json("GET", `/api/organize/runs/nope/items?unit=`, undefined, 404);
  await json("DELETE", `/api/organize/runs/${run.id}`);
});

test("批量勾选单元、按文件勾选、TMDB 搜索 / 按编号查；参数不对 400", async () => {
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "inbox" }, 201);
  const d = await untilStatus(run.id, ["ready"]);
  const key = d.units[0].key;
  assert.equal((await json<{ changed: number }>("PUT", `/api/organize/runs/${run.id}/units`, { keys: [key], selected: false })).changed, 1);
  assert.equal((await app.inject({ method: "PUT", url: `/api/organize/runs/${run.id}/units`, headers: auth, payload: { keys: [key] } })).statusCode, 400);
  await json("PUT", `/api/organize/runs/${run.id}/units`, { keys: [key], selected: true });
  const items = (await json<{ items: OrganizeItem[] }>("GET", `/api/organize/runs/${run.id}/items?unit=${encodeURIComponent(key)}`)).items;
  const video = items.find((i) => i.kind === "video")!;
  assert.equal((await json<{ changed: number }>("PUT", `/api/organize/runs/${run.id}/items`, { ids: [video.id], selected: false })).changed, 1);
  assert.equal((await json<OrganizeRunDetail>("GET", `/api/organize/runs/${run.id}`)).counts[key].excluded, 1);
  assert.equal((await app.inject({ method: "PUT", url: `/api/organize/runs/${run.id}/items`, headers: auth, payload: { ids: [], selected: true } })).statusCode, 400);
  const s = await json<{ results: Array<{ tmdbId: number }> }>("POST", "/api/organize/tmdb/search", { query: "dune part two", type: "movie", year: "2024" });
  assert.equal(s.results[0].tmdbId, 693134);
  assert.equal((await app.inject({ method: "POST", url: "/api/organize/tmdb/search", headers: auth, payload: { query: "x", year: "24" } })).statusCode, 400);
  assert.equal((await json<{ title: string }>("GET", "/api/organize/tmdb/movie/438631")).title, "沙丘");
  await json("GET", "/api/organize/tmdb/tv/1", undefined, 404);
  await json("DELETE", `/api/organize/runs/${run.id}`);
});

test("模板试算：默认模板出样例；坏模板报错但不抛", async () => {
  const ok = await json<OrganizeTemplatePreview>("POST", "/api/organize/preview-name", {});
  assert.equal(ok.movie, "沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv");
  assert.equal(ok.tv, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.deepEqual(ok.errors, []);
  const plex = await json<OrganizeTemplatePreview>("POST", "/api/organize/preview-name", { idTag: "plex", episodeTitle: true, templates: { tv: "{title}/S{season00}E{episode00}[ - {episodeTitle}].{ext}" } });
  assert.equal(plex.movie, "沙丘：第二部 (2024) {tmdb-693134}/沙丘：第二部 (2024) - 2160p.mkv");
  assert.equal(plex.tv, "怒呛人生/S01E01 - 飞鸟不鸣.mkv");
  const bad = await json<OrganizeTemplatePreview>("POST", "/api/organize/preview-name", { templates: { movie: "{titel}.{ext}" }, rules: ["a <> b >> 1"] });
  assert.equal(bad.errors.length, 2);
});

test("设置：坏模板 / 坏识别词存不进去；好的存得进去", async () => {
  const bad = await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { organize: { templates: { movie: "{title}" } } } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /ext/);
  const badRule = await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { organize: { rules: ["x <> y >> nope"] } } });
  assert.equal(badRule.statusCode, 400);
  await json("PUT", "/api/settings", { organize: { idTag: "jellyfin", rules: ["高清剧集"], auto: "review" } });
  assert.equal(readAppSettings().organize?.idTag, "jellyfin");
  rememberMatch({ accountName: "acc", srcPath: "/x", mediaType: "tv", tmdbId: 1, title: "", year: "", season: null, episodeOffset: 0 });
});

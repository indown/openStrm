/**
 * 整理的闭环：假网盘（test/fake-drive.ts）+ TMDB 桩，预览 → 改匹配 → 执行 → 本地镜像 → 撤销，
 * 以及冲突、单项失败、风控中止、自动模式、115 式（没有 walkSubtree）的懒解析 id。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/run.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, OrganizeRun, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { __test_resetOrganize, bumpOwnHit, findOwnOperation, listItems, listUnits, recallMatch, rememberMatch, replaceItems, updateItem, updateRun } from "../../db/repositories/organize.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { getShareFollow, insertShareFollow, replaceShareFollows } from "../../db/repositories/share-follows.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../drive/registry.js";
import type { DriveProvider } from "../drive/types.js";
import { FakeDrive } from "../../test/fake-drive.js";
import type { TmdbDetails, TmdbEpisode, TmdbSearchResult } from "../tmdb.js";
import type { NotifyEvent } from "../telegram/notify.js";
import type { TmdbApi } from "./identify.js";
import { applyRun, cancelRun, createRun, getRunDetail, patchUnit, reconcileInterruptedRuns, revertRun, setOrganizeDeps, skipItems, waitForRun } from "./run.js";

const account: AccountInfo = { accountType: "quark", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "quark", originPath: "tv", targetPath: "organize-itest/tv", strmPrefix: "/mnt" };
const LOCAL = path.join(DATA_DIR, "organize-itest", "tv");

let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; settings: AppSettings };
let drive: FakeDrive;
let notified: NotifyEvent[] = [];

const hit = (id: number, mediaType: "movie" | "tv", title: string, year: string): TmdbSearchResult => ({ id, mediaType, title, year, posterUrl: "", overview: "" });
class StubTmdb implements TmdbApi {
  async search(query: string): Promise<TmdbSearchResult[]> {
    const q = query.toLowerCase();
    if (q === "beef" || q === "怒呛人生") return [hit(153312, "tv", "BEEF", "2023")];
    if (q === "dune part two" || q === "沙丘：第二部") return [hit(693134, "movie", "沙丘：第二部", "2024")];
    return [];
  }
  async details(kind: "movie" | "tv", id: number): Promise<TmdbDetails | null> {
    const base = { id, mediaType: kind, enTitle: "", posterUrl: "", imdbId: "", genreIds: [], countries: [], originalLanguage: "", aliases: [] };
    if (id === 153312) return { ...base, title: "怒呛人生", originalTitle: "BEEF", year: "2023", seasons: [{ season: 1, episodeCount: 10 }] };
    if (id === 693134) return { ...base, title: "沙丘：第二部", originalTitle: "Dune: Part Two", year: "2024" };
    if (id === 999) return { ...base, title: "另一部剧", originalTitle: "Other", year: "2020", seasons: [{ season: 1, episodeCount: 5 }, { season: 2, episodeCount: 5 }] };
    return null;
  }
  async season(): Promise<TmdbEpisode[]> {
    return [];
  }
}

function writeLocalStrm(rel: string, remote: string): void {
  const full = path.join(LOCAL, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `/mnt/${remote}`);
}
const localExists = (rel: string) => fs.existsSync(path.join(LOCAL, ...rel.split("/")));
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const localRead = (rel: string) => fs.readFileSync(path.join(LOCAL, ...rel.split("/")), "utf8");

/** 常规布景：inbox 里一季剧 + 一部电影，本地 strm 已同步 */
function seed() {
  drive = new FakeDrive("quark", account);
  drive.tree.addDir("/tv/inbox/BEEF.S01.1080p");
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt");
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/tvshow.nfo");
  drive.tree.addFile("/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv");
  fs.rmSync(LOCAL, { recursive: true, force: true });
  writeLocalStrm("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm", "tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  writeLocalStrm("inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.strm", "tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  fs.writeFileSync(path.join(LOCAL, "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt"), "sub");
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
}

async function untilStatus(id: string, statuses: OrganizeRun["status"][], tries = 200): Promise<OrganizeRun> {
  for (let i = 0; i < tries; i++) {
    await waitForRun(id);
    const r = getRunDetail(id).run;
    if (statuses.includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`run ${id} 没有到 ${statuses.join("/")}：${getRunDetail(id).run.status}`);
}

before(() => {
  baseline = { tasks: listTasks(), accounts: listAccounts(), settings: readAppSettings() };
  replaceAccounts([account]);
  replaceTasks([task]);
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"], downloadExtensions: [".srt", ".nfo"], tmdb: { apiKey: "x", language: "zh-CN" }, organize: {} });
  setOrganizeDeps({
    tmdb: () => new StubTmdb(),
    notify: async (ev) => {
      notified.push(ev);
      return true;
    },
    retryDelayMs: 5,
  });
});

beforeEach(() => {
  __test_resetOrganize();
  replaceShareFollows([]);
  replaceTasks([task]);
  replaceAppSettings({ ...readAppSettings(), organize: {} });
  notified = [];
  seed();
});

after(() => {
  setOrganizeDeps(null);
  setDriveProviderFactory(null);
  __test_resetOrganize();
  replaceShareFollows([]);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(path.join(DATA_DIR, "organize-itest"), { recursive: true, force: true });
});

test("预览：分单元、识别、规划出改名 / 移动 / 建目录 / 删空目录", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  assert.equal(run.status, "planning");
  const ready = await untilStatus(run.id, ["ready"]);
  const detail = getRunDetail(run.id);
  assert.equal(detail.units.length, 2);
  const beef = detail.units.find((u) => u.rootPath === "inbox/BEEF.S01.1080p")!;
  assert.equal(beef.match?.tmdbId, 153312);
  assert.equal(beef.match?.confidence, "medium", "文件名里没有年份");
  assert.equal(beef.dstRoot, "怒呛人生 (2023) [tmdbid=153312]");
  assert.equal(beef.selected, true);
  const dune = detail.units.find((u) => u.rootPath === "inbox")!;
  assert.equal(dune.match?.tmdbId, 693134);
  assert.equal(dune.match?.confidence, "high");
  const byAction = (a: string) => detail.items.filter((i) => i.action === a);
  assert.deepEqual(byAction("mkdir").map((i) => i.dstPath), [
    "/tv/怒呛人生 (2023) [tmdbid=153312]",
    "/tv/沙丘：第二部 (2024) [tmdbid=693134]",
    "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01",
  ]);
  assert.equal(byAction("move").length, 5, "两集 + 字幕 + nfo + 电影");
  assert.deepEqual(byAction("rmdir").map((i) => i.srcPath), ["/tv/inbox/BEEF.S01.1080p"], "inbox 是范围目录本身，不删");
  assert.equal(ready.stats.planned, 9);
  assert.equal(ready.stats.units, 2);
  assert.ok(detail.items.every((i) => i.nodeId || i.kind === "dir"), "夸克式的 walkSubtree 带 id");
});

test("执行：网盘改名移动、本地 strm 跟着挪并重写内容、字幕跟随、追更目录改写、监控能认出自有操作", async () => {
  insertShareFollow({
    id: "f1", name: "BEEF", libraryId: null, shareUrl: "", shareCode: "abc", receiveCode: "", watchCid: "0", watchPath: "", scope: [""],
    taskId: "t1", subPath: "inbox/BEEF.S01.1080p", enabled: true, intervalMinutes: 60, status: "idle", lastError: "", errorStreak: 0,
    lastCheckedAt: null, lastChangeAt: null, nextCheckAt: 0, known: [], recent: [], createdAt: 1, updatedAt: 1,
  });
  writeKv(KEY.offlineFollowups, [
    { kind: "strm", infoHash: "h1", account: "acc", taskId: "t1", subPath: "inbox/BEEF.S01.1080p", name: "x", addedAt: Date.now(), status: "pending", detail: "", attempts: 0, misses: 0 },
    { kind: "strm", infoHash: "h2", account: "acc", taskId: "t1", subPath: "inbox/BEEF.S01.1080p/sub", name: "y", addedAt: Date.now(), status: "done", detail: "", attempts: 0, misses: 0 },
  ]);
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await patchUnit(run.id, "inbox/BEEF.S01.1080p", { remember: true });
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  assert.equal(done.stats.done, 9);
  // 网盘
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.zh-CN.srt"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/tvshow.nfo"));
  assert.ok(drive.tree.get("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv"));
  assert.equal(drive.tree.get("/tv/inbox/BEEF.S01.1080p"), undefined, "腾空的源目录删掉");
  assert.ok(drive.tree.get("/tv/inbox"), "范围目录本身留着");
  // 本地镜像
  assert.ok(localExists("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm"));
  assert.equal(localRead("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm"), "/mnt/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.ok(localExists("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.zh-CN.srt"), "本地有的字幕跟着挪");
  assert.ok(localExists("沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.strm"), "本地没有的 strm 直接按新路径写");
  assert.ok(!localExists("inbox/BEEF.S01.1080p"), "本地空目录也清掉");
  // 记账与自有操作：115 会把「先改名再挪」报成两条事件，中间路径和最终路径都要认；认过两条之后再动就是用户动的
  const items = listItems(run.id);
  const ep1 = items.find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  assert.equal(ep1.status, "done");
  assert.equal(ep1.curPath, "", "挪完 cur_path 清空");
  const at = ep1.finishedAt!;
  assert.ok(findOwnOperation(ep1.nodeId, ep1.dstPath, at), "最终路径");
  assert.ok(findOwnOperation(ep1.nodeId, "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv", at), "原地改名后的中间路径");
  assert.equal(findOwnOperation(ep1.nodeId, "/tv/other", at), null);
  assert.equal(findOwnOperation(ep1.nodeId, ep1.dstPath, at - 3600), null, "事件比操作早一小时：不是它");
  bumpOwnHit(ep1.id);
  bumpOwnHit(ep1.id);
  assert.equal(findOwnOperation(ep1.nodeId, ep1.dstPath, at), null, "已经认过两条事件，之后同一路径再来就是用户动的");
  const mk = items.find((i) => i.action === "mkdir" && i.dstPath.endsWith("Season 01"))!;
  assert.ok(findOwnOperation(mk.nodeId, mk.dstPath, at), "建出来的目录：夸克快照会报成 create，也要认");
  // 追更落点改写 + 记忆；云下载回执只改还没兑现的
  assert.equal(getShareFollow("f1")!.subPath, "怒呛人生 (2023) [tmdbid=153312]");
  const followups = readKv<Array<{ infoHash: string; subPath: string }>>(KEY.offlineFollowups) ?? [];
  assert.equal(followups.find((f) => f.infoHash === "h1")!.subPath, "怒呛人生 (2023) [tmdbid=153312]");
  assert.equal(followups.find((f) => f.infoHash === "h2")!.subPath, "inbox/BEEF.S01.1080p/sub", "done 的回执不动");
  writeKv(KEY.offlineFollowups, []);
  assert.equal(recallMatch("acc", "/tv/怒呛人生 (2023) [tmdbid=153312]")?.tmdbId, 153312);
  assert.equal(notified.filter((e) => e.type === "organize-done").length, 1);
  // 再预览一遍：全部 keep，零变更
  const again = await createRun({ taskId: "t1" });
  const ready = await untilStatus(again.id, ["ready"]);
  assert.equal(ready.stats.planned, 0);
  assert.ok(getRunDetail(again.id).items.filter((i) => i.kind !== "dir").every((i) => i.action === "keep"));
  const memoryUnit = getRunDetail(again.id).units.find((u) => u.rootPath === "怒呛人生 (2023) [tmdbid=153312]")!;
  assert.equal(memoryUnit.match?.reason, "上次确认过的识别结果");
  const tagUnit = getRunDetail(again.id).units.find((u) => u.rootPath === "沙丘：第二部 (2024) [tmdbid=693134]")!;
  assert.equal(tagUnit.match?.reason, "目录名里的 tmdbid 标签");
  assert.equal(tagUnit.match?.confidence, "high");
});

test("撤销：按流水账逆序退回，网盘和本地都恢复，追更落点改回去", async () => {
  insertShareFollow({
    id: "f2", name: "BEEF", libraryId: null, shareUrl: "", shareCode: "abd", receiveCode: "", watchCid: "0", watchPath: "", scope: [""],
    taskId: "t1", subPath: "inbox/BEEF.S01.1080p", enabled: true, intervalMinutes: 60, status: "idle", lastError: "", errorStreak: 0,
    lastCheckedAt: null, lastChangeAt: null, nextCheckAt: 0, known: [], recent: [], createdAt: 1, updatedAt: 1,
  });
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(getRunDetail(run.id).revertable.ok, true);
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.status, "reverted");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"));
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt"));
  assert.ok(drive.tree.get("/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"));
  assert.equal(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]"), undefined, "建出来的目录空了就删");
  assert.equal(localRead("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "/mnt/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  assert.ok(!localExists("怒呛人生 (2023) [tmdbid=153312]"));
  assert.equal(getShareFollow("f2")!.subPath, "inbox/BEEF.S01.1080p");
  assert.equal(getRunDetail(run.id).revertable.ok, false);
  // 撤销产生的反向事件也要认成自己的：新路径是原路径，或反向的中间路径
  const ep2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(ep2.status, "reverted");
  assert.ok(findOwnOperation(ep2.nodeId, ep2.srcPath, ep2.finishedAt!));
  assert.ok(findOwnOperation(ep2.nodeId, "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/BEEF.S01E02.1080p.WEB-DL.mkv", ep2.finishedAt!));
});

test("范围就是发布目录：腾空后连范围目录一起删，撤销时按需重建", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run.id, ["ready"]);
  const planned = getRunDetail(run.id).items;
  assert.deepEqual(planned.filter((i) => i.action === "rmdir").map((i) => i.srcPath), ["/tv/inbox/BEEF.S01.1080p"], "范围目录像发布目录，腾空了就删");
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(drive.tree.get("/tv/inbox/BEEF.S01.1080p"), undefined, "网盘上的空壳删掉了");
  assert.ok(drive.tree.get("/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"), "范围外的不动");
  assert.ok(!localExists("inbox/BEEF.S01.1080p"));
  assert.ok(localExists("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm"));
  // 删目录的事件路径靠不住（缓存里已经没了），按节点认；文件节点的删除不算自己的
  const rmdir = listItems(run.id).find((i) => i.action === "rmdir")!;
  assert.ok(rmdir.nodeId && findOwnOperation(rmdir.nodeId, "/BEEF.S01.1080p", rmdir.finishedAt!, "remove"), "腾空后删掉的源目录");
  const ep1 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  assert.equal(findOwnOperation(ep1.nodeId, ep1.dstPath, ep1.finishedAt!, "remove"), null, "用户删了挪过去的文件，不是自己的");
  await revertRun(run.id);
  await untilStatus(run.id, ["reverted"]);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "挪回去时把目录重建了");
  const mk = listItems(run.id).find((i) => i.action === "mkdir" && i.dstPath === "/tv/怒呛人生 (2023) [tmdbid=153312]")!;
  assert.equal(mk.status, "reverted");
  assert.ok(findOwnOperation(mk.nodeId, "/怒呛人生 (2023) [tmdbid=153312]", mk.finishedAt!, "remove"), "撤销时删掉的自建目录");
  // 快照式监控可能在撤销开始之后才看到执行时的那次删除：rmdir 项已经标成 reverted 也得认（重建的是新节点，旧节点只可能是我们删的）
  const rm2 = listItems(run.id).find((i) => i.action === "rmdir")!;
  assert.equal(rm2.status, "reverted");
  assert.ok(findOwnOperation(rm2.nodeId, "/BEEF.S01.1080p", rm2.finishedAt!, "remove"), "撤销后旧节点的删除事件还是自己的");
  assert.equal(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]"), undefined);
  assert.equal(localRead("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "/mnt/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
});

test("本地镜像只认同账号的任务：别的账号同名 originPath 的任务不会被串到", async () => {
  // 另一个账号也有 originPath 为 tv 的任务，且排在前面：按路径匹配会先撞上它
  const decoy: TaskDefinition = { id: "t0", account: "other", accountType: "115", originPath: "tv", targetPath: "organize-itest/other-tv", strmPrefix: "/mnt2" };
  replaceTasks([decoy, task]);
  const run = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(localRead("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm"), "/mnt/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.ok(!localExists("inbox/BEEF.S01.1080p"));
  assert.ok(!fs.existsSync(path.join(DATA_DIR, "organize-itest", "other-tv")), "别的账号的本地目录一个字节都不该动");
  await revertRun(run.id);
  await untilStatus(run.id, ["reverted"]);
  assert.equal(localRead("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "/mnt/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  assert.ok(!fs.existsSync(path.join(DATA_DIR, "organize-itest", "other-tv")));
});

test("散在任务根目录的文件：按标题各自成单元挪进作品目录，作品目录已存在就直接进去，根目录不删", async () => {
  // 根目录下：一部已经整理好的剧、一集散落的 BEEF（带字幕）、一个散落的沙丘 1080p（inbox 里还有它的 2160p）
  drive.tree.addDir("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  drive.tree.addFile("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  drive.tree.addFile("/tv/BEEF.S01E03.1080p.WEB-DL.mkv");
  drive.tree.addFile("/tv/BEEF.S01E03.1080p.WEB-DL.chs.srt");
  drive.tree.addFile("/tv/Dune.Part.Two.2024.1080p.WEB-DL.mkv");
  writeLocalStrm("BEEF.S01E03.1080p.WEB-DL.strm", "tv/BEEF.S01E03.1080p.WEB-DL.mkv");
  const run = await createRun({ taskId: "t1", subPath: "" });
  await untilStatus(run.id, ["ready"]);
  const detail = getRunDetail(run.id);
  const rootUnits = detail.units.filter((u) => u.rootPath === "");
  assert.deepEqual(rootUnits.map((u) => u.dstRoot).sort(), ["怒呛人生 (2023) [tmdbid=153312]", "沙丘：第二部 (2024) [tmdbid=693134]"], "根目录按标题拆成两个单元");
  const byDst = (suffix: string) => detail.items.find((i) => i.dstPath.endsWith(suffix))!;
  assert.equal(byDst("Season 01/怒呛人生 - S01E03.mkv").srcPath, "/tv/BEEF.S01E03.1080p.WEB-DL.mkv");
  assert.equal(byDst("Season 01/怒呛人生 - S01E03.zh-CN.srt").srcPath, "/tv/BEEF.S01E03.1080p.WEB-DL.chs.srt");
  assert.equal(byDst("沙丘：第二部 (2024) - 1080p.mkv").srcPath, "/tv/Dune.Part.Two.2024.1080p.WEB-DL.mkv");
  assert.equal(byDst("沙丘：第二部 (2024) - 2160p.mkv").srcPath, "/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv", "inbox 里的另一个版本进同一个作品目录");
  const mkdirs = detail.items.filter((i) => i.action === "mkdir").map((i) => i.dstPath);
  assert.ok(!mkdirs.some((d) => d.includes("怒呛人生")), "已存在的作品目录和季目录不再建");
  const existing = detail.units.find((u) => u.rootPath === "怒呛人生 (2023) [tmdbid=153312]")!;
  assert.equal(existing.match?.confidence, "high", "目录名里的 tmdbid 标签直接认");
  assert.equal(detail.items.filter((i) => i.unitKey === existing.key && i.action !== "keep").length, 0, "已经规范的文件一个都不动");
  assert.ok(!detail.items.some((i) => i.action === "rmdir" && i.srcPath === "/tv"), "任务根目录永远不删");
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(drive.tree.get("/tv/BEEF.S01E03.1080p.WEB-DL.mkv"), undefined);
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E03.mkv"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"), "原来的文件还在");
  assert.ok(drive.tree.get("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 1080p.mkv"));
  assert.ok(drive.tree.get("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv"));
  assert.equal(localRead("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E03.strm"), "/mnt/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E03.mkv");
  assert.ok(!localExists("BEEF.S01E03.1080p.WEB-DL.strm"));
});

test("中途取消：改了名还没挪走的项记着 cur_path，续跑接着挪，撤销也能改回去", async () => {
  // 改名一律成功，移动一到就中止：模拟第一次 apply 在 2b 和 2c 之间被掐断
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  drive.failWriteOn = (op) => (op === "move" ? new Error("blocked by 405") : null);
  await applyRun(run.id);
  const stopped = await untilStatus(run.id, ["failed"]);
  assert.match(stopped.error, /网盘拒绝/);
  const partial = listItems(run.id).filter((i) => i.curPath);
  assert.ok(partial.length >= 2, "改了名的移动项都记着当前路径");
  assert.ok(partial.every((i) => i.status === "failed" || i.status === "pending"), "移动那一步没成：失败或还没轮到，cur_path 都在");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv"), "网盘上文件已经是新名字、还在原目录");
  assert.ok(localExists("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "本地还没动");
  assert.equal(getRunDetail(run.id).revertable.ok, true, "改过名就能撤");
  // 这个窗口里监控拉到的改名事件（路径是中间名字）要认成整理自己的，不能当用户改名去动本地
  const inflight = partial.find((i) => i.status === "pending") ?? partial[0];
  const nowSec = Math.floor(Date.now() / 1000);
  assert.ok(findOwnOperation(inflight.nodeId, inflight.curPath, nowSec), "改了名还没挪走：按中间名字认");
  assert.ok(findOwnOperation(inflight.nodeId, inflight.dstPath, nowSec), "挪到目标还没记账：按目标认");
  assert.equal(findOwnOperation(inflight.nodeId, "/tv/other/x.mkv", nowSec), null);
  // 续跑：不会再改一次名，直接挪
  drive.failWriteOn = null;
  const renamesBefore = drive.calls.rename;
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  assert.equal(drive.calls.rename, renamesBefore, "续跑没有重复改名");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"));
  assert.ok(listItems(run.id).every((i) => !i.curPath));
  // 再来一遍中断后直接撤销：改了名的改回去
  seed();
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  drive.failWriteOn = (op) => (op === "move" ? new Error("blocked by 405") : null);
  await applyRun(run2.id);
  await untilStatus(run2.id, ["failed"]);
  drive.failWriteOn = null;
  await revertRun(run2.id);
  await untilStatus(run2.id, ["reverted"]);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "名字改回去了");
  assert.equal(drive.tree.get("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv"), undefined);
});

test("监控抢先把本地 strm 按中间名字改了：镜像接着按它搬，不在旧目录留副本", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  // 模拟监控在「原地改完名、还没挪走」的窗口里把本地文件改成了新名字（老版本没认出这是整理自己做的）
  fs.renameSync(path.join(LOCAL, "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), path.join(LOCAL, "inbox/BEEF.S01.1080p/怒呛人生 - S01E01.strm"));
  fs.writeFileSync(path.join(LOCAL, "inbox/BEEF.S01.1080p/怒呛人生 - S01E01.strm"), "/mnt/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv");
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(localRead("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm"), "/mnt/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.ok(!localExists("inbox/BEEF.S01.1080p/怒呛人生 - S01E01.strm"), "改了名的那份被搬走了，不是另写一份");
  assert.ok(!localExists("inbox/BEEF.S01.1080p"), "源目录腾空后本地目录也没了");
});

test("失败的项再执行会重试；记忆按新路径写、不被旧记忆盖掉", async () => {
  rememberMatch({ accountName: "acc", srcPath: "/tv/inbox/BEEF.S01.1080p", mediaType: "tv", tmdbId: 999, title: "另一部剧", year: "2020", season: null, episodeOffset: 0 });
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const u = getRunDetail(run.id).units.find((x) => x.rootPath === "inbox/BEEF.S01.1080p")!;
  assert.equal(u.match?.tmdbId, 999, "旧记忆先生效");
  await patchUnit(run.id, u.key, { match: { mediaType: "tv", tmdbId: 153312 }, remember: true });
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  await applyRun(run.id);
  const first = await untilStatus(run.id, ["done"]);
  assert.equal(first.stats.failed, 1);
  drive.failWriteOn = null;
  await applyRun(run.id);
  const second = await untilStatus(run.id, ["done"]);
  assert.equal(second.stats.failed, 0, "失败的那项这次成功了");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv"));
  const memory = recallMatch("acc", "/tv/怒呛人生 (2023) [tmdbid=153312]");
  assert.equal(memory?.tmdbId, 153312, "这次确认的 153312 而不是被挪过来的旧记忆 999");
});

test("自动触发的 run（按路径）也会列范围外的目标目录：已存在的不再 mkdir，撞名算冲突", async () => {
  drive.tree.addDir("/tv/沙丘：第二部 (2024) [tmdbid=693134]");
  drive.tree.addFile("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv");
  drive.tree.addDir("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  const run = await createRun({ taskId: "t1", paths: ["inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv", "inbox/BEEF.S01.1080p"], mode: "review", trigger: "share" });
  const ready = await untilStatus(run.id, ["ready"]);
  const items = getRunDetail(run.id).items;
  assert.equal(items.filter((i) => i.action === "mkdir").length, 0, "目标目录都已存在");
  assert.equal(ready.stats.conflicts, 1);
  assert.equal(ready.status, "ready", "review 模式不自动执行");
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"));
});

test("源目录里已有和新名字一样的文件：中间改名会撞上，标冲突", async () => {
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  const ready = await untilStatus(run.id, ["ready"]);
  const c = getRunDetail(run.id).items.find((i) => i.action === "conflict" && i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"));
  assert.ok(c, "原始那份和已规范的那份算出同一个名字");
  assert.ok(ready.stats.conflicts >= 1);
});

test("撤销只允许最近一次：前一次执行过的 run 在后一次执行之后不能再撤", async () => {
  const first = await createRun({ taskId: "t1", paths: ["inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"] });
  await untilStatus(first.id, ["ready"]);
  await applyRun(first.id);
  await untilStatus(first.id, ["done"]);
  assert.equal(getRunDetail(first.id).revertable.ok, true);
  const second = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(second.id, ["ready"]);
  await applyRun(second.id);
  await untilStatus(second.id, ["done"]);
  const r = getRunDetail(first.id).revertable;
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /最近一次/);
  await assert.rejects(revertRun(first.id), /最近一次/);
  assert.equal(getRunDetail(second.id).revertable.ok, true);
  await assert.rejects(createRun({ taskId: "t1", subPath: "../x" }), /不合法/);
});

test("预览里改匹配 / 改季 / 取消勾选：重新规划这个单元，其它不动", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const u = await patchUnit(run.id, "inbox/BEEF.S01.1080p", { match: { mediaType: "tv", tmdbId: 999 }, seasonOverride: 2 });
  assert.equal(u.match?.title, "另一部剧");
  assert.equal(u.dstRoot, "另一部剧 (2020) [tmdbid=999]");
  const items = listItems(run.id);
  assert.ok(items.some((i) => i.dstPath === "/tv/另一部剧 (2020) [tmdbid=999]/Season 02/另一部剧 - S02E01.mkv"));
  assert.ok(items.some((i) => i.dstPath.includes("沙丘：第二部")), "电影那个单元还在");
  const off = await patchUnit(run.id, "inbox/BEEF.S01.1080p", { selected: false });
  assert.equal(off.selected, false);
  assert.ok(listItems(run.id).filter((i) => i.unitKey === "inbox/BEEF.S01.1080p").every((i) => i.action === "skip"));
  assert.equal(getRunDetail(run.id).run.stats.planned, 2, "只剩电影：mkdir + move");
  const back = await patchUnit(run.id, "inbox/BEEF.S01.1080p", { selected: true });
  assert.equal(back.selected, true);
  assert.equal(listUnits(run.id).length, 2);
});

test("冲突：目标已存在的项不动，其余照常执行", async () => {
  drive.tree.addDir("/tv/沙丘：第二部 (2024) [tmdbid=693134]");
  drive.tree.addFile("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  const ready = await untilStatus(run.id, ["ready"]);
  assert.equal(ready.stats.conflicts, 1);
  const c = getRunDetail(run.id).items.find((i) => i.action === "conflict")!;
  assert.equal(c.reason, "目标已存在");
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.ok(drive.tree.get("/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"), "冲突的没动");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv"));
  assert.equal(done.stats.failed, 0);
});

test("单项失败不影响其余；风控整轮停下，可以再执行接着来", async () => {
  // 移动时文件已经先原地改过名了，按新名字认
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 1);
  const bad = listItems(run.id).find((i) => i.status === "failed")!;
  assert.match(bad.error, /改不了/);
  assert.equal(bad.errorKind, "transient", "认不出的错误按临时算");
  assert.equal(bad.attempts, 1, "自动重试不算一轮");
  assert.ok(done.log.some((l) => l.includes("秒后重试")), "临时失败自动重试过");
  assert.equal(done.stats.failedByKind.transient, 1);
  assert.equal(getRunDetail(run.id).applicable.ok, true, "临时失败默认可以重试");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"), "同批的其它项照常");

  seed();
  drive.failWriteOn = (op) => (op === "rename" ? new Error("blocked by 405") : null);
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  const failed = await untilStatus(run2.id, ["failed"]);
  assert.match(failed.error, /网盘拒绝了请求/);
  assert.ok(listItems(run2.id).some((i) => i.status === "failed" && i.errorKind === "blocked"), "风控的项记成 blocked");
  assert.ok(!failed.log.some((l) => l.includes("秒后重试")), "风控不自动重试");
  const pendingBefore = listItems(run2.id).filter((i) => i.status === "pending").length;
  assert.ok(pendingBefore > 0, "停下时还有没做的项");
  drive.failWriteOn = null;
  await applyRun(run2.id);
  const done2 = await untilStatus(run2.id, ["done"]);
  assert.equal(listItems(run2.id).filter((i) => i.status === "pending").length, 0);
  assert.ok(done2.stats.done >= pendingBefore);
});

test("自动模式：全 high 且无冲突直接执行；有拿不准的只通知待确认", async () => {
  replaceTasks([{ ...task, organize: { mode: "auto" } }]);
  // 只给电影：high
  const run = await createRun({ taskId: "t1", paths: ["inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"], mode: "auto", trigger: "share" });
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.status, "done");
  assert.ok(drive.tree.get("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv"));
  assert.equal(notified.filter((e) => e.type === "organize-review").length, 0);
  // 剧是 medium：留着等确认
  const run2 = await createRun({ taskId: "t1", paths: ["inbox/BEEF.S01.1080p"], mode: "auto", trigger: "follow" });
  const ready = await untilStatus(run2.id, ["ready"]);
  assert.equal(ready.status, "ready");
  assert.equal(notified.filter((e) => e.type === "organize-review").length, 1);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "没动");
});

test("115 式：没有 walkSubtree，预览只有路径，执行时按父目录列一次拿 id", async () => {
  const inner = drive;
  const noWalk: DriveProvider = {
    kind: inner.kind,
    account: inner.account,
    capabilities: inner.capabilities,
    rootId: inner.rootId,
    write: inner.write,
    resolvePath: (p) => inner.resolvePath(p),
    listDir: (id) => inner.listDir(id),
    listSubtree: (p, o) => inner.listSubtree(p, o),
    downloadLink: (p) => inner.downloadLink(p),
    classifyError: (e) => inner.classifyError(e),
  };
  setDriveProviderFactory((a) => (a.name === "acc" ? noWalk : null));
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  assert.ok(getRunDetail(run.id).items.filter((i) => i.kind !== "dir").every((i) => !i.nodeId), "预览阶段没有 id");
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  assert.ok(inner.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"));
  assert.ok(listItems(run.id).filter((i) => i.status === "done" && i.kind === "video").every((i) => i.nodeId), "执行时解析到的 id 记进流水账");
  assert.ok(inner.calls.listDir <= 3, `每个父目录只列一次，刚建的目标目录不列（实际 ${inner.calls.listDir}）`);
});

test("取消：预览中取消 → cancelled；同一任务同时只有一次整理", async () => {
  drive.beforeCall = () => new Promise((r) => setTimeout(r, 30));
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await assert.rejects(createRun({ taskId: "t1" }), /进行中/);
  cancelRun(run.id);
  const r = await untilStatus(run.id, ["cancelled", "ready"]);
  assert.ok(r.status === "cancelled" || r.status === "ready");
});

/* ------------------------------- 失败项：分类 / 重试 / 放弃 / 撤销对称 ------------------------------- */

test("临时失败在执行中自动重试一次：第一次改名抛网络错、第二次成功，不算失败", async () => {
  let calls = 0;
  drive.failWriteOn = (op, p) => (op === "rename" && p.endsWith("BEEF.S01E02.1080p.WEB-DL.mkv") && ++calls === 1 ? new Error("read ECONNRESET") : null);
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0, "第二次成功了");
  const ep2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(ep2.status, "done");
  assert.equal(ep2.errorKind, "");
  assert.equal(ep2.attempts, 1, "自动重试不算一轮");
  assert.ok(done.log.some((l) => l.includes("秒后重试")), "日志里说了在重试");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv"));
});

test("预览后文件被移走：记成 stale，默认重试不碰它、点名才重试；放弃后 run 收口", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  drive.tree.remove("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 1);
  assert.equal(done.stats.failedByKind.stale, 1);
  const bad = listItems(run.id).find((i) => i.status === "failed")!;
  assert.equal(bad.errorKind, "stale");
  assert.equal(bad.attempts, 1);
  assert.ok(!done.log.some((l) => l.includes("秒后重试")), "stale 不自动重试");
  assert.equal(getRunDetail(run.id).applicable.ok, false, "默认没有可重试的");
  assert.equal(notified.filter((e) => e.type === "organize-done" && e.failedByKind?.stale === 1).length, 1, "通知里带着分类");
  // 点名重试：还是找不到，再失败一次
  await applyRun(run.id, [bad.id]);
  const again = await untilStatus(run.id, ["done"]);
  assert.equal(again.stats.failed, 1);
  assert.equal(listItems(run.id).find((i) => i.id === bad.id)!.attempts, 2, "点名重试算第二轮");
  await assert.rejects(applyRun(run.id, ["nope"]), /没有可以重试的/);
  // 放弃：标成 skipped，run 里没有失败了
  const r = await skipItems(run.id, [bad.id]);
  assert.deepEqual(r, { skipped: 1, renamedBack: 0, refused: [] });
  const after = getRunDetail(run.id);
  assert.equal(after.run.stats.failed, 0);
  assert.equal(after.run.stats.failedByKind.stale, 0);
  const it = after.items.find((i) => i.id === bad.id)!;
  assert.equal(it.status, "skipped");
  assert.equal(it.errorKind, "stale", "放弃了类别还留着");
  assert.match(it.error, /^已放弃：/);
  assert.equal(after.applicable.ok, false);
  // 再放弃一次：没有需要放弃的
  const r2 = await skipItems(run.id, [bad.id]);
  assert.equal(r2.skipped, 0);
  assert.equal(r2.refused.length, 1);
});

test("放弃原地改了名还没挪走的项：先在网盘上改回原名再标放弃", async () => {
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 1);
  const bad = listItems(run.id).find((i) => i.status === "failed")!;
  assert.equal(bad.errorKind, "transient");
  assert.equal(bad.curPath, "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv");
  assert.equal(bad.attempts, 1);
  drive.failWriteOn = null;
  const r = await skipItems(run.id, [bad.id]);
  assert.equal(r.renamedBack, 1);
  assert.equal(r.skipped, 1);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"), "名字改回去了");
  assert.equal(drive.tree.get("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv"), undefined);
  const it = listItems(run.id).find((i) => i.id === bad.id)!;
  assert.equal(it.status, "skipped");
  assert.equal(it.curPath, "");
  assert.equal(getRunDetail(run.id).run.stats.failed, 0);
  assert.ok(localExists("inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.strm"), "本地一直没动");
  // 改不回去就仍是失败：改名再次被拒
  seed();
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  await untilStatus(run2.id, ["done"]);
  const bad2 = listItems(run2.id).find((i) => i.status === "failed")!;
  drive.failWriteOn = (op) => (op === "rename" ? new Error("blocked by 405") : null);
  const r2 = await skipItems(run2.id, [bad2.id]);
  assert.equal(r2.skipped, 0);
  assert.equal(r2.refused.length, 1);
  const still = listItems(run2.id).find((i) => i.id === bad2.id)!;
  assert.equal(still.status, "failed");
  assert.equal(still.errorKind, "blocked");
  assert.match(still.error, /改回原名失败/);
  assert.equal(still.curPath, "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv", "位置没变");
});

test("放弃建目录项：连带放弃要进这个目录的项；中断的 run 放弃完剩下的就收口成 done", async () => {
  drive.failWriteOn = (op, p) => (op === "mkdir" && p.endsWith("Season 01") ? new Error("115：文件名不能包含特殊字符") : null);
  const run = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  const mk = listItems(run.id).find((i) => i.action === "mkdir" && i.dstPath.endsWith("Season 01"))!;
  assert.equal(mk.status, "failed");
  assert.equal(mk.errorKind, "rejected");
  assert.equal(done.stats.failedByKind.rejected, 1);
  const eps = listItems(run.id).filter((i) => i.dstPath.includes("/Season 01/"));
  assert.ok(eps.length >= 2);
  assert.ok(eps.every((i) => i.status === "failed" && i.errorKind === "stale"), "目录没建成，进目录的项都是「网盘上没有目录」");
  const r = await skipItems(run.id, [mk.id]);
  assert.equal(r.skipped, 1 + eps.length, "连带放弃");
  assert.ok(listItems(run.id).filter((i) => i.dstPath.includes("/Season 01/")).every((i) => i.status === "skipped"));
  assert.equal(getRunDetail(run.id).run.stats.failed, 0);

  // 风控中断的 run：放弃完剩下的失败项之后没有要做的了 → done
  seed();
  drive.failWriteOn = (op) => (op === "rename" ? new Error("blocked by 405") : null);
  const run2 = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  const stopped = await untilStatus(run2.id, ["failed"]);
  assert.equal(stopped.stage, "apply");
  const rest = listItems(run2.id).filter((i) => i.status === "failed" || i.status === "pending").map((i) => i.id);
  assert.ok(rest.length > 0);
  drive.failWriteOn = null;
  const r2 = await skipItems(run2.id, rest);
  assert.equal(r2.refused.length, 0);
  const after = getRunDetail(run2.id);
  assert.equal(after.run.status, "done", "没剩下要做的，收口");
  assert.equal(after.run.error, "");
  assert.equal(after.applicable.ok, false);
});

test("本地镜像失败：网盘那步算完成、记成 mirror；再执行只补本地不碰网盘；放弃就是不再提醒", async () => {
  // 本地放一个同名文件挡住作品目录，镜像建不了目录
  fs.writeFileSync(path.join(LOCAL, "怒呛人生 (2023) [tmdbid=153312]"), "占位");
  const run = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0, "网盘那步都成了");
  assert.ok(done.stats.failedByKind.mirror >= 2, `本地没跟上的项（${done.stats.failedByKind.mirror}）`);
  const ep1 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  assert.equal(ep1.status, "done");
  assert.equal(ep1.errorKind, "mirror");
  assert.match(ep1.error, /本地镜像失败/);
  assert.ok(drive.tree.get(ep1.dstPath), "网盘上已经挪好");
  assert.ok(localExists("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "本地还在原处");
  assert.equal(getRunDetail(run.id).applicable.ok, true, "有本地要补");
  assert.ok(notified.some((e) => e.type === "organize-done" && (e.failedByKind?.mirror ?? 0) >= 2));
  // 补做：只动本地
  fs.rmSync(path.join(LOCAL, "怒呛人生 (2023) [tmdbid=153312]"));
  const before = { ...drive.calls };
  await applyRun(run.id);
  const again = await untilStatus(run.id, ["done"]);
  assert.equal(again.stats.failedByKind.mirror, 0);
  assert.deepEqual(
    { rename: drive.calls.rename, move: drive.calls.move, mkdir: drive.calls.mkdir, rmdir: drive.calls.rmdir },
    { rename: before.rename, move: before.move, mkdir: before.mkdir, rmdir: before.rmdir },
    "没碰网盘的写接口",
  );
  assert.equal(localRead("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm"), "/mnt/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.ok(!localExists("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"));
  assert.equal(getRunDetail(run.id).applicable.ok, false);

  // 放弃镜像失败：状态还是 done，只是不再当失败项
  seed();
  fs.writeFileSync(path.join(LOCAL, "怒呛人生 (2023) [tmdbid=153312]"), "占位");
  const run2 = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  await untilStatus(run2.id, ["done"]);
  const mirrors = listItems(run2.id).filter((i) => i.errorKind === "mirror").map((i) => i.id);
  const r = await skipItems(run2.id, mirrors);
  assert.equal(r.skipped, mirrors.length);
  const items = listItems(run2.id).filter((i) => mirrors.includes(i.id));
  // 状态和类别都不变（监控见到自有事件仍会补本地），只是标了放弃、不再当失败项
  assert.ok(items.every((i) => i.status === "done" && i.errorKind === "mirror" && i.givenUp && i.error.startsWith("已放弃：本地未同步")));
  assert.equal(getRunDetail(run2.id).run.stats.failedByKind.mirror, 0);
  assert.equal(getRunDetail(run2.id).groups.length, 0, "面板里不再有它");
  assert.equal(getRunDetail(run2.id).applicable.ok, false, "也不会再被「重试」捞起来");
  assert.equal(getRunDetail(run2.id).revertable.ok, true, "网盘上动过的还能撤");
  fs.rmSync(path.join(LOCAL, "怒呛人生 (2023) [tmdbid=153312]"), { force: true });
});

test("撤销时一项在网盘上失败：状态仍是 done、记类别；run 标已撤销但有没退回的，不能再执行，再撤销一次就完成", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.stage, "revert");
  assert.equal(reverted.stats.notReverted, 1);
  assert.equal(reverted.stats.failedByKind.transient, 1);
  const ep2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(ep2.status, "done", "文件还在整理后的位置，状态照实");
  assert.equal(ep2.errorKind, "transient");
  assert.equal(ep2.curPath, "");
  assert.ok(drive.tree.get(ep2.dstPath));
  assert.equal(localRead("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.strm"), "/mnt/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv", "本地也还在整理后的位置");
  const detail = getRunDetail(run.id);
  assert.equal(detail.revertable.ok, true, "还能继续撤销");
  assert.equal(detail.applicable.ok, false, "开始撤销后不能再执行");
  assert.match(detail.applicable.reason ?? "", /只能继续撤销/);
  await assert.rejects(applyRun(run.id), /只能继续撤销/);
  assert.equal(notified.filter((e) => e.type === "organize-done" && e.reverted && e.notReverted === 1).length, 1);
  // 监控：撤销失败的项本地和网盘仍一致，自有事件照旧认成自己的（按 errorKind 判，mirror 才不跳）
  assert.ok(findOwnOperation(ep2.nodeId, ep2.dstPath, Math.floor(Date.now() / 1000)));
  // 放弃撤销：文件留在整理后的位置，状态照实还是 done，只标放弃
  assert.deepEqual(getRunDetail(run.id).groups.map((g) => [g.key, g.itemIds.length, g.held]), [["transient", 1, 0]]);
  const r = await skipItems(run.id, [ep2.id]);
  assert.equal(r.skipped, 1);
  const given = listItems(run.id).find((i) => i.id === ep2.id)!;
  assert.equal(given.status, "done");
  assert.equal(given.givenUp, true);
  assert.equal(getRunDetail(run.id).revertable.ok, false, "放弃之后没有要退回的了");
  assert.equal(getRunDetail(run.id).run.stats.notReverted, 0);
  assert.equal(getRunDetail(run.id).groups.length, 0);

  // 同样的场景不放弃、再撤销一次：这次成功，连上一轮没删掉的自建目录也一起删
  seed();
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  await untilStatus(run2.id, ["done"]);
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  await revertRun(run2.id);
  await untilStatus(run2.id, ["reverted"]);
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01"), "还有文件的自建目录留着");
  drive.failWriteOn = null;
  await revertRun(run2.id);
  const again = await untilStatus(run2.id, ["reverted"]);
  assert.equal(again.stats.notReverted, 0);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"));
  assert.equal(localRead("inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.strm"), "/mnt/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  assert.equal(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]"), undefined, "空了的自建目录第二次撤销时删掉");
  assert.equal(getRunDetail(run2.id).revertable.ok, false);
});

test("撤销时挪回来了、改回原名失败：记着中间位置，再撤销只改名，本地镜像回到原位", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  drive.failWriteOn = (op, p) => (op === "rename" && p === "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv" ? new Error("改不了") : null);
  await revertRun(run.id);
  const first = await untilStatus(run.id, ["reverted"]);
  assert.equal(first.stats.notReverted, 1);
  const ep2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(ep2.status, "done");
  assert.equal(ep2.curPath, "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv");
  assert.ok(drive.tree.get(ep2.curPath), "网盘上在中间位置");
  assert.ok(localExists("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.strm"), "本地还没动");
  // 监控在这个窗口里看到的移动事件（路径是中间位置）要认成自己的
  assert.ok(findOwnOperation(ep2.nodeId, ep2.curPath, Math.floor(Date.now() / 1000)));
  // 挪回了没改名的不给放弃
  const r = await skipItems(run.id, [ep2.id]);
  assert.equal(r.skipped, 0);
  assert.match(r.refused[0]?.reason ?? "", /只能继续撤销/);
  drive.failWriteOn = null;
  const moves = drive.calls.move;
  await revertRun(run.id);
  const second = await untilStatus(run.id, ["reverted"]);
  assert.equal(second.stats.notReverted, 0);
  assert.equal(drive.calls.move, moves, "第二次没有再挪");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"));
  assert.equal(localRead("inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.strm"), "/mnt/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  assert.ok(!localExists("怒呛人生 (2023) [tmdbid=153312]"));
  assert.equal(listItems(run.id).find((i) => i.id === ep2.id)!.curPath, "");
});

test("撤销时文件已经不在整理后的位置：记成 failed + stale 不再归整理管，其余照常退回；风控中断撤销后能继续撤销", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  drive.tree.remove("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv");
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  const ep2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(ep2.status, "failed");
  assert.equal(ep2.errorKind, "stale");
  assert.match(ep2.error, /已不在整理后的位置/);
  assert.equal(reverted.stats.notReverted, 1);
  assert.equal(reverted.stats.failedByKind.stale, 1);
  assert.equal(getRunDetail(run.id).revertable.ok, false, "找不到的不算还有事");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "其余退回了");
  const r = await skipItems(run.id, [ep2.id]);
  assert.equal(r.skipped, 1);
  assert.equal(getRunDetail(run.id).run.stats.notReverted, 0);

  seed();
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  await untilStatus(run2.id, ["done"]);
  drive.failWriteOn = (op) => (op === "move" ? new Error("blocked by 405") : null);
  await revertRun(run2.id);
  const stopped = await untilStatus(run2.id, ["failed"]);
  assert.equal(stopped.stage, "revert");
  assert.match(stopped.error, /撤销已停下/);
  assert.equal(getRunDetail(run2.id).applicable.ok, false, "撤销中断的 run 不能执行");
  assert.equal(getRunDetail(run2.id).revertable.ok, true);
  drive.failWriteOn = null;
  await revertRun(run2.id);
  const done = await untilStatus(run2.id, ["reverted"]);
  assert.equal(done.stats.notReverted, 0);
  assert.ok(drive.tree.get("/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"));
});

test("预览之后目标目录里多了同名文件：动手前先看一眼，撞名的记 rejected 不碰网盘（115 会悄悄改成 (1)），放弃时改回原名", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  // 别人往目标目录放了一个和 E02 目标同名的文件
  drive.tree.addDir("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  drive.tree.addFile("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv");
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failedByKind.rejected, 1);
  const bad = listItems(run.id).find((i) => i.status === "failed")!;
  assert.equal(bad.errorKind, "rejected");
  assert.match(bad.error, /目标目录里已经有同名文件/);
  assert.equal(bad.curPath, "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv", "原地改了名、没挪");
  assert.ok(!drive.log.some((l) => l.startsWith("move /tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv")), "没去撞");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"), "同批的其它项照常");
  const r = await skipItems(run.id, [bad.id]);
  assert.equal(r.renamedBack, 1);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"), "改回原名了");

  // 源目录里多了和新名字撞的：改名那步就拦下，文件原样不动
  seed();
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv");
  await applyRun(run2.id);
  await untilStatus(run2.id, ["done"]);
  const bad2 = listItems(run2.id).find((i) => i.status === "failed")!;
  assert.equal(bad2.errorKind, "rejected");
  assert.match(bad2.error, /源目录里已经有同名文件/);
  assert.equal(bad2.curPath, "", "还没动就拦下了");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"));
  // 放弃半路项时原名被占：不改回去，留给用户
  seed();
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  const run3 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run3.id, ["ready"]);
  await applyRun(run3.id);
  await untilStatus(run3.id, ["done"]);
  drive.failWriteOn = null;
  const half = listItems(run3.id).find((i) => i.status === "failed")!;
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  const r3 = await skipItems(run3.id, [half.id]);
  assert.equal(r3.skipped, 0);
  assert.match(r3.refused[0]?.reason ?? "", /原位置已经有同名文件/);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv"), "没动");
});

test("撤销时原位置又有了同名文件：记 rejected 不碰网盘，文件留在整理后的位置，可以放弃撤销", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.stats.notReverted, 1);
  assert.equal(reverted.stats.failedByKind.rejected, 1);
  const ep2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(ep2.status, "done");
  assert.equal(ep2.errorKind, "rejected");
  assert.match(ep2.error, /原位置已经有同名文件/);
  assert.ok(drive.tree.get(ep2.dstPath), "还在整理后的位置");
  assert.ok(!drive.log.some((l) => l.startsWith(`move ${ep2.dstPath}`)), "没去撞");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "其它退回了");
  const r = await skipItems(run.id, [ep2.id]);
  assert.equal(r.skipped, 1);
  assert.equal(getRunDetail(run.id).run.stats.notReverted, 0);
});

test("连环改名（集偏移）：目标名被本轮别的项占着不算撞名，按依赖顺序一个个改", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run.id, ["ready"]);
  const u = getRunDetail(run.id).units[0];
  // E01 → E02、E02 → E03：E01 的目标名正被 E02 占着
  await patchUnit(run.id, u.key, { episodeOffset: 1 });
  const plan = getRunDetail(run.id).items.filter((i) => i.action === "move" && i.kind === "video").map((i) => [baseOf(i.srcPath), baseOf(i.dstPath)]);
  assert.deepEqual(plan, [["BEEF.S01E01.1080p.WEB-DL.mkv", "怒呛人生 - S01E02.mkv"], ["BEEF.S01E02.1080p.WEB-DL.mkv", "怒呛人生 - S01E03.mkv"]]);
  // 先把源目录里造一个「本轮别的项会占着」的局面：E02 已经原地改成了 E01 的目标名（模拟上一轮改到一半）
  drive.tree.move("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv", "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv");
  const e2 = getRunDetail(run.id).items.find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  updateItem(e2.id, { curPath: "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv" });
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0, "没有被当成撞名");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E03.mkv"));
  const renames = drive.log.filter((l) => l.startsWith("rename ") && l.includes(" -> "));
  assert.ok(renames.findIndex((l) => l.endsWith("-> 怒呛人生 - S01E03.mkv")) < renames.findIndex((l) => l.endsWith("-> 怒呛人生 - S01E02.mkv")), "占着名字的那项先改");
});

test("上次挪到一半没记账：文件已经在目标目录里就只记账，不再挪也不算撞名", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const ep1 = getRunDetail(run.id).items.find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  // 模拟进程在 write.move 之后、记账之前崩了：文件已经在目标位置，账上还是 pending + curPath
  drive.tree.addDir("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  drive.tree.move(ep1.srcPath, ep1.dstPath);
  updateItem(ep1.id, { curPath: "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv" });
  const moves = drive.calls.move;
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  const after = listItems(run.id).find((i) => i.id === ep1.id)!;
  assert.equal(after.status, "done");
  assert.equal(after.curPath, "");
  assert.ok(!drive.log.some((l) => l.startsWith(`move /tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv`)), "没有再挪一次");
  assert.ok(drive.calls.move > moves, "别的项照常挪");
  assert.equal(localRead("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm"), "/mnt/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv", "本地镜像补上了");
});

test("撤销阶段放弃一个执行时改了名没挪走的项：一样先改回原名；放弃掉的失败 mkdir 撤销时不碰同名目录", async () => {
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  drive.failWriteOn = null;
  const half = listItems(run.id).find((i) => i.status === "failed")!;
  assert.ok(half.curPath, "原地改了名没挪走");
  // 撤销被风控打断在别的项上：E02 还是 failed + curPath，run 进了撤销阶段
  drive.failWriteOn = (op) => (op === "move" ? new Error("blocked by 405") : null);
  await revertRun(run.id);
  await untilStatus(run.id, ["failed"]);
  drive.failWriteOn = null;
  assert.equal(getRunDetail(run.id).run.stage, "revert");
  const r = await skipItems(run.id, [half.id]);
  assert.equal(r.renamedBack, 1, "撤销阶段也先改回原名");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"));
  assert.equal(listItems(run.id).find((i) => i.id === half.id)!.curPath, "");

  // 放弃掉的失败 mkdir：从没建过，后来别人建了同名目录，撤销时不能把它当自建目录删掉
  seed();
  drive.failWriteOn = (op, p) => (op === "mkdir" && p.endsWith("Season 01") ? new Error("115：文件名不能包含特殊字符") : null);
  const run2 = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  await untilStatus(run2.id, ["done"]);
  drive.failWriteOn = null;
  const mk = listItems(run2.id).find((i) => i.action === "mkdir" && i.dstPath.endsWith("Season 01"))!;
  await skipItems(run2.id, [mk.id]);
  drive.tree.addDir("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  await revertRun(run2.id);
  await untilStatus(run2.id, ["reverted"]);
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01"), "别人建的同名目录还在");
});

test("已规范命名的目录带集偏移整理：撤销也按依赖倒序退回，跨目录挪回的中间名不撞自己人", async () => {
  drive.tree.addDir("/tv/done/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  for (const e of ["01", "02", "03"]) drive.tree.addFile(`/tv/done/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E${e}.mkv`);
  const run = await createRun({ taskId: "t1", subPath: "done" });
  await untilStatus(run.id, ["ready"]);
  const u = getRunDetail(run.id).units.find((x) => x.match?.tmdbId === 153312)!;
  await patchUnit(run.id, u.key, { episodeOffset: 1 });
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  for (const e of ["02", "03", "04"]) assert.ok(drive.tree.get(`/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E${e}.mkv`), `E${e} 到位`);
  const mark = drive.log.length;
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.stats.notReverted, 0, "全部退回");
  assert.equal(reverted.stats.failed, 0);
  for (const e of ["01", "02", "03"]) assert.ok(drive.tree.get(`/tv/done/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E${e}.mkv`), `E${e} 退回原名`);
  assert.equal(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]"), undefined, "自建目录空了删掉");
  // E02←E03 的中间名 S01E03 会被 E03←E04 的原名占住：得先退 E01←E02、再 E02←E03、最后 E03←E04
  const backs = drive.log.slice(mark).filter((l) => l.startsWith("rename ") && l.includes(" -> "));
  const at = (e: string) => backs.findIndex((l) => l.endsWith(`-> 怒呛人生 - S01E${e}.mkv`));
  assert.ok(at("01") >= 0 && at("01") < at("02") && at("02") < at("03"), `退回顺序：${backs.join(" | ")}`);
});

test("目录已在库里只改集号（原地改名的连环）：撤销时按依赖倒序改回", async () => {
  drive.tree.addDir("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  for (const e of ["01", "02", "03"]) drive.tree.addFile(`/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E${e}.mkv`);
  const run = await createRun({ taskId: "t1", subPath: "怒呛人生 (2023) [tmdbid=153312]" });
  await untilStatus(run.id, ["ready"]);
  const u = getRunDetail(run.id).units.find((x) => x.match?.tmdbId === 153312)!;
  await patchUnit(run.id, u.key, { episodeOffset: 1 });
  const plan = getRunDetail(run.id).items.filter((i) => i.kind === "video");
  assert.deepEqual(plan.map((i) => i.action), ["rename", "rename", "rename"]);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  for (const e of ["02", "03", "04"]) assert.ok(drive.tree.get(`/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E${e}.mkv`), `E${e} 改好`);
  const mark = drive.log.length;
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.stats.notReverted, 0, "全部退回");
  for (const e of ["01", "02", "03"]) assert.ok(drive.tree.get(`/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E${e}.mkv`), `E${e} 改回`);
  assert.equal(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E04.mkv"), undefined);
  const backs = drive.log.slice(mark).filter((l) => l.startsWith("rename ") && l.includes(" -> "));
  const at = (e: string) => backs.findIndex((l) => l.endsWith(`-> 怒呛人生 - S01E${e}.mkv`));
  assert.ok(at("01") >= 0 && at("01") < at("02") && at("02") < at("03"), `改回顺序：${backs.join(" | ")}`);
});

test("放弃了本地镜像失败的项再撤销：网盘上照样退回（放弃只是不再补本地），退回后不再是放弃状态", async () => {
  fs.writeFileSync(path.join(LOCAL, "怒呛人生 (2023) [tmdbid=153312]"), "占位");
  const run = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  const mirrors = listItems(run.id).filter((i) => i.errorKind === "mirror");
  assert.ok(mirrors.length >= 2);
  await skipItems(run.id, mirrors.map((i) => i.id));
  assert.ok(listItems(run.id).filter((i) => i.givenUp).length >= 2);
  assert.equal(getRunDetail(run.id).revertable.ok, true, "网盘上挪过的项放弃了本地也还能撤");
  fs.rmSync(path.join(LOCAL, "怒呛人生 (2023) [tmdbid=153312]"));
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.stats.notReverted, 0);
  const ep1 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  assert.equal(ep1.status, "reverted");
  assert.equal(ep1.givenUp, false, "退回之后不再是放弃状态");
  assert.equal(ep1.errorKind, "");
  assert.ok(drive.tree.get(ep1.srcPath), "放弃过的项也退回了原处");
  assert.equal(drive.tree.get(ep1.dstPath), undefined);
  assert.ok(localExists("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "本地 strm 在原处");
  assert.equal(getRunDetail(run.id).revertable.ok, false);
});

test("连环改名里给我腾名字的那一项撞了别人：等它的那项不再改（名字还被占着，115 会悄悄变成 (1)），记 rejected 说明原因", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run.id, ["ready"]);
  const u = getRunDetail(run.id).units[0];
  await patchUnit(run.id, u.key, { episodeOffset: 1 });
  // E02 已经原地改成了 E01 的目标名（上一轮改到一半），而它自己的目标名被别人占了
  drive.tree.move("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv", "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv");
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E03.mkv");
  const e2 = getRunDetail(run.id).items.find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  updateItem(e2.id, { curPath: "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv" });
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.ok(done.stats.failed >= 2, `E01 / E02 都失败（${done.stats.failed}）`);
  const e1 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  assert.equal(e1.errorKind, "rejected");
  assert.match(e1.error, /没改成/);
  assert.equal(listItems(run.id).find((i) => i.id === e2.id)!.errorKind, "rejected");
  assert.ok(!drive.log.some((l) => l.startsWith("rename /tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv")), "没去改 E01 的名");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "E01 原地没动");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv"), "E02 还在中间名上");
});

test("跨目录移动三个串成链：目标名被本轮别的项占着的等它挪走，一轮解不开就再来一轮，不按撞名记", async () => {
  for (const d of ["a", "b", "c", "d"]) drive.tree.addDir(`/tv/${d}`);
  const x = drive.tree.addFile("/tv/a/f.mkv");
  const y = drive.tree.addFile("/tv/b/f.mkv");
  const z = drive.tree.addFile("/tv/c/f.mkv");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  // 直接改清单：X 要去的名字被 Y 占着，Y 要去的被 Z 占着；按目标目录分批的顺序，一轮只能解开 Z
  const base = { unitKey: "", kind: "video" as const, action: "move" as const, reason: "", status: "pending" as const, error: "" };
  replaceItems(run.id, [
    { id: "x", seq: 0, ...base, srcPath: "/tv/a/f.mkv", dstPath: "/tv/b/f.mkv", nodeId: x.id },
    { id: "y", seq: 1, ...base, srcPath: "/tv/b/f.mkv", dstPath: "/tv/c/f.mkv", nodeId: y.id },
    { id: "z", seq: 2, ...base, srcPath: "/tv/c/f.mkv", dstPath: "/tv/d/f.mkv", nodeId: z.id },
  ]);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0, listItems(run.id).map((i) => i.error).join(" | "));
  assert.ok(!drive.tree.get("/tv/a/f.mkv") && drive.tree.get("/tv/b/f.mkv") && drive.tree.get("/tv/c/f.mkv") && drive.tree.get("/tv/d/f.mkv"));
  assert.deepEqual(
    drive.log.filter((l) => l.startsWith("move ") && l.includes(" -> ")),
    ["move /tv/c/f.mkv -> /tv/d", "move /tv/b/f.mkv -> /tv/c", "move /tv/a/f.mkv -> /tv/b"],
    "占着名字的先挪走",
  );
});

test("进程重启时 run 停在 applying 但清单上已经没事：收口成 done 并做收尾（追更目录改写），而不是标失败卡住", async () => {
  insertShareFollow({
    id: "f5", name: "BEEF", libraryId: null, shareUrl: "", shareCode: "abe", receiveCode: "", watchCid: "0", watchPath: "", scope: [""],
    taskId: "t1", subPath: "inbox/BEEF.S01.1080p", enabled: true, intervalMinutes: 60, status: "idle", lastError: "", errorStreak: 0,
    lastCheckedAt: null, lastChangeAt: null, nextCheckAt: 0, known: [], recent: [], createdAt: 1, updatedAt: 1,
  });
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(getShareFollow("f5")!.subPath, "怒呛人生 (2023) [tmdbid=153312]");
  // 模拟最后一项做完、run 状态还没写就重启：状态回到 applying，收尾没做过
  replaceShareFollows([{ ...getShareFollow("f5")!, subPath: "inbox/BEEF.S01.1080p" }]);
  updateRun(run.id, { status: "applying" });
  assert.equal(reconcileInterruptedRuns(), 1);
  const detail = getRunDetail(run.id);
  assert.equal(detail.run.status, "done");
  assert.equal(detail.run.error, "");
  assert.equal(getShareFollow("f5")!.subPath, "怒呛人生 (2023) [tmdbid=153312]", "收尾做了");
  assert.equal(detail.revertable.ok, true);
  // 真没做完的还是标失败，用户可以再执行
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  updateRun(run2.id, { status: "applying" });
  assert.equal(reconcileInterruptedRuns(), 1);
  assert.equal(getRunDetail(run2.id).run.status, "failed");
  assert.match(getRunDetail(run2.id).run.error, /进程重启/);
});

test("放弃一部分之后还剩 stale / rejected 的失败项：run 不能收口成 done；都放弃了才收口", async () => {
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  drive.tree.remove("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  drive.failWriteOn = null;
  const e1 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  const e2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(e1.errorKind, "stale");
  assert.equal(e2.errorKind, "transient");
  // 像进程重启那样把 run 标成失败：放弃临时失败的那项之后 stale 的还在，不能算收口
  updateRun(run.id, { status: "failed", error: "进程重启" });
  await skipItems(run.id, [e2.id]);
  assert.equal(getRunDetail(run.id).run.status, "failed", "stale 的还没处理");
  assert.ok(getRunDetail(run.id).groups.some((g) => g.key === "stale"));
  await skipItems(run.id, [e1.id]);
  assert.equal(getRunDetail(run.id).run.status, "done");
  assert.equal(getRunDetail(run.id).run.error, "");
});

test("撤销时网盘说找不到（按文案归 stale）：项保持 done 记 stale，面板里有这一组，能继续撤销或放弃", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("object not found") : null);
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  drive.failWriteOn = null;
  const ep2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(ep2.status, "done");
  assert.equal(ep2.errorKind, "stale");
  assert.equal(reverted.stats.notReverted, 1);
  const g = getRunDetail(run.id).groups.find((x) => x.key === "stale");
  assert.ok(g && g.retry && g.skip && g.itemIds.includes(ep2.id), "撤销阶段的 stale 也有一组");
  const r = await skipItems(run.id, [ep2.id]);
  assert.equal(r.skipped, 1);
  assert.equal(getRunDetail(run.id).run.stats.notReverted, 0);
  assert.equal(getRunDetail(run.id).groups.length, 0);
});

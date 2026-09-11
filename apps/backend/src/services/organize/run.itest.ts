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
import { __test_resetOrganize, bumpOwnHit, findOwnOperation, listItems, listUnits, recallMatch, rememberMatch } from "../../db/repositories/organize.js";
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
import { applyRun, cancelRun, createRun, getRunDetail, patchUnit, revertRun, setOrganizeDeps, waitForRun } from "./run.js";

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
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"), "同批的其它项照常");

  seed();
  drive.failWriteOn = (op) => (op === "rename" ? new Error("blocked by 405") : null);
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  const failed = await untilStatus(run2.id, ["failed"]);
  assert.match(failed.error, /网盘拒绝了请求/);
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
  assert.ok(inner.calls.listDir <= 3, `每个父目录只列一次（实际 ${inner.calls.listDir}）`);
});

test("取消：预览中取消 → cancelled；同一任务同时只有一次整理", async () => {
  drive.beforeCall = () => new Promise((r) => setTimeout(r, 30));
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await assert.rejects(createRun({ taskId: "t1" }), /进行中/);
  cancelRun(run.id);
  const r = await untilStatus(run.id, ["cancelled", "ready"]);
  assert.ok(r.status === "cancelled" || r.status === "ready");
});

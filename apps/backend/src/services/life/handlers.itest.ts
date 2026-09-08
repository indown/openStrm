/**
 * handlers 的离线集成测试：事件已经带着绝对路径，网盘用 FakeDrive，可以真刀真枪地验证落盘行为。
 * 用例按顺序推进同一份本地状态（生成 → 改名 → 移动 → 删除），不能乱序。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/life/handlers.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { DATA_DIR } from "../../paths.js";
import type { ChangeEvent } from "../drive/types.js";
import { strmContent } from "../strm/naming.js";
import { FakeDrive } from "../../test/fake-drive.js";
import { handleCreate, handleMove, handleNewFolder, handleRemove, handleRename, type LifeContext } from "./handlers.js";

const account: AccountInfo = { accountType: "quark", name: "q", cookie: "x" };
const tasks: TaskDefinition[] = [
  { id: "t-tv", account: "q", accountType: "quark", originPath: "tv", targetPath: "handlers-itest/tv", strmPrefix: "/mnt/pan" },
];
const drive = new FakeDrive("quark", account);
const ctx: LifeContext = {
  provider: drive,
  tasks,
  settings: { strmExtensions: [".mkv", ".mp4"], downloadExtensions: [".nfo", ".jpg"] },
  eventModes: new Set(["create", "move", "rename", "remove"]),
  log: () => {},
};

let seq = 0;
const ev = (o: Partial<ChangeEvent> & Pick<ChangeEvent, "kind" | "path">): ChangeEvent => ({
  id: String(++seq),
  oldPath: null,
  isDir: false,
  nodeId: `n${seq}`,
  size: 1,
  at: 100,
  ...o,
});

const localRoot = path.join(DATA_DIR, "handlers-itest");
const tvDir = path.join(localRoot, "tv");
const strm = path.join(tvDir, "TestShow", "ep1.strm");
const renamed = path.join(tvDir, "TestShow", "ep1 rename.strm");
const moved = path.join(tvDir, "Other", "ep1 rename.strm");

before(() => {
  fs.rmSync(localRoot, { recursive: true, force: true });
  drive.tree.addDir("/tv/TestShow");
  drive.tree.addDir("/tv/Other");
  drive.tree.addDir("/misc");
});

after(() => {
  fs.rmSync(localRoot, { recursive: true, force: true });
});

test("新增事件生成 strm，内容与全量任务一致", async () => {
  const r = await handleCreate(ctx, ev({ kind: "create", path: "/tv/TestShow/ep1.mkv" }));
  assert.equal(r.status, "done", r.detail);
  assert.ok(fs.existsSync(strm), "strm 应已生成");
  assert.equal(fs.readFileSync(strm, "utf8"), "/mnt/pan/tv/TestShow/ep1.mkv", "内容必须与全量任务一致");
  assert.equal(r.changed, true, "生成了文件就该触发媒体库刷新");
});

test("非白名单扩展名跳过", async () => {
  const r = await handleCreate(ctx, ev({ kind: "create", path: "/tv/TestShow/readme.txt" }));
  assert.equal(r.status, "skipped");
  assert.equal(r.changed, false, "没落盘就不该惊动 Emby");
  assert.ok(!fs.existsSync(path.join(tvDir, "TestShow", "readme.strm")));
});

test("改名事件重命名本地 strm 并重写内容", async () => {
  const r = await handleRename(ctx, ev({ kind: "rename", path: "/tv/TestShow/ep1 rename.mkv", oldPath: "/tv/TestShow/ep1.mkv" }));
  assert.equal(r.status, "done", r.detail);
  assert.ok(!fs.existsSync(strm), "旧 strm 应已消失");
  assert.ok(fs.existsSync(renamed), "新 strm 应存在");
  assert.equal(fs.readFileSync(renamed, "utf8"), "/mnt/pan/tv/TestShow/ep1 rename.mkv");
});

test("移动事件搬运本地 strm、重写内容并清理空目录", async () => {
  const r = await handleMove(ctx, ev({ kind: "move", path: "/tv/Other/ep1 rename.mkv", oldPath: "/tv/TestShow/ep1 rename.mkv" }));
  assert.equal(r.status, "done", r.detail);
  assert.ok(fs.existsSync(moved), "应移动到 Other 下");
  assert.ok(!fs.existsSync(path.join(tvDir, "TestShow")), "空目录应被清理");
  assert.equal(fs.readFileSync(moved, "utf8"), "/mnt/pan/tv/Other/ep1 rename.mkv");
});

test("旧路径未知的移动退化成新增", async () => {
  const r = await handleMove(ctx, ev({ kind: "move", path: "/tv/Other/ep9.mkv", oldPath: null }));
  assert.equal(r.status, "done", r.detail);
  assert.equal(fs.readFileSync(path.join(tvDir, "Other", "ep9.strm"), "utf8"), "/mnt/pan/tv/Other/ep9.mkv");
  fs.rmSync(path.join(tvDir, "Other", "ep9.strm"));
});

test("移出监控范围 → 删本地；移入监控范围 → 当作新增", async () => {
  const out = await handleMove(ctx, ev({ kind: "move", path: "/misc/ep1 rename.mkv", oldPath: "/tv/Other/ep1 rename.mkv" }));
  assert.equal(out.status, "done", out.detail);
  assert.ok(!fs.existsSync(moved), "移出范围后本地应删除");
  const back = await handleMove(ctx, ev({ kind: "move", path: "/tv/Other/ep1 rename.mkv", oldPath: "/misc/ep1 rename.mkv" }));
  assert.equal(back.status, "done", back.detail);
  assert.equal(fs.readFileSync(moved, "utf8"), "/mnt/pan/tv/Other/ep1 rename.mkv");
});

test("删除事件移除本地 strm", async () => {
  const r = await handleRemove(ctx, ev({ kind: "remove", path: "/tv/Other/ep1 rename.mkv" }));
  assert.equal(r.status, "done", r.detail);
  assert.ok(!fs.existsSync(moved), "strm 应被删除");
});

test("eventModes 未开启时跳过", async () => {
  const readOnly: LifeContext = { ...ctx, eventModes: new Set(["create"]) };
  const r = await handleRemove(readOnly, ev({ kind: "remove", path: "/tv/Other/x.mkv" }));
  assert.equal(r.status, "skipped");
  assert.match(r.detail, /remove 模式未开启/);
});

test("监控范围外的路径跳过", async () => {
  const r = await handleCreate(ctx, ev({ kind: "create", path: "/misc/ep1.mkv" }));
  assert.equal(r.status, "skipped");
  assert.match(r.detail, /不在任何任务/);
});

test("拒绝整任务根目录删除", async () => {
  fs.mkdirSync(tvDir, { recursive: true });
  const r = await handleRemove(ctx, ev({ kind: "remove", path: "/tv", isDir: true }));
  assert.equal(r.status, "skipped");
  assert.ok(fs.existsSync(tvDir), "任务根目录必须还在");
});

test("新建目录事件不触发媒体库刷新", async () => {
  const r = await handleNewFolder(ctx, ev({ kind: "folder", path: "/tv/NewDir", isDir: true }));
  assert.equal(r.status, "done");
  assert.equal(r.changed, false);
});

test("新增目录：递归列网盘目录生成 strm，列过的每层都告诉网盘", async () => {
  drive.tree.addDir("/tv/Season");
  drive.tree.addFile("/tv/Season/e1.mkv");
  drive.tree.addDir("/tv/Season/extras");
  drive.tree.addFile("/tv/Season/extras/bonus.mp4");
  drive.tree.addFile("/tv/Season/notes.txt");
  const remembered: string[] = [];
  const spied: LifeContext = { ...ctx, provider: Object.assign(Object.create(drive), { rememberListing: (dir: string) => remembered.push(dir) }) };
  const r = await handleCreate(spied, ev({ kind: "create", path: "/tv/Season", isDir: true, nodeId: drive.tree.get("/tv/Season")!.id }));
  assert.equal(r.status, "done", r.detail);
  assert.match(r.detail, /strm 2 \/ 下载 0/);
  assert.equal(fs.readFileSync(path.join(tvDir, "Season", "e1.strm"), "utf8"), "/mnt/pan/tv/Season/e1.mkv");
  assert.equal(fs.readFileSync(path.join(tvDir, "Season", "extras", "bonus.strm"), "utf8"), "/mnt/pan/tv/Season/extras/bonus.mp4");
  assert.deepEqual(remembered, ["/tv/Season", "/tv/Season/extras"]);
});

test("目录改名：旧版 encodeURI 写的 strm 和新版按段编码的都能改写，并统一成新写法", async () => {
  const encTask: TaskDefinition = {
    id: "t-enc", account: "q", accountType: "quark", originPath: "enc", targetPath: "handlers-itest/enc",
    strmPrefix: "http://h:5244/d", enablePathEncoding: true,
  };
  const ctxEnc: LifeContext = { ...ctx, tasks: [encTask] };
  const oldDir = path.join(localRoot, "enc", "Tom & Jerry");
  const newDir = path.join(localRoot, "enc", "Tom & Jerry (1940)");
  fs.mkdirSync(oldDir, { recursive: true });
  // 旧版整体 encodeURI（& 没转）；新版按段 encodeURIComponent
  fs.writeFileSync(path.join(oldDir, "ep1 a.strm"), encodeURI("http://h:5244/d/enc/Tom & Jerry/ep1 a.mkv"));
  fs.writeFileSync(path.join(oldDir, "ep2 b.strm"), strmContent("http://h:5244/d", "enc/Tom & Jerry/ep2 b.mkv", true));

  const r = await handleRename(ctxEnc, ev({ kind: "rename", path: "/enc/Tom & Jerry (1940)", oldPath: "/enc/Tom & Jerry", isDir: true }));
  assert.equal(r.status, "done", r.detail);
  assert.ok(fs.existsSync(newDir) && !fs.existsSync(oldDir), "目录应已改名");
  const expect = (name: string) => `http://h:5244/d/enc/Tom%20%26%20Jerry%20(1940)/${name}`;
  assert.equal(fs.readFileSync(path.join(newDir, "ep1 a.strm"), "utf8"), expect("ep1%20a.mkv"), "旧写法的文件也要改写，且改成新编码");
  assert.equal(fs.readFileSync(path.join(newDir, "ep2 b.strm"), "utf8"), expect("ep2%20b.mkv"));
});

test("下载类文件（nfo）整个落盘，直链带的请求头一起发出去", async () => {
  // 直链换成本地桩；body 分两块发——收到第一块就 resolve 并退订的实现会把下载掐断、删掉 .part
  let seenCookie = "";
  const server = http.createServer((req, res) => {
    seenCookie = String(req.headers.cookie ?? "");
    res.writeHead(200, { "content-type": "text/plain", "content-length": "20" });
    res.write("0123456789");
    setTimeout(() => res.end("abcdefghij"), 20);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const nfo = path.join(tvDir, "TestShow", "ep1.nfo");
  drive.tree.addFile("/tv/TestShow/ep1.nfo");
  const withHeaders: LifeContext = {
    ...ctx,
    provider: Object.assign(Object.create(drive), {
      downloadLink: async () => ({ url: `${base}/ep1.nfo`, headers: { Cookie: "k=v" } }),
    }),
  };
  try {
    const r = await handleCreate(withHeaders, ev({ kind: "create", path: "/tv/TestShow/ep1.nfo", token: "fid-nfo" }));
    assert.equal(r.status, "done", r.detail);
    assert.match(r.detail, /^download: /);
    assert.equal(fs.readFileSync(nfo, "utf8"), "0123456789abcdefghij", "整个 body 都要写进正式文件");
    assert.ok(!fs.existsSync(`${nfo}.part`), "不能留下 .part");
    assert.equal(seenCookie, "k=v", "夸克直链要带 cookie 才能下");
    assert.equal(r.changed, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

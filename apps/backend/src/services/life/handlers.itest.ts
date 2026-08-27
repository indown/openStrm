/**
 * handlers 的离线集成测试：预先把父目录写进 path_cache，
 * 文件类事件就完全不需要打 115 接口，可以真刀真枪地验证落盘行为。
 *
 * 用例按顺序推进同一份本地状态（生成 → 改名 → 移动 → 删除），不能乱序。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/life/handlers.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import type { TaskDefinition } from "@openstrm/shared";
import { DATA_DIR } from "../../paths.js";
import { rememberPath } from "../cloud-115/path-resolver.js";
import type { LifeEvent } from "../cloud-115/life.js";
import {
  handleCreate,
  handleMove,
  handleNewFolder,
  handleRemove,
  handleRename,
  type LifeContext,
} from "./handlers.js";

const tasks: TaskDefinition[] = [
  { id: "t-tv", account: "115", accountType: "115", originPath: "tv", targetPath: "tv", strmPrefix: "/mnt/pan" },
];

const ctx: LifeContext = {
  accountInfo: { name: "115", cookie: "x", accountType: "115" },
  tasks,
  settings: { strmExtensions: [".mkv", ".mp4"], downloadExtensions: [".nfo", ".jpg"] },
  eventModes: new Set(["create", "move", "rename", "remove"]),
  log: () => {},
};

const ev = (o: Partial<LifeEvent>): LifeEvent =>
  ({
    id: "1", type: 2, file_category: 1, file_id: "9001", parent_id: "1000",
    file_name: "ep1.mkv", file_size: 1, sha1: "", pick_code: "pc",
    update_time: 100, create_time: 100, ...o,
  }) as LifeEvent;

const tvDir = path.join(DATA_DIR, "tv");
const strm = path.join(tvDir, "TestShow", "ep1.strm");
const renamed = path.join(tvDir, "TestShow", "ep1 rename.strm");
const moved = path.join(tvDir, "Other", "ep1 rename.strm");

before(() => {
  fs.rmSync(tvDir, { recursive: true, force: true });
  // 父目录预置：/tv/TestShow (cid 1000)、/tv/Other (cid 1001)
  rememberPath({ fileId: "1000", parentId: "0", name: "TestShow", path: "/tv/TestShow", isDir: true, accountName: "115" });
  rememberPath({ fileId: "1001", parentId: "0", name: "Other", path: "/tv/Other", isDir: true, accountName: "115" });
});

test("上传事件生成 strm，内容与全量任务一致", async () => {
  const r = await handleCreate(ctx, ev({ type: 2 }));
  assert.equal(r.status, "done", r.detail);
  assert.ok(fs.existsSync(strm), "strm 应已生成");
  assert.equal(fs.readFileSync(strm, "utf8"), "/mnt/pan/tv/TestShow/ep1.mkv", "内容必须与全量任务一致");
  assert.equal(r.changed, true, "生成了文件就该触发媒体库刷新");
});

test("非白名单扩展名跳过", async () => {
  const r = await handleCreate(ctx, ev({ file_id: "9002", file_name: "readme.txt" }));
  assert.equal(r.status, "skipped");
  assert.equal(r.changed, false, "没落盘就不该惊动 Emby");
  assert.ok(!fs.existsSync(path.join(tvDir, "TestShow", "readme.strm")));
});

test("改名事件重命名本地 strm 并重写内容", async () => {
  const r = await handleRename(ctx, ev({ type: 24, file_name: "ep1 rename.mkv" }));
  assert.equal(r.status, "done", r.detail);
  assert.ok(!fs.existsSync(strm), "旧 strm 应已消失");
  assert.ok(fs.existsSync(renamed), "新 strm 应存在");
  assert.equal(fs.readFileSync(renamed, "utf8"), "/mnt/pan/tv/TestShow/ep1 rename.mkv");
});

test("移动事件搬运本地 strm、重写内容并清理空目录", async () => {
  const r = await handleMove(ctx, ev({ type: 6, parent_id: "1001", file_name: "ep1 rename.mkv" }));
  assert.equal(r.status, "done", r.detail);
  assert.ok(fs.existsSync(moved), "应移动到 Other 下");
  assert.ok(!fs.existsSync(path.join(tvDir, "TestShow")), "空目录应被清理");
  assert.equal(fs.readFileSync(moved, "utf8"), "/mnt/pan/tv/Other/ep1 rename.mkv");
});

test("删除事件移除本地 strm", async () => {
  const r = await handleRemove(ctx, ev({ type: 22, parent_id: "1001", file_name: "ep1 rename.mkv" }));
  assert.equal(r.status, "done", r.detail);
  assert.ok(!fs.existsSync(moved), "strm 应被删除");
});

test("eventModes 未开启时跳过", async () => {
  const readOnly: LifeContext = { ...ctx, eventModes: new Set(["create"]) };
  const r = await handleRemove(readOnly, ev({ type: 22, file_id: "9003" }));
  assert.equal(r.status, "skipped");
  assert.match(r.detail, /remove 模式未开启/);
});

test("监控范围外的路径跳过", async () => {
  rememberPath({ fileId: "2000", parentId: "0", name: "misc", path: "/misc", isDir: true, accountName: "115" });
  const r = await handleCreate(ctx, ev({ file_id: "9004", parent_id: "2000" }));
  assert.equal(r.status, "skipped");
  assert.match(r.detail, /不在任何任务/);
});

test("拒绝整任务根目录删除", async () => {
  rememberPath({ fileId: "3000", parentId: "0", name: "tv", path: "/tv", isDir: true, accountName: "115" });
  fs.mkdirSync(tvDir, { recursive: true });
  const r = await handleRemove(ctx, ev({ type: 22, file_category: 0, file_id: "3000", parent_id: "0", file_name: "tv" }));
  assert.equal(r.status, "skipped");
  assert.ok(fs.existsSync(tvDir), "任务根目录必须还在");
});

test("新建目录事件不触发媒体库刷新", async () => {
  // 只写缓存，不碰磁盘
  const r = await handleNewFolder(ctx, ev({ type: 17, file_category: 0, file_id: "4000", file_name: "NewDir" }));
  assert.equal(r.status, "done");
  assert.equal(r.changed, false, "只写缓存不该触发刷新");
});

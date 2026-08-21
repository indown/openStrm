/**
 * handlers 的离线集成测试：预先把父目录写进 path_cache，
 * 文件类事件就完全不需要打 115 接口，可以真刀真枪地验证落盘行为。
 *
 * 需要 CONFIG_DIR / DATA_DIR 指向临时目录后再运行：
 *   CONFIG_DIR=... DATA_DIR=... npx tsx src/services/life/handlers.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TaskDefinition } from "@openstrm/shared";
import { DATA_DIR } from "../../paths.js";
import { rememberPath } from "../cloud-115/path-resolver.js";
import type { LifeEvent } from "../cloud-115/life.js";
import {
  handleCreate,
  handleMove,
  handleRemove,
  handleRename,
  type LifeContext,
} from "./handlers.js";

let pass = 0;
const lines: string[] = [];

const tasks: TaskDefinition[] = [
  { id: "t-tv", account: "115", accountType: "115", originPath: "tv", targetPath: "tv", strmPrefix: "/mnt/pan" },
];

const ctx: LifeContext = {
  accountInfo: { name: "115", cookie: "x", accountType: "115" },
  tasks,
  settings: { strmExtensions: [".mkv", ".mp4"], downloadExtensions: [".nfo", ".jpg"] },
  eventModes: new Set(["create", "move", "rename", "remove"]),
  log: (level, msg) => lines.push(`${level}: ${msg}`),
};

const ev = (o: Partial<LifeEvent>): LifeEvent =>
  ({
    id: "1", type: 2, file_category: 1, file_id: "9001", parent_id: "1000",
    file_name: "ep1.mkv", file_size: 1, sha1: "", pick_code: "pc",
    update_time: 100, create_time: 100, ...o,
  }) as LifeEvent;

const tvDir = path.join(DATA_DIR, "tv");
fs.rmSync(tvDir, { recursive: true, force: true });

// 父目录预置：/tv/TestShow (cid 1000)、/tv/Other (cid 1001)
rememberPath({ fileId: "1000", parentId: "0", name: "TestShow", path: "/tv/TestShow", isDir: true, accountName: "115" });
rememberPath({ fileId: "1001", parentId: "0", name: "Other", path: "/tv/Other", isDir: true, accountName: "115" });

async function main() {
  const strm = path.join(tvDir, "TestShow", "ep1.strm");

  // 1. 上传文件 → 生成 strm
  let r = await handleCreate(ctx, ev({ type: 2 }));
  assert.equal(r.status, "done", r.detail);
  assert.ok(fs.existsSync(strm), "strm 应已生成");
  assert.equal(
    fs.readFileSync(strm, "utf8"),
    "/mnt/pan/tv/TestShow/ep1.mkv",
    "内容必须与全量任务一致",
  );
  pass++; console.log("  ok  上传事件生成 strm，内容与全量任务一致");

  // 2. 白名单外的扩展名不生成
  r = await handleCreate(ctx, ev({ file_id: "9002", file_name: "readme.txt" }));
  assert.equal(r.status, "skipped");
  assert.ok(!fs.existsSync(path.join(tvDir, "TestShow", "readme.strm")));
  pass++; console.log("  ok  非白名单扩展名跳过");

  // 3. 改名 → 本地跟着改名，内容同步更新
  r = await handleRename(ctx, ev({ type: 24, file_name: "ep1 rename.mkv" }));
  assert.equal(r.status, "done", r.detail);
  const renamed = path.join(tvDir, "TestShow", "ep1 rename.strm");
  assert.ok(!fs.existsSync(strm), "旧 strm 应已消失");
  assert.ok(fs.existsSync(renamed), "新 strm 应存在");
  assert.equal(fs.readFileSync(renamed, "utf8"), "/mnt/pan/tv/TestShow/ep1 rename.mkv");
  pass++; console.log("  ok  改名事件重命名本地 strm 并重写内容");

  // 4. 移动到另一个目录 → 本地跟着移动，旧空目录被清掉
  r = await handleMove(ctx, ev({ type: 6, parent_id: "1001", file_name: "ep1 rename.mkv" }));
  assert.equal(r.status, "done", r.detail);
  const moved = path.join(tvDir, "Other", "ep1 rename.strm");
  assert.ok(fs.existsSync(moved), "应移动到 Other 下");
  assert.ok(!fs.existsSync(path.join(tvDir, "TestShow")), "空目录应被清理");
  assert.equal(fs.readFileSync(moved, "utf8"), "/mnt/pan/tv/Other/ep1 rename.mkv");
  pass++; console.log("  ok  移动事件搬运本地 strm、重写内容并清理空目录");

  // 5. 删除 → 本地文件消失
  r = await handleRemove(ctx, ev({ type: 22, parent_id: "1001", file_name: "ep1 rename.mkv" }));
  assert.equal(r.status, "done", r.detail);
  assert.ok(!fs.existsSync(moved), "strm 应被删除");
  pass++; console.log("  ok  删除事件移除本地 strm");

  // 6. 事件模式关掉后不应有任何动作
  const readOnly: LifeContext = { ...ctx, eventModes: new Set(["create"]) };
  r = await handleRemove(readOnly, ev({ type: 22, file_id: "9003" }));
  assert.equal(r.status, "skipped");
  assert.match(r.detail, /remove 模式未开启/);
  pass++; console.log("  ok  eventModes 未开启时跳过");

  // 7. 不在任何任务 originPath 下的路径不处理
  rememberPath({ fileId: "2000", parentId: "0", name: "misc", path: "/misc", isDir: true, accountName: "115" });
  r = await handleCreate(ctx, ev({ file_id: "9004", parent_id: "2000" }));
  assert.equal(r.status, "skipped");
  assert.match(r.detail, /不在任何任务/);
  pass++; console.log("  ok  监控范围外的路径跳过");

  // 8. 拒绝把任务根目录整个删掉
  rememberPath({ fileId: "3000", parentId: "0", name: "tv", path: "/tv", isDir: true, accountName: "115" });
  fs.mkdirSync(tvDir, { recursive: true });
  r = await handleRemove(ctx, ev({ type: 22, file_category: 0, file_id: "3000", parent_id: "0", file_name: "tv" }));
  assert.equal(r.status, "skipped");
  assert.ok(fs.existsSync(tvDir), "任务根目录必须还在");
  pass++; console.log("  ok  拒绝整任务根目录删除");

  console.log(`\n${pass} passed`);
}

main().catch((err) => {
  console.error(err);
  console.error("\n--- handler logs ---\n" + lines.join("\n"));
  process.exit(1);
});

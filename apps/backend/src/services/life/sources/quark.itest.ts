/**
 * 直接驱动快照源的 pull：首轮建快照、增删改名各出什么事件、整个目录被清空能收敛、
 * 大比例删除先压一轮再放。网盘是 FakeDrive，快照走真库。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/life/sources/quark.itest.ts
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { deleteDriveSnapshots, readDriveSnapshot } from "../../../db/repositories/life.js";
import type { ChangeCursor, ChangeEvent } from "../../drive/types.js";
import { FakeDrive } from "../../../test/fake-drive.js";
import { __test_resetQuarkSnapshotSource, QuarkSnapshotSource, type SnapEntry } from "./quark.js";

const account: AccountInfo = { accountType: "quark", name: "snap", cookie: "c" };
const tasks: TaskDefinition[] = [{ id: "t", account: "snap", accountType: "quark", originPath: "kk", targetPath: "snap-itest", strmPrefix: "/mnt" }];
let drive: FakeDrive;
let source: QuarkSnapshotSource;
let warned: string[];
const brief = (events: ChangeEvent[]) => events.map((e) => `${e.kind} ${e.oldPath ? `${e.oldPath} -> ` : ""}${e.path}`);

async function pull(cursor: ChangeCursor = { time: 1, id: "latest" }) {
  return source.pull(cursor, { tasks, signal: new AbortController().signal, log: (level, msg) => level === "warn" && warned.push(msg) });
}

beforeEach(() => {
  deleteDriveSnapshots("snap");
  __test_resetQuarkSnapshotSource();
  drive = new FakeDrive("quark", account);
  source = new QuarkSnapshotSource(drive);
  warned = [];
  drive.tree.addDir("/kk");
});

after(() => deleteDriveSnapshots("snap"));

test("首轮只建快照；之后新增 / 改名 / 移动 / 删除各出一条，目录级只报最上层；快照跟着更新", async () => {
  drive.tree.addDir("/kk/S1");
  drive.tree.addFile("/kk/S1/e1.mkv", { size: 1 });
  const first = await pull();
  assert.deepEqual(first.events, []);
  assert.equal(readDriveSnapshot<SnapEntry>("snap", "/kk")?.entries.length, 2);

  drive.tree.addFile("/kk/S1/e2.mkv", { size: 1 });
  drive.tree.addDir("/kk/S2");
  drive.tree.addFile("/kk/S2/x.mkv");
  drive.tree.move("/kk/S1/e1.mkv", "/kk/S1/e1 v2.mkv");
  const second = await pull();
  assert.deepEqual(brief(second.events).sort(), ["create /kk/S1/e2.mkv", "create /kk/S2", "rename /kk/S1/e1.mkv -> /kk/S1/e1 v2.mkv"]);
  assert.ok(second.events.every((e) => e.id.startsWith("q:snap:") && e.token === e.nodeId));

  drive.tree.move("/kk/S2", "/kk/S1/S2");
  drive.tree.remove("/kk/S1/e2.mkv");
  const third = await pull();
  assert.deepEqual(brief(third.events).sort(), ["move /kk/S2 -> /kk/S1/S2", "remove /kk/S1/e2.mkv"]);
  assert.equal(readDriveSnapshot<SnapEntry>("snap", "/kk")?.entries.length, 4);
});

test("all 模式首轮把现有条目全当新增（目录只报顶层）", async () => {
  drive.tree.addDir("/kk/S1");
  drive.tree.addFile("/kk/S1/e1.mkv");
  drive.tree.addFile("/kk/top.mkv");
  const r = await pull({ time: 0, id: "all" });
  assert.deepEqual(brief(r.events).sort(), ["create /kk/S1", "create /kk/top.mkv"]);
});

test("小目录整个被清空：列到 0 条就是真空了，下一轮直接出删除事件（不会永远跳过）", async () => {
  drive.tree.addDir("/kk/S1");
  for (let i = 1; i <= 7; i++) drive.tree.addFile(`/kk/S1/e${i}.mkv`);
  await pull();
  drive.tree.remove("/kk/S1");
  const r = await pull();
  assert.deepEqual(brief(r.events), ["remove /kk/S1"]);
  assert.deepEqual(warned, []);
  assert.equal(readDriveSnapshot<SnapEntry>("snap", "/kk")?.entries.length, 0);
});

test("大目录一轮少了三成以上：第一轮只告警不删、快照里留着；第二轮还是这样才出删除事件；中途恢复就作罢", async () => {
  drive.tree.addDir("/kk/S1");
  for (let i = 1; i <= 12; i++) drive.tree.addFile(`/kk/S1/e${i}.mkv`);
  await pull();
  drive.tree.remove("/kk/S1");
  const first = await pull();
  assert.deepEqual(first.events, [], "第一轮压下");
  assert.match(warned[0] ?? "", /13\/13 项消失.*先不删/);
  assert.equal(readDriveSnapshot<SnapEntry>("snap", "/kk")?.entries.length, 13, "被压下的删除留在快照里");
  const second = await pull();
  assert.deepEqual(brief(second.events), ["remove /kk/S1"], "第二轮放行");
  assert.match(warned[1] ?? "", /连续两轮/);
  assert.equal(readDriveSnapshot<SnapEntry>("snap", "/kk")?.entries.length, 0);

  // 再来一次：压下之后目录原样回来了（同样的 id，比如列目录抖了一下）→ 什么都不报，计数清零，下次再大删还是先压
  drive.tree.addDir("/kk/S1");
  for (let i = 1; i <= 12; i++) drive.tree.addFile(`/kk/S1/e${i}.mkv`);
  await pull();
  const kept = [...drive.tree.nodes].filter(([p]) => p === "/kk/S1" || p.startsWith("/kk/S1/"));
  drive.tree.remove("/kk/S1");
  await pull();
  for (const [p, node] of kept) drive.tree.nodes.set(p, node);
  const back = await pull();
  assert.deepEqual(back.events, [], "原样回来了就当没发生");
  drive.tree.remove("/kk/S1");
  const again = await pull();
  assert.deepEqual(again.events, [], "上一轮已恢复，这轮的大删除重新从压一轮开始");
});

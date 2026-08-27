/**
 * 执行历史的日志追加：批量、保序、超过 5000 行只留最近 3000。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/task-history.itest.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { addLogsToTaskExecution, createTaskExecution, deleteTaskExecution, getTaskExecution } from "./task-history.js";

const TASK = "history-itest-task";
const created: string[] = [];

function newExecution() {
  const e = createTaskExecution(TASK, { account: "a", originPath: "/o", targetPath: "t" });
  created.push(e.id);
  return e;
}

after(() => {
  for (const id of created) deleteTaskExecution(id);
});

test("批量追加保序，空批不写", () => {
  const e = newExecution();
  addLogsToTaskExecution(e.id, []);
  addLogsToTaskExecution(e.id, ["1", "2"]);
  addLogsToTaskExecution(e.id, ["3"]);
  const stored = getTaskExecution(e.id)!;
  assert.deepEqual(stored.logs, ["1", "2", "3"]);
});

test("超过 5000 行只留最近 3000", () => {
  const e = newExecution();
  const lines = Array.from({ length: 5001 }, (_, i) => `line-${i}`);
  addLogsToTaskExecution(e.id, lines);
  const stored = getTaskExecution(e.id)!;
  assert.equal(stored.logs.length, 3000);
  assert.equal(stored.logs[0], "line-2001");
  assert.equal(stored.logs.at(-1), "line-5000");
});

test("不存在的执行 id 静默忽略", () => {
  assert.doesNotThrow(() => addLogsToTaskExecution("nope", ["x"]));
});

/**
 * 执行历史路由：列表不带 logs，详情才带；不存在的 id → 404。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/task-history/task-history.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import taskHistoryRoute from "./index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { addLogsToTaskExecution, createTaskExecution, deleteTaskExecution } from "../../services/task-history.js";

let app: FastifyInstance;
let auth: Record<string, string>;
const TASK = "history-route-itest";
let executionId = "";

before(async () => {
  await writeAuthPassword("history-itest-pw");
  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(taskHistoryRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };

  const e = createTaskExecution(TASK, { account: "a", originPath: "/o", targetPath: "t" });
  executionId = e.id;
  addLogsToTaskExecution(executionId, ['{"filePath":"a.mkv","percent":100}', '{"done":true}']);
});

after(async () => {
  await app.close();
  deleteTaskExecution(executionId);
  await writeAuthPassword(DEFAULT_AUTH.password);
});

test("GET /api/taskHistory：列表里的记录没有 logs 字段", async () => {
  const res = await app.inject({ method: "GET", url: `/api/taskHistory?taskId=${TASK}`, headers: auth });
  assert.equal(res.statusCode, 200);
  const rows = res.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, executionId);
  assert.equal(rows[0].status, "running");
  assert.equal("logs" in rows[0], false, "列表不该带日志");

  const all = (await app.inject({ method: "GET", url: "/api/taskHistory", headers: auth })).json();
  assert.ok(all.every((r: Record<string, unknown>) => !("logs" in r)));
});

test("GET /api/taskHistory/:executionId：详情带 logs；不存在 → 404", async () => {
  const res = await app.inject({ method: "GET", url: `/api/taskHistory/${executionId}`, headers: auth });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().logs, ['{"filePath":"a.mkv","percent":100}', '{"done":true}']);
  assert.equal(res.json().taskInfo.account, "a");

  const missing = await app.inject({ method: "GET", url: "/api/taskHistory/nope", headers: auth });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().message, "Execution not found");
});

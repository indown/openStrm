/**
 * 任务日志 SSE：没在跑的任务 404 而不是挂着；在跑的先补发历史行再推实时进度，结束时关流。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/task/log.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Subject, Subscription } from "rxjs";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import logRoute from "./log.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { registerRunningTask, unregisterRunningTask, type DownloadProgress } from "../../services/task/registry.js";

let app: FastifyInstance;
let headers: Record<string, string>;

before(async () => {
  await writeAuthPassword("log-itest-pw");
  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(logRoute);
  await app.ready();
  headers = {
    authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}`,
    accept: "text/event-stream",
  };
});

after(async () => {
  await app.close();
  await writeAuthPassword(DEFAULT_AUTH.password);
});

test("没在跑的任务：SSE 请求也 404，不写事件流头", async () => {
  const res = await app.inject({ method: "GET", url: "/api/taskLog/nope", headers });
  assert.equal(res.statusCode, 404);
  assert.match(res.headers["content-type"] ?? "", /json/);
  assert.equal(res.json().message, "Task is not running");
});

test("在跑的任务：先补发历史行，再推实时进度，任务结束流就关", async () => {
  const subject = new Subject<DownloadProgress>();
  registerRunningTask("sse-task", { subject, subscription: new Subscription(), logs: ['{"filePath":"a.mkv","percent":100}'] });
  try {
    const pending = app.inject({ method: "GET", url: "/api/taskLog/sse-task", headers });
    // 让路由把历史行写出去、订阅挂上，再推一条实时的并结束
    await new Promise((r) => setTimeout(r, 50));
    subject.next({ filePath: "b.mkv", percent: 50 });
    subject.next({ done: true, overallPercent: "100.00" });
    subject.complete();

    const res = await pending;
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/event-stream/);
    const events = res.body
      .split("\n\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    assert.deepEqual(events, [
      { filePath: "a.mkv", percent: 100 },
      { filePath: "b.mkv", percent: 50 },
      { done: true, overallPercent: "100.00" },
    ]);
  } finally {
    unregisterRunningTask("sse-task");
  }
});

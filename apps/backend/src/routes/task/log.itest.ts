/**
 * 任务日志 SSE：没在跑的任务 404 而不是挂着；在跑的先补发历史行再推实时进度，结束时关流；
 * 启动中（拉目录树）的先发一条 starting、等注册进 running 再补发和推送，起不来就发一条 done 收尾。
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
import {
  registerRunningTask,
  releaseTaskStart,
  reserveTaskStart,
  unregisterRunningTask,
  type DownloadProgress,
} from "../../services/task/registry.js";

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

const sseEvents = (body: string) =>
  body
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);

test("启动中的任务：先发 starting，注册进 running 后补发历史行再推实时进度", async () => {
  reserveTaskStart("sse-starting");
  const subject = new Subject<DownloadProgress>();
  try {
    const pending = app.inject({ method: "GET", url: "/api/taskLog/sse-starting", headers });
    await new Promise((r) => setTimeout(r, 50));
    registerRunningTask("sse-starting", { subject, subscription: new Subscription(), logs: ['{"start":true,"total":1}'] });
    releaseTaskStart("sse-starting", { status: 200, message: "1 files to download" });
    await new Promise((r) => setTimeout(r, 50));
    subject.next({ filePath: "a.mkv", percent: 100 });
    subject.next({ done: true, status: "completed" });
    subject.complete();

    const res = await pending;
    assert.equal(res.statusCode, 200);
    const events = sseEvents(res.body);
    assert.equal(events[0].starting, true, "第一条是 starting");
    assert.equal(typeof events[0].at, "number");
    assert.deepEqual(events.slice(1), [
      { start: true, total: 1 },
      { filePath: "a.mkv", percent: 100 },
      { done: true, status: "completed" },
    ]);
  } finally {
    unregisterRunningTask("sse-starting");
  }
});

test("启动中起不来：release 带失败结果 → 一条 failed 的 done 收尾并关流", async () => {
  reserveTaskStart("sse-fail");
  const pending = app.inject({ method: "GET", url: "/api/taskLog/sse-fail", headers });
  await new Promise((r) => setTimeout(r, 50));
  releaseTaskStart("sse-fail", { status: 500, message: "读取 115 目录失败", details: "登录超时" });
  const res = await pending;
  const events = sseEvents(res.body);
  assert.equal(events.length, 2);
  assert.equal(events[0].starting, true);
  assert.equal(events[1].done, true);
  assert.equal(events[1].status, "failed");
  assert.equal(events[1].message, "读取 115 目录失败：登录超时");
});

test("启动中无事可做：200 但没注册 → 一条 completed 的 done，说明本地已是最新", async () => {
  reserveTaskStart("sse-nothing");
  const pending = app.inject({ method: "GET", url: "/api/taskLog/sse-nothing", headers });
  await new Promise((r) => setTimeout(r, 50));
  releaseTaskStart("sse-nothing", { status: 200, message: "no files to download" });
  const events = sseEvents((await pending).body);
  assert.equal(events[1].done, true);
  assert.equal(events[1].status, "completed");
  assert.match(String(events[1].message), /没有需要处理的文件/);
});

test("非 SSE 的探测请求：启动中返回 starting: true 而不是 404", async () => {
  reserveTaskStart("probe");
  try {
    const res = await app.inject({ method: "GET", url: "/api/taskLog/probe", headers: { ...headers, accept: "application/json" } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { message: "Task starting", taskId: "probe", starting: true });
  } finally {
    releaseTaskStart("probe", { status: 500, message: "x" });
  }
});

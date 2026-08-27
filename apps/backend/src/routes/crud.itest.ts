/**
 * task / account / settings 三组 CRUD 路由的闭环，以及它们和 cron 的联动。
 *
 * 钉住的行为：输入校验统一 400 + VALIDATION；任务 id 由服务端分配；增删改任务后
 * cron 立即重排（以前只在启动时同步一次）；设置按顶层键合并而不是整体替换。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/crud.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { registerErrorHandling } from "../plugins/error-handler.js";
import { authPlugin } from "../plugins/auth.js";
import { cronPlugin } from "../plugins/cron.js";
import taskRoute from "./task/index.js";
import accountRoute from "./account/index.js";
import settingsRoute from "./settings/index.js";
import { DEFAULT_AUTH } from "../db/defaults.js";
import { writeAuthPassword } from "../db/repositories/auth.js";
import { readAppSettings, replaceAppSettings } from "../db/repositories/settings.js";
import { listTasks, replaceTasks } from "../db/repositories/tasks.js";
import { listAccounts, replaceAccounts } from "../db/repositories/accounts.js";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { settings: AppSettings; tasks: TaskDefinition[]; accounts: AccountInfo[] };

before(async () => {
  baseline = { settings: readAppSettings(), tasks: listTasks(), accounts: listAccounts() };
  replaceTasks([]);
  replaceAccounts([]);
  // 默认口令下除改密外一律 403，先换掉
  await writeAuthPassword("crud-itest-pw");

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(cronPlugin);
  await app.register(taskRoute);
  await app.register(accountRoute);
  await app.register(settingsRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  await writeAuthPassword(DEFAULT_AUTH.password);
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth, payload: payload as Record<string, unknown> | undefined });

// ---- 任务 ----

let taskId = "";

test("没有 token 一律 401", async () => {
  const res = await app.inject({ method: "GET", url: "/api/task" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "UNAUTHORIZED");
});

test("POST /api/task：校验失败 → 400 VALIDATION，message 指向字段", async () => {
  const res = await call("POST", "/api/task", { account: "", originPath: "/tv" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "VALIDATION");
  assert.match(res.json().message, /^account/);
});

test("POST /api/task：服务端分配 UUID，带 cron 表达式的任务不重启就排上", async () => {
  const res = await call("POST", "/api/task", {
    account: "acc",
    originPath: "/tv",
    targetPath: "tv",
    cronExpression: "0 0 1 1 *",
  });
  assert.equal(res.statusCode, 201);
  taskId = res.json().id;
  assert.match(taskId, /^[0-9a-f-]{36}$/, "id 由服务端生成");
  assert.ok(app.cron.listJobs().some((j) => j.taskId === taskId), "建任务后 cron 应立即重排");
});

test("GET /api/task：列表带运行状态", async () => {
  const res = await call("GET", "/api/task");
  assert.equal(res.statusCode, 200);
  const row = res.json().find((t: { id: string }) => t.id === taskId);
  assert.equal(row.status, "pending");
  assert.equal(row.originPath, "/tv");
});

test("PUT /api/task：合并字段；清掉 cron 表达式后任务从 cron 摘掉", async () => {
  const res = await call("PUT", "/api/task", { id: taskId, strmPrefix: "/mnt/pan", cronExpression: "" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().strmPrefix, "/mnt/pan");
  assert.equal(res.json().originPath, "/tv", "没提交的字段要保留");
  assert.ok(!app.cron.listJobs().some((j) => j.taskId === taskId), "改掉表达式后不该还在 cron 里");
});

test("PUT /api/task：不存在的 id → 404", async () => {
  const res = await call("PUT", "/api/task", { id: "nope", strmPrefix: "/x" });
  assert.equal(res.statusCode, 404);
});

test("DELETE /api/task：删掉后再删 404", async () => {
  assert.equal((await call("DELETE", `/api/task?id=${taskId}`)).statusCode, 200);
  assert.equal((await call("DELETE", `/api/task?id=${taskId}`)).statusCode, 404);
  assert.equal(listTasks().length, 0);
});

// ---- 账号 ----

test("POST /api/account：115 账号缺 cookie → 400，且说明原因", async () => {
  const res = await call("POST", "/api/account", { accountType: "115", name: "main" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /cookie/);
});

test("POST /api/account：建成功 201；同名再建 409", async () => {
  const res = await call("POST", "/api/account", { accountType: "115", name: "main", cookie: "c1" });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().cookie, "c1");
  const dup = await call("POST", "/api/account", { accountType: "115", name: "main", cookie: "c2" });
  assert.equal(dup.statusCode, 409);
});

test("PUT /api/account：只改提交的字段，cookie 沿用旧值", async () => {
  const res = await call("PUT", "/api/account", { name: "main", note: "hello" });
  assert.equal(res.statusCode, 200);
  const stored = listAccounts().find((a) => a.name === "main") as AccountInfo & { note?: string; cookie?: string };
  assert.equal(stored.note, "hello");
  assert.equal(stored.cookie, "c1");
});

test("DELETE /api/account：删掉后再删 404", async () => {
  assert.equal((await call("DELETE", "/api/account?name=main")).statusCode, 200);
  assert.equal((await call("DELETE", "/api/account?name=main")).statusCode, 404);
});

// ---- 设置 ----

test("PUT /api/settings 按顶层键合并：只发 emby 不会抹掉 telegram", async () => {
  replaceAppSettings({
    ...readAppSettings(),
    telegram: { botToken: "t", chatId: "c" },
    emby: { url: "http://old", apiKey: "" },
  });
  const res = await call("PUT", "/api/settings", { emby: { url: "http://new", apiKey: "k" } });
  assert.equal(res.statusCode, 200);
  const s = readAppSettings();
  assert.equal(s.emby?.url, "http://new");
  assert.equal(s.telegram?.botToken, "t", "别的页面写的键不能被这次保存盖掉");
});

test("PUT /api/settings：类型不对 → 400 VALIDATION", async () => {
  const res = await call("PUT", "/api/settings", { strmExtensions: "not-an-array" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "VALIDATION");
});

test("GET /api/settings：直接返回设置对象，没有 code 壳", async () => {
  const res = await call("GET", "/api/settings");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().code, undefined);
  assert.equal(res.json().emby?.url, "http://new");
});

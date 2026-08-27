/**
 * 探活与备份。
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/system/system.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import healthRoute from "./health.js";
import backupRoute from "./backup.js";

let app: FastifyInstance;
let auth: Record<string, string>;

before(async () => {
  await writeAuthPassword("system-itest-pw");
  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(healthRoute);
  await app.register(backupRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  await writeAuthPassword(DEFAULT_AUTH.password);
});

test("/api/health 不鉴权，只回状态和运行时长", async () => {
  const res = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "ok");
  assert.equal(typeof res.json().uptimeSeconds, "number");
  assert.equal(Object.keys(res.json()).length, 2, "不该带出配置或统计");
});

test("/api/system/backup 需要登录", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/system/backup" })).statusCode, 401);
});

test("/api/system/backup 给出的是能直接打开的 SQLite 快照", async () => {
  const res = await app.inject({ method: "GET", url: "/api/system/backup", headers: auth });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-disposition"]), /openstrm-.*\.db"/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openstrm-restore-"));
  const file = path.join(dir, "restore.db");
  fs.writeFileSync(file, res.rawPayload);
  const db = new Database(file, { readonly: true });
  try {
    const tables = db.prepare("select name from sqlite_master where type = 'table'").all().map((r) => (r as { name: string }).name);
    for (const t of ["settings", "tasks", "accounts", "task_history"]) assert.ok(tables.includes(t), `缺表 ${t}`);
    const { n } = db.prepare("select count(*) as n from settings").get() as { n: number };
    assert.ok(n > 0, "快照里应有当前设置");
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

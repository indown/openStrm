/**
 * 轮询循环本身：顺序长轮询、offset 推进、409 当冲突退避、stop 立刻掐断挂着的长连接，
 * 以及启停开关落库（重启后 index.ts 据此恢复）。Telegram 用本地桩代替，
 * 通过 TELEGRAM_API_BASE 指过去。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/telegram-polling-loop.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import http from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { registerErrorHandling } from "../plugins/error-handler.js";
import { authPlugin } from "../plugins/auth.js";
import pollingRoute from "../routes/telegram/polling.js";
import { DEFAULT_AUTH } from "../db/defaults.js";
import { writeAuthPassword } from "../db/repositories/auth.js";
import { readAppSettings, replaceAppSettings } from "../db/repositories/settings.js";
import {
  __test_pollingDone,
  __test_setBackoff,
  getPollingStatus,
  startPolling,
  stopPolling,
} from "./telegram-polling.js";

// ---- 假 Telegram ----
type Scripted = { status: number; body: unknown } | "hold";
/** getUpdates 的剧本：按顺序消费；用完之后一律挂住（模拟服务端 30 秒长轮询） */
const script: Scripted[] = [];
const calls: Array<{ query: URLSearchParams; at: number }> = [];
const sent: Array<{ text: string }> = [];
let inFlight = 0;
let maxInFlight = 0;

const tg = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname.endsWith("/getUpdates")) {
    calls.push({ query: url.searchParams, at: Date.now() });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    res.on("close", () => inFlight--);
    const next = script.shift() ?? "hold";
    if (next !== "hold") json(next.status, next.body);
    return; // hold：不回，等客户端断开
  }
  if (url.pathname.endsWith("/sendMessage")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      sent.push(JSON.parse(raw));
      json(200, { ok: true, result: {} });
    });
    return;
  }
  json(200, { ok: true, result: true }); // deleteWebhook / setWebhook / getWebhookInfo
});
await new Promise<void>((r) => tg.listen(0, "127.0.0.1", r));
process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${(tg.address() as { port: number }).port}`;

const baseline = readAppSettings();

function message(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: 42, is_bot: false, first_name: "A" },
      chat: { id: 42, type: "private" },
      date: 0,
      text,
    },
  };
}

async function waitFor(cond: () => boolean, what: string, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function stopAndDrain() {
  stopPolling();
  await __test_pollingDone();
  script.length = 0;
  calls.length = 0;
  sent.length = 0;
  maxInFlight = 0;
}

// 每个用例都从"没有循环在跑"开始：上一个用例中途断言失败也不会连累后面的
beforeEach(stopAndDrain);

before(async () => {
  replaceAppSettings({
    ...baseline,
    telegram: { botToken: "123:TEST", chatId: "42", allowedUsers: [42] },
  });
  __test_setBackoff({ conflictMs: 200, errorBaseMs: 50, errorMaxMs: 200 });
});

after(async () => {
  await stopAndDrain();
  __test_setBackoff({ conflictMs: 10_000, errorBaseMs: 1_000, errorMaxMs: 30_000 });
  delete process.env.TELEGRAM_API_BASE;
  replaceAppSettings(baseline);
  tg.closeAllConnections();
  await new Promise<void>((r) => tg.close(() => r()));
});

test("顺序长轮询：同一时刻只有一个 getUpdates，offset 按处理过的 update_id 推进，limit=100", async () => {
  script.push(
    { status: 200, body: { ok: true, result: [message(10, "/ping"), message(11, "/ping")] } },
    { status: 200, body: { ok: true, result: [] } },
    "hold",
  );
  assert.equal(await startPolling(), true);
  assert.equal(await startPolling(), false, "已在跑就不再起第二个循环");
  assert.equal(getPollingStatus().active, true);

  await waitFor(() => calls.length >= 3, "三次 getUpdates");
  assert.equal(maxInFlight, 1, "长轮询必须串行，叠着发会被 Telegram 用 409 互相掐掉");
  assert.equal(calls[0].query.get("offset"), null, "第一次没有 offset：把没确认的都拉回来");
  assert.equal(calls[0].query.get("limit"), "100");
  assert.equal(calls[0].query.get("timeout"), "30");
  assert.equal(calls[1].query.get("offset"), "12", "处理完 10、11 之后从 12 拉");
  assert.equal(calls[2].query.get("offset"), "12");

  await waitFor(() => sent.length >= 2, "两条 Pong");
  assert.match(sent[0].text, /Pong/);
  assert.match(sent[1].text, /Pong/);
});

test("409 是冲突不是没消息：退避之后再试，循环不退出", async () => {
  script.push(
    { status: 409, body: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" } },
    "hold",
  );
  assert.equal(await startPolling(), true);
  await waitFor(() => calls.length >= 2, "409 之后的重试");
  const gap = calls[1].at - calls[0].at;
  assert.ok(gap >= 150, `409 之后应等 conflictMs(200ms) 再试，实际 ${gap}ms`);
  assert.equal(getPollingStatus().active, true);
});

test("其它错误按次数指数退避，成功一次就归零", async () => {
  script.push(
    { status: 500, body: { ok: false } },
    { status: 500, body: { ok: false } },
    { status: 200, body: { ok: true, result: [] } },
    { status: 500, body: { ok: false } },
    "hold",
  );
  assert.equal(await startPolling(), true);
  await waitFor(() => calls.length >= 5, "五次 getUpdates");
  const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
  assert.ok(gaps[0] >= 40, `第 1 次失败后 ~50ms，实际 ${gaps[0]}ms`);
  assert.ok(gaps[1] >= 80, `第 2 次失败后 ~100ms，实际 ${gaps[1]}ms`);
  assert.ok(gaps[3] >= 40 && gaps[3] < 150, `成功后计数归零，再失败又是 ~50ms，实际 ${gaps[3]}ms`);
});

test("stop 立刻掐断挂着的长连接，不用等 30 秒超时", async () => {
  script.push("hold");
  assert.equal(await startPolling(), true);
  await waitFor(() => inFlight === 1, "长连接挂上");

  const t0 = Date.now();
  assert.equal(stopPolling(), true);
  await __test_pollingDone();
  assert.ok(Date.now() - t0 < 1000, "循环应随 abort 立即退出");
  assert.equal(getPollingStatus().active, false);
  assert.equal(stopPolling(), false, "没在跑时 stop 返回 false");
  await waitFor(() => inFlight === 0, "服务端看到连接断开");
});

test("路由：启停把 pollingEnabled 写进设置，重启后据此恢复", async () => {
  await writeAuthPassword("polling-itest-pw");
  const app: FastifyInstance = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(pollingRoute);
  await app.ready();
  const headers = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
  try {
    script.push("hold");
    const on = await app.inject({ method: "POST", url: "/api/telegram/polling", headers });
    assert.equal(on.statusCode, 200);
    assert.equal(getPollingStatus().active, true);
    assert.equal(readAppSettings().telegram?.pollingEnabled, true);
    assert.equal(readAppSettings().telegram?.botToken, "123:TEST", "写开关不能碰掉同组的其它字段");

    const off = await app.inject({ method: "DELETE", url: "/api/telegram/polling", headers });
    assert.equal(off.statusCode, 200);
    assert.equal(getPollingStatus().active, false);
    assert.equal(readAppSettings().telegram?.pollingEnabled, false);
  } finally {
    await app.close();
    await writeAuthPassword(DEFAULT_AUTH.password);
    await stopAndDrain();
  }
});

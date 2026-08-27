/**
 * 防抖合并行为验证。
 *
 * 关键是别让生活事件把 Emby 的全库扫描打爆：N 条变更只能合成一次刷新，
 * 而且持续不断的事件流不能把刷新无限期推后。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/media-server.itest.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { readAppSettings, replaceAppSettings } from "../db/repositories/settings.js";
import {
  cancelEmbyRefresh,
  flushEmbyRefresh,
  getEmbyRefreshState,
  scheduleEmbyRefresh,
} from "./media-server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 起一个假 Emby，数它收到几次 /Library/Refresh
let hits = 0;
const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/Library/Refresh")) hits++;
  res.writeHead(204).end();
});
let port = 0;
const baseline = readAppSettings();

function configure(quiet: number, maxWait: number) {
  replaceAppSettings({
    ...baseline,
    emby: { url: `http://127.0.0.1:${port}`, apiKey: "test" },
    lifeMonitor: {
      ...(baseline.lifeMonitor ?? {}),
      mediaServerRefreshDelay: quiet,
      mediaServerRefreshMaxWait: maxWait,
    },
  });
  cancelEmbyRefresh();
  hits = 0;
}

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

after(() => {
  cancelEmbyRefresh();
  replaceAppSettings(baseline);
  server.close();
});

test("20 条变更合并成 1 次全库刷新", async () => {
  configure(1, 60);
  for (let i = 0; i < 20; i++) scheduleEmbyRefresh();
  assert.equal(getEmbyRefreshState().pendingCount, 20);
  assert.equal(hits, 0, "安静期内不应该发");
  await sleep(1400);
  assert.equal(hits, 1, `20 条变更应合成 1 次刷新，实际 ${hits}`);
});

test("事件持续不断时由封顶时间兜底触发", async () => {
  configure(10, 1); // 安静期 10s，封顶 1s
  const ticker = setInterval(() => scheduleEmbyRefresh(), 100);
  scheduleEmbyRefresh();
  await sleep(1600);
  clearInterval(ticker);
  assert.ok(hits >= 1, `事件不断时也应被封顶触发，实际 ${hits}`);
});

test("停机时冲刷待发的刷新", async () => {
  configure(60, 600);
  scheduleEmbyRefresh();
  assert.equal(hits, 0);
  flushEmbyRefresh();
  await sleep(200);
  assert.equal(hits, 1, "flush 应立刻发出待发的刷新");
});

test("未配置 Emby 时不产生任何请求", async () => {
  replaceAppSettings({ ...baseline, emby: { url: "", apiKey: "" } });
  cancelEmbyRefresh();
  hits = 0;
  scheduleEmbyRefresh();
  assert.equal(getEmbyRefreshState().pendingCount, 0, "未配置时不该登记任何待发项");
  await sleep(200);
  assert.equal(hits, 0);
});

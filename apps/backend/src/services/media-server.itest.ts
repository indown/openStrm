/**
 * 防抖合并行为验证。
 *
 * 关键是别让生活事件把 Emby 的全库扫描打爆：N 条变更只能合成一次刷新，
 * 而且持续不断的事件流不能把刷新无限期推后。
 *
 *   CONFIG_DIR=... npx tsx src/services/media-server.itest.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { readAppSettings, replaceAppSettings } from "../db/repositories/settings.js";
import {
  cancelEmbyRefresh,
  flushEmbyRefresh,
  getEmbyRefreshState,
  scheduleEmbyRefresh,
  setMediaServerLogger,
} from "./media-server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 起一个假 Emby，数它收到几次 /Library/Refresh
let hits = 0;
const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/Library/Refresh")) hits++;
  res.writeHead(204).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

const baseline = readAppSettings();
setMediaServerLogger(() => {});

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

async function main() {
  let pass = 0;

  // 1) 一串变更只合成一次刷新
  configure(1, 60);
  for (let i = 0; i < 20; i++) scheduleEmbyRefresh();
  assert.equal(getEmbyRefreshState().pendingCount, 20);
  assert.equal(hits, 0, "安静期内不应该发");
  await sleep(1400);
  assert.equal(hits, 1, `20 条变更应合成 1 次刷新，实际 ${hits}`);
  pass++; console.log("  ok  20 条变更合并成 1 次全库刷新");

  // 2) 持续不断的事件不能把刷新饿死：封顶时间一到必须发
  configure(10, 1); // 安静期 10s，封顶 1s
  const ticker = setInterval(() => scheduleEmbyRefresh(), 100);
  scheduleEmbyRefresh();
  await sleep(1600);
  clearInterval(ticker);
  assert.ok(hits >= 1, `事件不断时也应被封顶触发，实际 ${hits}`);
  pass++; console.log("  ok  事件持续不断时由封顶时间兜底触发");

  // 3) 停机冲刷：攒着的不能丢
  configure(60, 600);
  scheduleEmbyRefresh();
  assert.equal(hits, 0);
  flushEmbyRefresh();
  await sleep(200);
  assert.equal(hits, 1, "flush 应立刻发出待发的刷新");
  pass++; console.log("  ok  停机时冲刷待发的刷新");

  // 4) 没配 Emby 就完全不动
  replaceAppSettings({ ...baseline, emby: { url: "", apiKey: "" } });
  cancelEmbyRefresh(); hits = 0;
  scheduleEmbyRefresh();
  assert.equal(getEmbyRefreshState().pendingCount, 0, "未配置时不该登记任何待发项");
  await sleep(200);
  assert.equal(hits, 0);
  pass++; console.log("  ok  未配置 Emby 时不产生任何请求");

  console.log(`\n${pass} passed`);
}

main()
  .then(() => { replaceAppSettings(baseline); server.close(); })
  .catch((err) => { replaceAppSettings(baseline); server.close(); console.error(err); process.exit(1); });

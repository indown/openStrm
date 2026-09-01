/**
 * 下载流：中途卡住要被掐断并报错，而不是永远占着限流槽位；进度按整数百分比去重。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/download/rate-limited.itest.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { lastValueFrom, tap } from "rxjs";
import { downloadOrCreateStrm } from "./rate-limited.js";

let stalled: http.ServerResponse | null = null;
const server = http.createServer((req, res) => {
  if (req.url === "/stall") {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1000" });
    res.write("first-chunk");
    stalled = res; // 之后什么都不再发
    return;
  }
  if (req.url === "/chunky") {
    // 1000 字节分 200 次发、每次隔 1ms：客户端收到的 chunk 远多于 100 个
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1000" });
    let sent = 0;
    const tick = () => {
      res.write("abcde");
      sent += 5;
      if (sent >= 1000) res.end();
      else setTimeout(tick, 1);
    };
    tick();
    return;
  }
  res.writeHead(200, { "content-length": "5" });
  res.end("hello");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR!, "dl-itest-"));

after(async () => {
  stalled?.destroy();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("正常下载：进度到 100 并完成", async () => {
  const savePath = path.join(dir, "ok.bin");
  const last = await lastValueFrom(downloadOrCreateStrm(`${base}/ok`, savePath, { displayPath: "ok.bin" }));
  assert.equal(last.percent, 100);
  assert.equal(fs.readFileSync(savePath, "utf8"), "hello");
});

test("响应头到了但 body 卡住：空闲超时后以错误结束，错误里说明原因", async () => {
  const savePath = path.join(dir, "stall.bin");
  const t0 = Date.now();
  await assert.rejects(
    lastValueFrom(downloadOrCreateStrm(`${base}/stall`, savePath, { displayPath: "stall.bin", idleTimeoutMs: 150 })),
    (err: Error) => /stall\.bin：0\.15 秒内没有收到数据/.test(err.message),
  );
  assert.ok(Date.now() - t0 < 2000, "应在空闲窗口后很快失败，而不是等到 axios 的 30 秒");
});

test("进度按整数百分比去重：几百个 chunk 只发一百来条，100 只在改名后发一次", async () => {
  const savePath = path.join(dir, "chunky.bin");
  const events: number[] = [];
  const last = await lastValueFrom(
    downloadOrCreateStrm(`${base}/chunky`, savePath, { displayPath: "chunky.bin" }).pipe(
      tap((p) => events.push(p.percent!)),
    ),
  );
  assert.equal(last.percent, 100);
  assert.ok(events.length <= 101, `事件数 ${events.length} 不该超过 101`);
  assert.ok(events.every((p) => Number.isInteger(p)), `百分比应是整数：${events.join(",")}`);
  assert.ok(events.every((p, i) => i === 0 || p > events[i - 1]), `应严格递增、没有重复：${events.join(",")}`);
  assert.equal(events.filter((p) => p === 100).length, 1, "100 只发一次");
  assert.equal(fs.statSync(savePath).size, 1000);
});

/**
 * 下载流中途卡住要被掐断并报错，而不是永远占着限流槽位。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/download/rate-limited.itest.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { lastValueFrom } from "rxjs";
import { downloadOrCreateStrm } from "./rate-limited.js";

let stalled: http.ServerResponse | null = null;
const server = http.createServer((req, res) => {
  if (req.url === "/stall") {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1000" });
    res.write("first-chunk");
    stalled = res; // 之后什么都不再发
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

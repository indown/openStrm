/**
 * 下载流：中途卡住要被掐断并报错，而不是永远占着限流槽位；进度按整数百分比去重。
 * 取直链：永久失败不重试、临时失败重试、signal 能中止进行中的请求。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/download/rate-limited.itest.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { lastValueFrom, tap } from "rxjs";
import type { AccountInfo } from "@openstrm/shared";
import { clearRateLimiters, downloadOrCreateStrm, getRealDownloadLink } from "./rate-limited.js";

let stalled: http.ServerResponse | null = null;
let held: http.ServerResponse | null = null;
let fsGetMode: "ok" | "missing" | "flaky" | "hold" = "ok";
let fsGetCalls = 0;
let fsGetAborted = 0;
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
  if (req.url === "/api/fs/get") {
    // 假 OpenList 的取直链接口
    fsGetCalls++;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (fsGetMode === "missing") return json(200, { code: 500, message: "object not found" });
    if (fsGetMode === "flaky" && fsGetCalls === 1) return json(500, { message: "boom" });
    if (fsGetMode === "hold") {
      held = res; // 不回应，等客户端中止
      res.on("close", () => {
        if (!res.writableFinished) fsGetAborted++;
      });
      return;
    }
    return json(200, { code: 200, data: { raw_url: `${base}/raw` } });
  }
  res.writeHead(200, { "content-length": "5" });
  res.end("hello");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR!, "dl-itest-"));

const olAccounts: AccountInfo[] = [
  { accountType: "openlist", name: "ol-itest", account: "u", password: "p", url: base, token: "tok" },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await sleep(10);
  }
}

after(async () => {
  stalled?.destroy();
  held?.destroy();
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

test("取直链：OpenList 明确说没有这个文件就立刻失败，不重试", async () => {
  clearRateLimiters();
  fsGetMode = "missing";
  fsGetCalls = 0;
  const t0 = Date.now();
  await assert.rejects(
    getRealDownloadLink("/x/missing.nfo", "ol-itest", olAccounts, { maxRetries: 3, retryDelay: 500 }),
    /object not found/,
  );
  assert.ok(Date.now() - t0 < 400, "不该等重试间隔");
  assert.equal(fsGetCalls, 1, "只问一次");
});

test("取直链：HTTP 5xx 这类临时失败照常重试", async () => {
  clearRateLimiters();
  fsGetMode = "flaky";
  fsGetCalls = 0;
  const url = await getRealDownloadLink("/x/ok.nfo", "ol-itest", olAccounts, { maxRetries: 3, retryDelay: 10 });
  assert.equal(url, `${base}/raw`);
  assert.equal(fsGetCalls, 2, "第一次 500，第二次成功");
});

test("取直链：signal 中止会掐断进行中的请求并立刻拒绝", async () => {
  clearRateLimiters();
  fsGetMode = "hold";
  fsGetCalls = 0;
  fsGetAborted = 0;
  const ac = new AbortController();
  const outcome = getRealDownloadLink("/x/slow.nfo", "ol-itest", olAccounts, {
    maxRetries: 3,
    retryDelay: 500,
    signal: ac.signal,
  }).then(() => null, (err: Error) => err);
  await waitFor(() => fsGetCalls === 1, "请求到达服务端");
  const t0 = Date.now();
  ac.abort();
  const err = await outcome;
  assert.ok(err && axios.isCancel(err), `应以取消错误拒绝，实际：${err?.message}`);
  assert.ok(Date.now() - t0 < 300, "中止后应立刻返回，而不是等 30 秒超时");
  await waitFor(() => fsGetAborted === 1, "服务端看到连接被掐断");
});

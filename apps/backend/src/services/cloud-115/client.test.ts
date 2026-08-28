/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/cloud-115/client.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Cloud115Error, listDirEntries, type DriveEntry } from "./client.js";

const entry = (i: number): DriveEntry => ({ n: `f${i}`, fid: i, cid: 1, fc: 1 });
const ctx = { accountInfo: { name: "a", cookie: "c" } };

test("listDirEntries 按 1000 一页翻到 count 为止，顺序不变", async () => {
  const calls: number[] = [];
  const total = 2500;
  const pager: Parameters<typeof listDirEntries>[2] = async (_cid, { offset = 0, limit = 1000 }) => {
    calls.push(offset);
    const data = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => entry(offset + i));
    return { data, count: total };
  };
  const all = await listDirEntries(7, ctx, pager);
  assert.equal(all.length, total);
  assert.deepEqual(calls, [0, 1000, 2000]);
  assert.equal(all[2499].n, "f2499");
});

test("listDirEntries：没有 count 时以不满一页为终点；正好整页且 count 相符不多拉一次", async () => {
  let calls = 0;
  const noCount: Parameters<typeof listDirEntries>[2] = async (_cid, { offset = 0 }) => {
    calls++;
    return { data: offset === 0 ? Array.from({ length: 1000 }, (_, i) => entry(i)) : [entry(1000)] };
  };
  assert.equal((await listDirEntries(1, ctx, noCount)).length, 1001);
  assert.equal(calls, 2);

  calls = 0;
  const exact: Parameters<typeof listDirEntries>[2] = async () => {
    calls++;
    return { data: Array.from({ length: 1000 }, (_, i) => entry(i)), count: 1000 };
  };
  assert.equal((await listDirEntries(1, ctx, exact)).length, 1000);
  assert.equal(calls, 1, "count 说明已经取完，不该再拉第二页");
});

test("Cloud115Error 的 message 带状态码、路径和响应里的说明", () => {
  const e = new Cloud115Error(405, { state: false, error: "您的访问被阻断" }, "https://webapi.115.com/files?cid=0");
  assert.equal(e.name, "Cloud115Error");
  assert.equal(e.status, 405);
  assert.equal(e.message, "115 接口返回 405 (/files): 您的访问被阻断");
  assert.ok(e instanceof Error);

  const html = new Cloud115Error(405, "<!doctypehtml><html>" + "x".repeat(500));
  assert.ok(html.message.startsWith("115 接口返回 405: <!doctypehtml>"));
  assert.ok(html.message.length < 260, "响应体截断到 200 字符");

  const obj = new Cloud115Error(500, { code: 1, data: null });
  assert.equal(obj.message, '115 接口返回 500: {"code":1,"data":null}');
});

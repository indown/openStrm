/**
 *   pnpm test:file src/lib/http.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { guardIdleStream } from "./http.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("有数据就不断续期；停下来超过 ms 才销毁，错误里说明原因", async () => {
  const s = new PassThrough();
  const errors: Error[] = [];
  guardIdleStream(s, 60, "下载");
  s.on("data", () => {});
  s.on("error", (e) => errors.push(e));

  for (let i = 0; i < 4; i++) {
    s.write("x");
    await tick(30); // 每 30ms 来一块，总时长超过 60ms 也不该被掐
  }
  assert.equal(errors.length, 0, "持续有数据时不该销毁");
  assert.equal(s.destroyed, false);

  await tick(90);
  assert.equal(s.destroyed, true, "停 90ms 超过 60ms 的窗口，应被销毁");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /^下载：0\.06 秒内没有收到数据$/);
});

test("正常结束后计时器清掉，不会事后再去销毁一次", async () => {
  const s = new PassThrough();
  let errored = false;
  guardIdleStream(s, 40, "x");
  s.on("data", () => {});
  s.on("error", () => (errored = true));
  s.end("done");
  await tick(80);
  assert.equal(errored, false);
});

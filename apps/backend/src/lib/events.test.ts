/**
 *   pnpm test:file src/lib/events.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmitter } from "./events.js";
import { moduleLogger } from "./logger.js";

const log = moduleLogger("events-test");

interface Events {
  ping: { n: number };
}

test("on 收到 emit 的负载；返回的注销函数和 off 都能退订；没人听时 emit 不抛", () => {
  const emitter = createEmitter<Events>(log);
  emitter.emit("ping", { n: 0 });
  const got: number[] = [];
  const off = emitter.on("ping", (p) => got.push(p.n));
  const other = (p: { n: number }) => got.push(p.n * 10);
  emitter.on("ping", other);
  emitter.emit("ping", { n: 1 });
  assert.deepEqual(got, [1, 10]);
  off();
  emitter.emit("ping", { n: 2 });
  assert.deepEqual(got, [1, 10, 20]);
  emitter.off("ping", other);
  emitter.emit("ping", { n: 3 });
  assert.deepEqual(got, [1, 10, 20]);
});

test("监听者抛错只记日志：别的监听者照收，emit 不抛", () => {
  const emitter = createEmitter<Events>(log);
  const got: number[] = [];
  emitter.on("ping", () => {
    throw new Error("听的一方炸了");
  });
  emitter.on("ping", (p) => got.push(p.n));
  assert.doesNotThrow(() => emitter.emit("ping", { n: 7 }));
  assert.deepEqual(got, [7]);
});

test("监听者在回调里注销自己：这一轮照常派完", () => {
  const emitter = createEmitter<Events>(log);
  const got: string[] = [];
  const off = emitter.on("ping", () => {
    got.push("once");
    off();
  });
  emitter.on("ping", () => got.push("always"));
  emitter.emit("ping", { n: 1 });
  emitter.emit("ping", { n: 2 });
  assert.deepEqual(got, ["once", "always", "always"]);
});

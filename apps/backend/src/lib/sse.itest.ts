/**
 * SSE 壳层：必须走真的 HTTP 连接来测。
 *
 * app.inject()（light-my-request）不会触发 req/res 的 'close'，所以这两条都漏得掉：
 *   - POST 进到 handler 时请求体已经读完，request.raw 当场 'close'——按它收尾会一开就自关
 *   - 客户端断开要传到 signal，后端那一轮活儿才停得下来
 * 第一条曾经把流式校验整个搞挂过（接口一调只发得出第一条事件），而 inject 的用例全绿。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/lib/sse.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { openSse } from "./sse.js";

let app: FastifyInstance;
let base: string;
/** 最近一次请求里 signal 被 abort 的时刻（相对 handler 进来），-1 = 没 abort 过 */
let abortedAt = -1;

before(async () => {
  app = Fastify();

  // 发三条、隔 30ms 一条，然后自己收尾
  app.post("/three", async (_request, reply) => {
    const sse = openSse(reply);
    const t0 = Date.now();
    abortedAt = -1;
    sse.signal.addEventListener("abort", () => (abortedAt = Date.now() - t0));
    sse.send({ n: 1 });
    setTimeout(() => sse.send({ n: 2 }), 30);
    setTimeout(() => {
      sse.send({ n: 3 });
      sse.close();
    }, 60);
  });

  // 一直发，直到被掐
  app.post("/forever", async (_request, reply) => {
    const sse = openSse(reply);
    const t0 = Date.now();
    abortedAt = -1;
    const timer = setInterval(() => sse.send({ t: Date.now() - t0 }), 20);
    timer.unref?.();
    sse.signal.addEventListener("abort", () => {
      abortedAt = Date.now() - t0;
      clearInterval(timer);
    });
    setTimeout(() => {
      clearInterval(timer);
      sse.close();
    }, 3000).unref?.();
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(async () => {
  await app.close();
});

const open = (path: string, signal?: AbortSignal) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ any: "body" }),
    signal,
  });

async function readAll(res: Response): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n").filter((l) => l.startsWith("data: "));
}

test("POST 的事件流不会自己关掉：请求体读完不算客户端断开", async () => {
  const res = await open("/three");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(res.headers.get("x-accel-buffering"), "no", "少了这个头 nginx 会攒着不发");
  const events = await readAll(res);
  assert.equal(events.length, 3, `三条都要发得出去，实际 ${events.length} 条`);
  assert.ok(abortedAt >= 0, "自己 close 之后 signal 该收尾");
});

test("客户端断开：signal 跟着 abort，后端那一轮才停得下来", async () => {
  const controller = new AbortController();
  const res = await open("/forever", controller.signal);
  const reader = res.body!.getReader();
  let chunks = 0;
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      if (++chunks >= 2) controller.abort();
    }
  } catch {
    /* 自己掐的 */
  }
  // 断开要过一趟内核才到服务端
  for (let i = 0; i < 50 && abortedAt < 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(abortedAt >= 0, "服务端没察觉断开，活儿会一直跑下去");
});

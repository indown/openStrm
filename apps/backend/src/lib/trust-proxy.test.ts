/**
 * TRUST_PROXY 怎么解析，以及解析出来交给 Fastify 后 request.ip 取的是谁：
 * 客户端自己在 X-Forwarded-For 左边塞的地址不能被当成来源。
 *
 *   pnpm test:file src/lib/trust-proxy.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { trustProxyOption } from "./trust-proxy.js";

test("解析：没设 / false / 0 不信；true 信回环和内网；数字是跳数；别的原样当地址列表", () => {
  assert.equal(trustProxyOption(undefined), false);
  assert.equal(trustProxyOption("false"), false);
  assert.equal(trustProxyOption("0"), false);
  assert.equal(trustProxyOption("true"), "loopback, linklocal, uniquelocal");
  assert.equal(trustProxyOption("2"), 2);
  assert.equal(trustProxyOption("10.0.0.2, 172.18.0.0/16"), "10.0.0.2, 172.18.0.0/16");
});

async function ipSeen(raw: string, remoteAddress: string, xff: string): Promise<{ ip: string; host: string }> {
  const app = Fastify({ trustProxy: trustProxyOption(raw) });
  app.get("/", async (request) => ({ ip: request.ip, host: request.hostname }));
  const res = await app.inject({ method: "GET", url: "/", remoteAddress, headers: { "x-forwarded-for": xff, "x-forwarded-host": "spoofed.example", host: "mcp.example.com" } });
  await app.close();
  return res.json();
}

test("true：反代在本机 / 内网，客户端在 X-Forwarded-For 左边伪造的地址不算数", async () => {
  // nginx 的 $proxy_add_x_forwarded_for、Cloudflare 都是往后追加：最右边那个才是它们看到的真实来源
  assert.equal((await ipSeen("true", "127.0.0.1", "6.6.6.6, 203.0.113.9")).ip, "203.0.113.9");
  assert.equal((await ipSeen("true", "172.18.0.3", "6.6.6.6, 203.0.113.9")).ip, "203.0.113.9", "docker 网络里的反代");
  assert.equal((await ipSeen("1", "127.0.0.1", "6.6.6.6, 203.0.113.9")).ip, "203.0.113.9");
});

test("直接从公网连进来的（不是信任的代理）：X-Forwarded-For、X-Forwarded-Host 都不认", async () => {
  const seen = await ipSeen("true", "198.51.100.7", "6.6.6.6");
  assert.equal(seen.ip, "198.51.100.7");
  assert.equal(seen.host, "mcp.example.com");
});

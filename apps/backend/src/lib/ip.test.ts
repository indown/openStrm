/**
 *   pnpm test:file src/lib/ip.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ipKey } from "./ip.js";

test("IPv4 原样；IPv4 映射的 IPv6 按里面的 IPv4", () => {
  assert.equal(ipKey("203.0.113.9"), "203.0.113.9");
  assert.equal(ipKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(ipKey("::FFFF:127.0.0.1"), "127.0.0.1");
  assert.equal(ipKey("::ffff:cb00:7109"), "203.0.113.9", "十六进制写法的映射地址也认");
});

test("IPv6 按 /64 归到一个键：同一个 /64 里换地址绕不过去", () => {
  const a = ipKey("2001:db8:1:2:aaaa::1");
  assert.equal(a, "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"), a);
  assert.equal(ipKey("2001:db8:1:2::abcd%eth0"), a, "带接口名的也认");
  assert.notEqual(ipKey("2001:db8:1:3::1"), a, "隔壁的 /64 是另一个键");
  assert.equal(ipKey("::1"), "0:0:0:0::/64");
  assert.equal(ipKey("fe80::1"), "fe80:0:0:0::/64");
  assert.equal(ipKey("64:ff9b::192.0.2.1"), "64:ff9b:0:0::/64", "结尾内嵌 IPv4 的写法");
});

test("认不出的原样返回", () => {
  assert.equal(ipKey("not-an-ip"), "not-an-ip");
  assert.equal(ipKey(""), "");
});

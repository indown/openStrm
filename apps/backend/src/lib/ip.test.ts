/**
 *   pnpm test:file src/lib/ip.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ipKey, isInternalAddress, normalizeAddress } from "./ip.js";

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

test("地址的规范写法：去方括号、接口名，小写，IPv4 映射的 IPv6 还原成 IPv4", () => {
  assert.equal(normalizeAddress(" ::ffff:172.18.0.2 "), "172.18.0.2");
  assert.equal(normalizeAddress("[2001:DB8::1]"), "2001:db8::1");
  assert.equal(normalizeAddress("fe80::1%eth0"), "fe80::1");
  assert.equal(normalizeAddress("203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeAddress("unknown"), "unknown");
});

test("内网地址：回环、私有网段、链路本地、运营商级 NAT、IPv6 唯一本地；公网和认不出的都不算", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.17.0.1", "192.168.1.5", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:192.168.1.5"]) {
    assert.equal(isInternalAddress(ip), true, ip);
  }
  for (const ip of ["203.0.113.9", "8.8.8.8", "172.32.0.1", "2001:db8::1", "192.0.2.1", "", "not-an-ip"]) {
    assert.equal(isInternalAddress(ip), false, ip);
  }
});

/**
 * 管理员密码比对的统一入口：
 *   - 按来源的退避几个入口共用一个桶；
 *   - 一小时里经过反代 / 从公网来的失败太多：之后这类比对先等一会儿，发一条 Telegram 告警（一小时一条）；
 *     从内网直接连进来的（没带 X-Forwarded-For、对端是内网地址）不算数、也不等。不硬停。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/password-check.test.ts
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { FastifyRequest } from "fastify";
import type { AppSettings } from "@openstrm/shared";
import { patchAppSettings, readAppSettings, replaceAppSettings } from "../db/repositories/settings.js";
import { loginThrottle } from "./login-throttle.js";
import { __test_resetPasswordGuard, checkAdminPassword, isDirectInternal } from "./password-check.js";
import { setNotifySender } from "./telegram/notify.js";

const baseline: AppSettings = readAppSettings();
const alerts: string[] = [];

beforeEach(() => {
  loginThrottle.reset();
  __test_resetPasswordGuard({ slowMs: 60 });
  alerts.length = 0;
  setNotifySender(async (_chatId, text) => {
    alerts.push(text);
  });
  patchAppSettings({ telegram: { ...baseline.telegram, botToken: "123:abc", chatId: "42" } });
});

after(() => {
  setNotifySender(null);
  __test_resetPasswordGuard();
  loginThrottle.reset();
  replaceAppSettings(baseline);
});

/** 一个请求只看这几样：来源（TRUST_PROXY 算过的）、直接连过来的那一端、有没有 X-Forwarded-For */
function req(ip: string, opts: { peer?: string; forwarded?: boolean } = {}): FastifyRequest {
  return {
    ip,
    headers: opts.forwarded ? { "x-forwarded-for": ip } : {},
    socket: { remoteAddress: opts.peer ?? ip },
  } as unknown as FastifyRequest;
}

const wrong = async () => false;
const right = async () => true;

test("内网直接连进来：没带 X-Forwarded-For、对端是内网地址；经过反代的、公网来的都不算", () => {
  assert.equal(isDirectInternal(req("192.168.1.20")), true);
  assert.equal(isDirectInternal(req("203.0.113.5", { peer: "127.0.0.1", forwarded: true })), false, "经过本机反代：带着 X-Forwarded-For");
  assert.equal(isDirectInternal(req("203.0.113.5")), false, "公网直接连");
});

test("按来源：几个入口共用一个桶，同一个来源错 5 次就锁；锁着连密码都不比", async () => {
  const from = req("203.0.113.9", { peer: "127.0.0.1", forwarded: true });
  for (let i = 0; i < 5; i++) assert.deepEqual(await checkAdminPassword(from, wrong), { kind: "checked", ok: false });
  let verified = false;
  const locked = await checkAdminPassword(from, async () => {
    verified = true;
    return true;
  });
  assert.equal(locked.kind, "throttled");
  assert.equal(verified, false);
  assert.ok(loginThrottle.blockedFor("203.0.113.9") > 0, "登录用的是同一个桶");
});

test("换着地址试：一小时里错满 20 次后发一条告警，之后经过反代的比对先等一会儿，内网直连的不等、也不算数；不硬停", async () => {
  for (let i = 0; i < 25; i++) await checkAdminPassword(req("192.168.1.20"), wrong);
  loginThrottle.reset();
  assert.equal(alerts.length, 0, "内网直连的失败不算进全局");

  for (let i = 0; i < 19; i++) await checkAdminPassword(req(`203.0.113.${i + 1}`, { peer: "127.0.0.1", forwarded: true }), wrong);
  assert.equal(alerts.length, 0);
  await checkAdminPassword(req("198.51.100.1", { peer: "127.0.0.1", forwarded: true }), wrong);
  await new Promise((r) => setImmediate(r));
  assert.equal(alerts.length, 1, "满 20 次发告警");
  assert.match(alerts[0], /最近一小时输错了 20 次/);
  assert.match(alerts[0], /来自 20 个来源/);

  const t0 = Date.now();
  const slowed = await checkAdminPassword(req("198.51.100.2", { peer: "127.0.0.1", forwarded: true }), right);
  assert.deepEqual(slowed, { kind: "checked", ok: true }, "放慢，不拦");
  assert.ok(Date.now() - t0 >= 50, "经过反代来的先等一会儿");

  const t1 = Date.now();
  await checkAdminPassword(req("192.168.1.30"), right);
  assert.ok(Date.now() - t1 < 50, "内网直连不等");

  for (let i = 0; i < 5; i++) await checkAdminPassword(req(`198.51.100.${i + 10}`, { peer: "127.0.0.1", forwarded: true }), wrong);
  await new Promise((r) => setImmediate(r));
  assert.equal(alerts.length, 1, "一小时只告警一次");
});

test("比对出错：位子照样还回去，错误原样抛出", async () => {
  const from = req("203.0.113.77", { peer: "127.0.0.1", forwarded: true });
  await assert.rejects(
    checkAdminPassword(from, async () => {
      throw new Error("kdf failed");
    }),
    /kdf failed/,
  );
  assert.deepEqual(await checkAdminPassword(from, right), { kind: "checked", ok: true });
});

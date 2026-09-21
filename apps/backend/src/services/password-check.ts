/**
 * 管理员密码的比对都走这里：登录、再输一次当前密码（建令牌、批准网页客户端、改密码）、授权页上的密码批准。
 *
 * 按来源：login-throttle 的失败退避，几个入口共用一个桶（begin / end 占位，同时打进来的一批不会全漏过去）。
 *
 * 全局：按来源的桶挡不住换着地址试，而一个域名共用时登录页就在公网上。一小时里一共错了 ALARM_AT 次以后：
 *   - 经过反代或者从公网来的，每次比对前先等一会儿（从内网直接连进来的不等：外面有人在刷，管理员在家照样能登）；
 *   - 发一条 Telegram 告警（一小时最多一条），日志里也记一条。
 * 不硬停：硬停等于谁都能把公网上的登录和授权页的密码批准关掉一小时。
 */
import type { FastifyRequest } from "fastify";
import { ipKey, isInternalAddress } from "../lib/ip.js";
import { moduleLogger } from "../lib/logger.js";
import { loginThrottle } from "./login-throttle.js";
import { notifySecurityAlert } from "./telegram/notify.js";

const log = moduleLogger("password-check");

const WINDOW_MS = 60 * 60_000;
const ALARM_AT = 20;
/** 窗口里最多记这么多条失败（被刷的时候不至于无限长） */
const MAX_TRACKED = 10_000;
let slowMs = 2000;

/** 一小时内经过反代 / 从公网来的失败：时间和来源键 */
let failures: Array<{ at: number; key: string }> = [];
let alarmedAt = 0;

export type PasswordCheck = { kind: "throttled"; wait: number } | { kind: "checked"; ok: boolean };

/** 从内网直接连进来的（没经过反代）：直接连过来的是内网地址，也没带 X-Forwarded-For */
export function isDirectInternal(request: FastifyRequest): boolean {
  const peer = request.socket?.remoteAddress;
  return request.headers["x-forwarded-for"] === undefined && typeof peer === "string" && isInternalAddress(peer);
}

function recentFailures(now: number): number {
  while (failures.length > 0 && now - failures[0].at >= WINDOW_MS) failures.shift();
  return failures.length;
}

function recordFailure(key: string, now: number): void {
  failures.push({ at: now, key });
  if (failures.length > MAX_TRACKED) failures = failures.slice(-MAX_TRACKED);
  const count = recentFailures(now);
  if (count < ALARM_AT || now - alarmedAt < WINDOW_MS) return;
  alarmedAt = now;
  const sources = new Set(failures.map((f) => f.key)).size;
  log.warn({ failures: count, sources }, "管理员密码一小时里错了太多次：之后经过反代或从公网来的尝试都放慢");
  void notifySecurityAlert(
    [
      `🚨 <b>OpenStrm 管理员密码最近一小时输错了 ${count} 次</b>`,
      `来自 ${sources} 个来源（经过反代或从公网来的）。之后这类尝试每次都会慢一点；从局域网直接打开的不受影响。`,
      "不是你自己输错的：换一个更长的密码，或者给管理界面套一层身份代理（见 README）。",
    ].join("\n"),
  ).catch((err: unknown) => log.warn({ err }, "密码告警没发出去"));
}

/**
 * 比对一次管理员密码：先占按来源的位子（锁着就回要等的秒数），被刷的时候先等一会儿，再跑 verify。
 * verify 抛错时照样还位子，错误原样抛出
 */
export async function checkAdminPassword(request: FastifyRequest, verify: () => Promise<boolean>): Promise<PasswordCheck> {
  const key = ipKey(request.ip);
  const wait = loginThrottle.begin(key);
  if (wait > 0) return { kind: "throttled", wait };
  const direct = isDirectInternal(request);
  let ok: boolean | undefined;
  try {
    if (!direct && recentFailures(Date.now()) >= ALARM_AT) await new Promise((r) => setTimeout(r, slowMs));
    ok = await verify();
  } finally {
    loginThrottle.end(key, ok);
  }
  if (!ok && !direct) recordFailure(key, Date.now());
  return { kind: "checked", ok: ok === true };
}

/** 测试用：清掉全局计数；slowMs 改短免得测试干等 */
export function __test_resetPasswordGuard(opts: { slowMs?: number } = {}): void {
  failures = [];
  alarmedAt = 0;
  slowMs = opts.slowMs ?? 2000;
}

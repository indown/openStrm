/**
 * 智能体接入里不经过 HTTP 就能钉住的几件事：
 *   - 调用记录的参数摘要：各种写法的分享链接提取码都抹掉，别的参数（任务名带「-」）不误抹
 *   - 错误 → 给模型的失败结果：包成 HttpError 的网盘错误照样认出账号问题；转存成功后失败的带 received
 *   - 调一次工具：参数严格（多余的参数名报错）、null 当没填、每次都进调用记录（带 IP）
 *   - 限流一次扣多个；作业按 key 找最近一次；令牌换了 IP 立刻记下
 *   - 「在 OpenStrm 里打开」的链接：管理界面地址没填、公网域名也用来打开管理界面时用公网地址
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/agent/agent.test.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { createApiToken, deleteAllApiTokens, getApiToken, touchApiToken } from "../../db/repositories/api-tokens.js";
import { listAgentCalls } from "../../db/repositories/agent-audit.js";
import { readAppSetting, writeAppSetting } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { Cloud115ApiError } from "../cloud-115/client.js";
import { ShareApiError } from "../cloud-115/share.js";
import { driveErrorToHttp } from "../drive/errors.js";
import { ShareGoneError } from "../drive/types.js";
import { callTool } from "./calls.js";
import { NeedsConfirmation, ToolError, confirmFirst, defineTool } from "./define.js";
import { shareLinkWithoutPassword, summarizeArgs, toFailure, uiLink } from "./format.js";
import { __test_resetJobs, latestJob, startJob, waitWithProgress } from "./jobs.js";
import { __test_resetAgentQuota, takeAgentQuota } from "./rate-limit.js";

after(() => {
  deleteAllApiTokens();
  __test_resetJobs();
  __test_resetAgentQuota();
});

test("参数摘要：各种写法的分享链接，提取码都抹掉", () => {
  for (const link of [
    "swhk9bx3wwq-sff1",
    "swhk9bx3wwq?sff1",
    "https://115.com/s/swhk9bx3wwq-sff1",
    "https://115.com/s/swhk9bx3wwq?password=sff1",
    "https://115.com/s/swhk9bx3wwq 提取码：\nsff1",
    "https://pan.quark.cn/s/abcdef123456?pwd=sff1",
  ]) {
    const text = summarizeArgs({ link });
    assert.ok(!text.includes("sff1"), `${link} → ${text}`);
    assert.ok(text.includes("swhk9bx3wwq") || text.includes("abcdef123456"), "分享码本身留着，看得出是哪个分享");
  }
  // REST /api/share 的链接在 url 里
  assert.ok(!summarizeArgs({ action: "list", url: "swhk9bx3wwq-sff1" }).includes("sff1"));
});

test("参数摘要：别的参数不当分享链接抹；URL 里的账号密码、令牌抹掉；太长截断", () => {
  assert.match(summarizeArgs({ task: "tv-show", subPath: "Season-2" }), /tv-show.*Season-2/);
  const ftp = summarizeArgs({ urls: "ftp://user:secret@host/file.mkv" });
  assert.ok(!ftp.includes("secret"), ftp);
  assert.ok(!summarizeArgs({ note: "ostk_abcdefghijklmnopqrstuvwxyz" }).includes("abcdefghij"));
  assert.ok(summarizeArgs({ s: "x".repeat(1000) }).length <= 301);
});

test("失败结果：包成 HttpError 的网盘错误照样认出账号问题，给「别重试」的提示", () => {
  const cookie = toFailure(driveErrorToHttp(new Cloud115ApiError("115：登录超时，请重新登录。", 990001), "失败"));
  assert.match(cookie.hint ?? "", /不要反复重试/);

  // 云下载接口、分享接口回来的也是接口错误：按文案认
  const offline = toFailure(new HttpError(500, "115 读取云下载列表失败：登录超时", {}, { cause: new Cloud115ApiError("115 读取云下载列表失败：登录超时", 990001) }));
  assert.match(offline.hint ?? "", /不要反复重试/);
  const share = toFailure(driveErrorToHttp(new ShareApiError("请重新登录", 990001), "失败"));
  assert.match(share.hint ?? "", /不要反复重试/);

  // 我们自己抛的、路径里恰好有「cookie」的不算
  const own = toFailure(new HttpError(404, "网盘上不存在目录：cookie-405", {}, { cause: new Error("网盘上不存在目录：cookie-405") }));
  assert.doesNotMatch(own.hint ?? "", /不要反复重试/);
});

test("失败结果：转存成功后才失败的带 received 和「别再转存」；分享失效是 SHARE_GONE；工具自己的错误原样", () => {
  const received = toFailure(new HttpError(500, "EEXIST", { received: true }, { cause: new Error("EEXIST") }));
  assert.equal(received.received, true);
  assert.match(received.hint ?? "", /sync_start/);

  assert.equal(toFailure(new ShareGoneError("share not exist", 4100)).code, "SHARE_GONE");
  assert.equal(toFailure(driveErrorToHttp(new ShareGoneError("wrong password", 4101), "失败")).code, "SHARE_GONE");

  const own = toFailure(new ToolError("BUSY", "忙", "等等", { n: 1 }));
  assert.deepEqual(own, { error: "忙", code: "BUSY", hint: "等等", n: 1 });
  assert.match(toFailure(new HttpError(404, "没有")).hint ?? "", /tasks_list/);
});

const echoTool = defineTool({
  name: "echo_test",
  title: "回声",
  description: "测试用：原样返回参数，看看校验怎么处理",
  scope: "read",
  toolset: null,
  annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
  input: z.object({ task: z.string().min(1), limit: z.number().int().max(10).optional() }),
  async run(args) {
    return args;
  },
});

test("调一次工具：多余的参数名报错、null 当没填、参数不对也进调用记录（带 IP）", async () => {
  const { info: token } = createApiToken({ name: "单测", scopes: ["read"], toolsets: ["sync", "transfer"], expiresAt: null });
  const caller = { token, ip: "10.0.0.8" };
  const ctx = { signal: new AbortController().signal, progress() {} };

  const extra = await callTool(echoTool, { task: "tv", item_ids: ["1"] }, caller, ctx);
  assert.equal(extra.ok, false);
  assert.equal(!extra.ok && extra.failure.code, "VALIDATION");
  assert.match(!extra.ok ? extra.failure.error : "", /item_ids/);

  const nulls = await callTool(echoTool, { task: "tv", limit: null }, caller, ctx);
  assert.deepEqual(nulls, { ok: true, data: { task: "tv" } });

  const tooBig = await callTool(echoTool, { task: "tv", limit: 99 }, caller, ctx);
  assert.equal(!tooBig.ok && tooBig.failure.code, "VALIDATION");

  const rows = listAgentCalls({ tokenId: token.id, limit: 10 });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.tool === "echo_test" && r.ip === "10.0.0.8"));
  assert.equal(rows.filter((r) => !r.ok).length, 2);
});

test("限流：一次扣多个，不够就一个都不扣", () => {
  __test_resetAgentQuota();
  const now = 1_000_000;
  assert.ok(takeAgentQuota("k", 29, now).ok);
  const short = takeAgentQuota("k", 2, now);
  assert.equal(short.ok, false);
  assert.ok(!short.ok && short.retryAfterSeconds >= 1);
  assert.ok(takeAgentQuota("k", 1, now).ok, "上一次没扣：还剩的那一个还在");
  assert.equal(takeAgentQuota("k", 1, now).ok, false);
});

test("作业：按 key 找最近发起的那次；结束时状态和结束时间一起有", async () => {
  __test_resetJobs();
  const first = startJob("t", "一", async () => 1, { key: "k1" });
  const second = startJob("t", "二", async () => 2, { key: "k1" });
  // 同一类最多同时跑两个：别的 key 放到另一类里
  startJob("t2", "别的", async () => 3, { key: "k2" });
  assert.equal(latestJob("t", "k1")?.id, second.id);
  assert.equal(latestJob("t", "k2"), undefined);
  assert.equal(latestJob("t2", "k1"), undefined);
  await Promise.all([first.settled, second.settled]);
  assert.equal(second.status, "done");
  assert.ok(second.finishedAt !== undefined);
});

test("令牌的「最近使用」：同一个 IP 60 秒内只写一次，换了 IP 立刻写", () => {
  const { info } = createApiToken({ name: "换 IP", scopes: ["read"], toolsets: ["sync", "transfer"], expiresAt: null });
  const t0 = 2_000_000_000;
  touchApiToken(info.id, "192.168.1.10", t0);
  touchApiToken(info.id, "192.168.1.10", t0 + 5);
  assert.equal(getApiToken(info.id)?.lastUsedAt, t0, "同一个 IP 60 秒内不重复写");
  touchApiToken(info.id, "203.0.113.9", t0 + 10);
  assert.equal(getApiToken(info.id)?.lastUsedIp, "203.0.113.9", "换了 IP 要马上看得到");
  assert.equal(getApiToken(info.id)?.lastUsedAt, t0 + 10);
});

test("「在 OpenStrm 里打开」：填了管理界面地址用它；没填但公网域名也用来打开管理界面就用公网地址；都没有不给链接", () => {
  const saved = readAppSetting("agent");
  try {
    writeAppSetting("agent", { enabled: true, uiBaseUrl: "http://nas:3000/", publicBaseUrl: "https://nas.example.com", publicServesUi: true });
    assert.equal(uiLink("/logs"), "http://nas:3000/logs", "填了的优先，结尾的 / 去掉");
    writeAppSetting("agent", { enabled: true, uiBaseUrl: "", publicBaseUrl: "https://nas.example.com", publicServesUi: true });
    assert.equal(uiLink("home?share=x"), "https://nas.example.com/home?share=x");
    writeAppSetting("agent", { enabled: true, publicBaseUrl: "https://mcp.example.com", publicServesUi: false });
    assert.equal(uiLink("/logs"), undefined, "公网域名只放行智能体用的路径：给了链接也打不开");
  } finally {
    writeAppSetting("agent", saved);
  }
});

test("等的时候推进度：数字涨了才推（规范要求只增不减），等到了就停；没给快照不推", async () => {
  const sent: Array<[number, number | undefined, string | undefined]> = [];
  const ctx = { signal: new AbortController().signal, progress: (p: number, t?: number, m?: string) => void sent.push([p, t, m]) };
  const snaps = [{ done: 1, total: 4 }, { done: 1, total: 4 }, { done: 0, total: 9, message: "换阶段" }, { done: 3, total: 4, message: "三" }];
  let i = 0;
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const waiting = waitWithProgress(done, 5000, ctx, () => snaps[Math.min(i++, snaps.length - 1)], 5);
  await new Promise((r) => setTimeout(r, 60));
  finish();
  await waiting;
  assert.deepEqual(sent, [
    [1, 4, undefined],
    [3, 4, "三"],
  ]);
  const quiet: unknown[] = [];
  await waitWithProgress(Promise.resolve(), 1000, { ...ctx, progress: () => void quiet.push(1) }, () => null, 5);
  assert.equal(quiet.length, 0);
});

test("当面确认：拒绝先判（重试时客户端没再声明 elicitation 也算数）；弹不了框就放行；弹得了、还没问过就要确认", () => {
  const base = { token: undefined as never, signal: new AbortController().signal, progress() {} };
  assert.throws(() => confirmFirst({ ...base, canConfirm: false, confirmation: "declined" }, "x"), (e) => e instanceof ToolError && e.code === "DECLINED");
  assert.throws(() => confirmFirst({ ...base, canConfirm: true, confirmation: "declined" }, "x"), (e) => e instanceof ToolError && e.code === "DECLINED");
  assert.doesNotThrow(() => confirmFirst({ ...base, canConfirm: false }, "x"));
  assert.doesNotThrow(() => confirmFirst({ ...base, canConfirm: true, confirmation: "accepted" }, "x"));
  assert.throws(() => confirmFirst({ ...base, canConfirm: true }, "要删 3 个"), (e) => e instanceof NeedsConfirmation && e.message === "要删 3 个");
});

const nestedTool = defineTool({
  name: "nested_test",
  title: "测试",
  description: "测试用：对象数组里的 null 也当没填",
  scope: "read",
  toolset: null,
  annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
  input: z.object({ changes: z.array(z.object({ target: z.string(), season: z.number().optional() }).strict()) }),
  async run(args) {
    return args;
  },
});

test("调一次工具：对象数组里没填的字段写成 null（严格模式的习惯）也当没填", async () => {
  const { info: token } = createApiToken({ name: "单测嵌套", scopes: ["read"], toolsets: ["sync"], expiresAt: null });
  const r = await callTool(nestedTool, { changes: [{ target: "u1", season: null }] }, { token, ip: "10.0.0.9" }, { signal: new AbortController().signal, progress() {} });
  assert.deepEqual(r, { ok: true, data: { changes: [{ target: "u1" }] } });
});

test("分享链接去掉提取码：夸克的「链接 … 提取码：…」整段、115 的「码-提取码」和 ?password=，都只剩干净的链接", () => {
  assert.equal(shareLinkWithoutPassword("链接：https://pan.quark.cn/s/abc123def456 提取码：ABCD"), "https://pan.quark.cn/s/abc123def456");
  assert.equal(shareLinkWithoutPassword("https://pan.quark.cn/s/abc123def456?pwd=ABCD"), "https://pan.quark.cn/s/abc123def456");
  for (const link of ["https://115.com/s/sw3abc12345-qz9k", "https://115.com/s/sw3abc12345?password=qz9k", "sw3abc12345-qz9k"]) {
    const clean = shareLinkWithoutPassword(link);
    assert.ok(!clean.includes("qz9k"), `${link} → ${clean}`);
    assert.match(clean, /sw3abc12345/);
  }
});

test("参数摘要：追更的 receiveCode、shareUrl 里的提取码也抹掉", () => {
  const text = summarizeArgs({ shareUrl: "https://pan.quark.cn/s/abc123def456?pwd=ABCD", receiveCode: "ABCD", name: "剧" });
  assert.ok(!text.includes("ABCD"), text);
  assert.match(text, /abc123def456/);
});

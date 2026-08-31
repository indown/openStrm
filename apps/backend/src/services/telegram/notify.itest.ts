/**
 * 通知入口：开关过滤、去重、模板转义。发送函数换成桩。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/telegram/notify.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { __test_resetNotify, classifyAccountIssue, notify, setNotifySender } from "./notify.js";

const baseline = readAppSettings();
const sent: Array<{ chatId: string; text: string }> = [];
const task = { id: "t1", originPath: "tv/<剧集>", targetPath: "tv", account: "主号" };

before(() => setNotifySender(async (chatId, text) => { sent.push({ chatId, text }); }));
beforeEach(() => {
  sent.length = 0;
  __test_resetNotify();
  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100" } });
});
after(() => {
  setNotifySender(null);
  replaceAppSettings(baseline);
});

test("没配 token 或 chatId 就不发", async () => {
  replaceAppSettings({ ...baseline, telegram: { botToken: "t" } });
  assert.equal(await notify({ type: "task-start", task, total: 3 }), false);
  assert.equal(sent.length, 0);
});

test("默认开关：任务开始不发，完成 / 失败 / 云下载 / 账号告警发；可以逐项关掉", async () => {
  assert.equal(await notify({ type: "task-start", task, total: 3 }), false);
  assert.equal(await notify({ type: "task-done", task, status: "completed", total: 3, finished: 3, failed: 0, durationMs: 65_000 }), true);
  assert.match(sent[0].text, /✅ <b>同步完成<\/b>\ntv\/&lt;剧集&gt; → tv\n3\/3 个文件，用时 1 分 5 秒/);
  assert.equal(sent[0].chatId, "-100");

  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100", notify: { taskDone: false, taskStart: true } } });
  assert.equal(await notify({ type: "task-done", task, status: "completed", total: 3, finished: 3, failed: 0, durationMs: 1 }), false);
  assert.equal(await notify({ type: "task-start", task, total: 3, trigger: "cron" }), true);
  assert.match(sent.at(-1)!.text, /🚀 <b>任务开始<\/b>（定时）/);
});

test("失败与取消的文案带数量和原因，原因做 HTML 转义", async () => {
  await notify({ type: "task-done", task, status: "failed", total: 5, finished: 4, failed: 1, durationMs: 1000, message: "1 个文件失败：<x>.nfo" });
  assert.match(sent[0].text, /❌ <b>同步失败<\/b>[\s\S]*完成 4\/5 个文件，失败 1[\s\S]*1 个文件失败：&lt;x&gt;\.nfo/);
  await notify({ type: "task-done", task, status: "cancelled", total: 5, finished: 2, failed: 0, durationMs: 1000, message: "用户取消" });
  assert.match(sent[1].text, /⏹ <b>任务已取消<\/b>[\s\S]*完成 2\/5 个文件\n用户取消/);
});

test("账号告警：认得出 cookie 失效和封控，同一账号同一原因一小时只发一次；认不出的不发", async () => {
  assert.equal(classifyAccountIssue("115：登录超时，请重新登录。（errno 990001）"), "cookie");
  assert.equal(classifyAccountIssue("115 接口返回 405: 您的访问被阻断"), "blocked");
  assert.equal(classifyAccountIssue("socket hang up"), null);

  assert.equal(await notify({ type: "account-alert", account: "主号", reason: "socket hang up", source: "网盘监控" }), false);
  assert.equal(await notify({ type: "account-alert", account: "主号", reason: "登录超时，请重新登录", source: "网盘监控" }), true);
  assert.match(sent[0].text, /⚠️ <b>115 账号需要处理<\/b>\n账号 <b>主号<\/b> 的 cookie 已失效[\s\S]*来源：网盘监控/);
  assert.equal(await notify({ type: "account-alert", account: "主号", reason: "登录超时，请重新登录", source: "网盘监控" }), false, "一小时内不重复");
  assert.equal(await notify({ type: "account-alert", account: "小号", reason: "登录超时", source: "网盘监控" }), true, "别的账号照发");
  assert.equal(await notify({ type: "account-alert", account: "主号", reason: "您的访问被阻断 405", source: "同步" }), true, "同账号不同原因照发");
});

test("启动失败：账号问题按账号告警去重（定时触发不会每半小时响一次），其它原因按任务去重", async () => {
  assert.equal(await notify({ type: "task-start-failed", task, reason: "读取 115 目录失败：登录超时，请重新登录", trigger: "cron" }), true);
  assert.match(sent[0].text, /115 账号需要处理[\s\S]*来源：任务 tv\/&lt;剧集&gt; → tv/);
  assert.equal(await notify({ type: "task-start-failed", task, reason: "读取 115 目录失败：登录超时，请重新登录", trigger: "cron" }), false);
  assert.equal(await notify({ type: "account-alert", account: "主号", reason: "登录超时", source: "网盘监控" }), false, "监控撞到同一件事也不再响");

  assert.equal(await notify({ type: "task-start-failed", task, reason: "OpenList 登录失败", trigger: "cron" }), true);
  assert.match(sent.at(-1)!.text, /❌ <b>任务启动失败<\/b>（定时触发）\ntv\/&lt;剧集&gt; → tv\nOpenList 登录失败/);
  assert.equal(await notify({ type: "task-start-failed", task, reason: "OpenList 登录失败", trigger: "cron" }), false);
});

test("云下载：完成与失败", async () => {
  assert.equal(await notify({ type: "offline-done", name: "Show <S01>", detail: "已生成 8 个 strm", target: "tv/Show" }), true);
  assert.match(sent[0].text, /☁️ <b>云下载完成<\/b>\nShow &lt;S01&gt;\n已生成 8 个 strm\n→ tv\/Show/);
  assert.equal(await notify({ type: "offline-failed", name: "x", detail: "115 下载失败：资源违规" }), true);
  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100", notify: { offline: false } } });
  assert.equal(await notify({ type: "offline-done", name: "y", detail: "", target: "" }), false);
});

test("Emby 入库：按剧聚合、连号折叠、电影带年份；批量只报总数；开关可关", async () => {
  const groups = [
    { kind: "tv" as const, name: "怪奇物语", season: 5, episodes: [5, 6, 7, 9], count: 4 },
    { kind: "movie" as const, name: "沙丘 2", year: 2024, episodes: [], count: 1 },
  ];
  assert.equal(await notify({ type: "emby-new", groups, total: 5 }), true);
  assert.match(sent[0].text, /📥 <b>Emby 入库<\/b>\n《怪奇物语》 S05 新增 4 集：E05-E07、E09\n《沙丘 2》\(2024\)/);

  assert.equal(await notify({ type: "emby-new", groups: [], total: 120 }), true);
  assert.match(sent[1].text, /新增 120 个条目（数量太多，不逐条列了）/);

  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100", notify: { embyNew: false } } });
  assert.equal(await notify({ type: "emby-new", groups, total: 5 }), false);
});

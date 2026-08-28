/**
 * 机器人的命令、链接、按钮：所有外部依赖都是桩，只验证"谁能做什么、调了什么、回了什么"。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/telegram/commands.test.ts
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { AppSettings, TaskDefinition, TaskExecutionSummary } from "@openstrm/shared";
import type { BotLike, InlineKeyboard, TelegramUpdate } from "./bot.js";
import { handleUpdate, setCommandDeps, type CommandDeps } from "./commands.js";
import { __test_clearPending } from "./session.js";

type Sent = { chatId: string; text: string; buttons?: InlineKeyboard };
const sent: Sent[] = [];
const edited: Sent[] = [];
const answered: string[] = [];
const bot: BotLike = {
  async sendMessage(chatId, text, opts) {
    sent.push({ chatId: String(chatId), text, buttons: opts?.buttons });
    return { ok: true, result: { message_id: 1 } };
  },
  async editMessage(chatId, _id, text, buttons) {
    edited.push({ chatId: String(chatId), text, buttons });
    return { ok: true };
  },
  async answerCallback(_id, text) {
    answered.push(text ?? "");
    return { ok: true };
  },
};

const tasks: TaskDefinition[] = [
  { id: "t1", account: "115", accountType: "115", originPath: "tv", targetPath: "tv", strmPrefix: "/mnt", cronExpression: "0 3 * * *" },
  { id: "t2", account: "ol", accountType: "openlist", originPath: "kuake/anime", targetPath: "anime", strmPrefix: "http://x" },
];
const run = (over: Partial<TaskExecutionSummary>): TaskExecutionSummary => ({
  id: "e1", taskId: "t1", startTime: Date.now() - 60_000, endTime: Date.now(), status: "completed",
  summary: { totalFiles: 10, downloadedFiles: 10, deletedFiles: 0 },
  taskInfo: { account: "115", originPath: "tv", targetPath: "tv", removeExtraFiles: false },
  ...over,
});

let settings: AppSettings;
const calls: Array<{ fn: string; args: unknown }> = [];
let running: string[] = [];

const deps: Partial<CommandDeps> = {
  settings: () => settings,
  listTasks: () => tasks,
  accounts115: () => ["115"],
  latestExecutions: () => new Map([["t1", run({})]]),
  recentExecutions: () => [run({}), run({ id: "e2", taskId: "t2", status: "failed", summary: { totalFiles: 3, downloadedFiles: 1, deletedFiles: 0, failedFiles: 2, errorMessage: "2 个文件失败：a、b" } })],
  taskExecutions: (taskId) => (taskId === "t1" ? [run({})] : []),
  runningTaskIds: () => running,
  runningPercent: () => "42.10",
  startTask: async (taskId) => { calls.push({ fn: "startTask", args: taskId }); return { ok: true, message: "开始处理 5 个文件" }; },
  cancelTask: (taskId) => { calls.push({ fn: "cancelTask", args: taskId }); return running.includes(taskId); },
  addOffline: async (input) => {
    calls.push({ fn: "addOffline", args: input });
    return { account: "115", dirId: "9", dirPath: "tv", added: 1, failed: 1, invalid: [], followup: Boolean(input.taskId),
      results: [{ url: "magnet:?xt=urn:btih:aaa", ok: true, infoHash: "h" }, { url: "magnet:?xt=urn:btih:bbb", ok: false, message: "任务已存在" }] };
  },
  listOffline: async () => ({ tasks: [{ name: "Show.mkv", state: "done", statusText: "下载成功", percent: 100 }], count: 1, quota: 5, total: 10 }),
  offlinePending: () => 2,
  lifeStatus: () => ({ running: true, account: "115", lastError: null }),
  shareInfo: async (link) => {
    calls.push({ fn: "shareInfo", args: link });
    return { shareCode: "sc", receiveCode: "rc", name: "剧集合集", count: 2, items: [{ id: "1", name: "S01", isDir: true }, { id: "2", name: "readme.txt", isDir: false }] };
  },
  receiveShare: async (input) => { calls.push({ fn: "receiveShare", args: input }); return { ok: true, message: "已转存，后台同步已启动" }; },
};

const msg = (text: string, o: { user?: number; chat?: number; type?: string } = {}): TelegramUpdate => ({
  update_id: 1,
  message: {
    message_id: 10,
    from: { id: o.user ?? 42, is_bot: false, first_name: "A" },
    chat: { id: o.chat ?? o.user ?? 42, type: o.type ?? "private" },
    date: 0,
    text,
  },
});
const cb = (data: string, o: { user?: number; chat?: number; type?: string } = {}): TelegramUpdate => ({
  update_id: 2,
  callback_query: {
    id: "q",
    from: { id: o.user ?? 42, is_bot: false, first_name: "A" },
    message: { message_id: 10, chat: { id: o.chat ?? o.user ?? 42, type: o.type ?? "private" }, date: 0 },
    data,
  },
});
const lastButtons = () => sent[sent.length - 1].buttons ?? [];
const findButton = (needle: string) => lastButtons().flat().find((b) => b.text.includes(needle));

beforeEach(() => {
  settings = { telegram: { botToken: "t", chatId: "-100", allowedUsers: [42], allowTaskStart: false, allowOfflineAdd: false, allowShareReceive: false } };
  sent.length = 0; edited.length = 0; answered.length = 0; calls.length = 0; running = [];
  __test_clearPending();
  setCommandDeps(deps);
});
after(() => setCommandDeps(null));

test("权限：私聊里的陌生人得到自己的 id；群里的陌生人被无视；非指定群里的白名单用户也被无视", async () => {
  await handleUpdate(bot, msg("/tasks", { user: 7 }));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /<code>7<\/code>/);
  await handleUpdate(bot, msg("/tasks", { user: 7, chat: -100, type: "supergroup" }));
  assert.equal(sent.length, 1, "群里不理陌生人");
  await handleUpdate(bot, msg("/tasks", { user: 42, chat: -200, type: "supergroup" }));
  assert.equal(sent.length, 1, "不是配置的那个群也不理");
  await handleUpdate(bot, msg("/tasks@openstrm_bot", { user: 42, chat: -100, type: "supergroup" }));
  assert.equal(sent.length, 2, "指定的群里响应，且能处理 /cmd@bot 的写法");
  assert.match(sent[1].text, /任务（2）/);
});

test("/tasks：列出任务、上次结果、定时；未开启启动权限时没有「运行」按钮并有提示", async () => {
  await handleUpdate(bot, msg("/tasks"));
  const { text } = sent[0];
  assert.match(text, /tv → tv/);
  assert.match(text, /kuake\/anime → anime/);
  assert.match(text, /✅ 成功 · 10\/10 个文件/);
  assert.match(text, /<code>0 3 \* \* \*<\/code>/);
  assert.match(text, /「运行」按钮未开启/);
  assert.equal(findButton("运行"), undefined);
  assert.ok(findButton("记录"));

  settings.telegram!.allowTaskStart = true;
  sent.length = 0;
  await handleUpdate(bot, msg("/tasks"));
  assert.equal(findButton("运行")?.callback_data, "run:t1");
});

test("运行按钮：关着时只提示；开着时经 startTask 启动并回结果；回调也过白名单", async () => {
  await handleUpdate(bot, cb("run:t1"));
  assert.equal(calls.length, 0, "未开启不能启动");
  assert.match(sent[0].text, /未开启/);

  settings.telegram!.allowTaskStart = true;
  sent.length = 0;
  await handleUpdate(bot, cb("run:t1"));
  assert.deepEqual(calls, [{ fn: "startTask", args: "t1" }]);
  assert.match(sent[0].text, /🚀 <b>tv → tv<\/b>\n开始处理 5 个文件/);

  calls.length = 0;
  await handleUpdate(bot, cb("run:t1", { user: 7 }));
  assert.equal(calls.length, 0, "陌生人点按钮不能启动");
  assert.equal(answered.at(-1), "没有权限");
});

test("/status 和 /cancel：正在跑的任务带进度，取消按钮走 cancelTask", async () => {
  running = ["t1"];
  await handleUpdate(bot, msg("/status"));
  assert.match(sent[0].text, /🔄 tv → tv · 42.10%/);
  assert.match(sent[0].text, /2 个下载完成后待生成 strm/);
  assert.match(sent[0].text, /网盘监控：运行中（账号 115）/);

  await handleUpdate(bot, msg("/cancel"));
  assert.equal(findButton("tv")?.callback_data, "cancel:t1");
  await handleUpdate(bot, cb("cancel:t1"));
  assert.deepEqual(calls, [{ fn: "cancelTask", args: "t1" }]);
  assert.match(sent.at(-1)!.text, /已取消 tv → tv/);

  running = [];
  sent.length = 0;
  await handleUpdate(bot, msg("/cancel"));
  assert.match(sent[0].text, /没有正在运行的任务/);
});

test("/history、记录按钮、/offline", async () => {
  await handleUpdate(bot, msg("/history"));
  assert.match(sent[0].text, /kuake\/anime → anime[\s\S]*❌ 失败 · 2 个文件失败：a、b/);
  await handleUpdate(bot, cb("hist:t1"));
  assert.match(sent[1].text, /<b>tv → tv<\/b>\n\n✅ 成功/);
  await handleUpdate(bot, cb("hist:t2"));
  assert.match(sent[2].text, /还没有执行记录/);
  await handleUpdate(bot, msg("/offline"));
  assert.match(sent[3].text, /共 1，配额剩余 5\/10[\s\S]*✅ Show\.mkv · 下载成功/);
});

test("贴磁力链接：未开启时提示；开启后给目的地按钮，点任务目录后调 addOffline 并改写原消息", async () => {
  await handleUpdate(bot, msg("magnet:?xt=urn:btih:aaa\nmagnet:?xt=urn:btih:bbb"));
  assert.match(sent[0].text, /云下载功能未开启/);

  settings.telegram!.allowOfflineAdd = true;
  sent.length = 0;
  await handleUpdate(bot, msg("magnet:?xt=urn:btih:aaa\nmagnet:?xt=urn:btih:bbb\nthunder://x"));
  assert.match(sent[0].text, /收到 2 条链接/);
  const dest = findButton("tv")!;
  assert.match(dest.callback_data, /^ofl:[\w-]+:t1$/);
  assert.equal(findButton("anime"), undefined, "openlist 账号的任务不能当云下载目的地");
  assert.ok(findButton("115 默认目录"));

  await handleUpdate(bot, cb(dest.callback_data));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { fn: "addOffline", args: { urls: "magnet:?xt=urn:btih:aaa\nmagnet:?xt=urn:btih:bbb", taskId: "t1" } });
  assert.equal(edited.length, 1, "结果写回原消息，按钮摘掉");
  assert.match(edited[0].text, /已添加 1 个云下载[\s\S]*目录：tv，下完自动生成 strm[\s\S]*未接受 1 条[\s\S]*任务已存在/);

  await handleUpdate(bot, cb(dest.callback_data));
  assert.equal(calls.length, 1, "同一个按钮再点一次不会重复提交");
  assert.equal(answered.at(-1), "已过期，请重新发一次链接");
});

test("贴磁力链接：默认目录不带 taskId；别人不能点我的按钮；「取消」把消息改成已取消", async () => {
  settings.telegram!.allowOfflineAdd = true;
  await handleUpdate(bot, msg("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  const dflt = findButton("115 默认目录")!;
  const drop = findButton("取消")!;
  await handleUpdate(bot, cb(dflt.callback_data, { user: 7 }));
  assert.equal(calls.length, 0);
  await handleUpdate(bot, cb(dflt.callback_data));
  assert.deepEqual(calls[0], { fn: "addOffline", args: { urls: "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", taskId: undefined } });

  sent.length = 0; edited.length = 0;
  await handleUpdate(bot, msg("magnet:?xt=urn:btih:ccc"));
  const drop2 = findButton("取消")!;
  await handleUpdate(bot, cb(drop2.callback_data));
  assert.match(edited[0].text, /已取消/);
  void drop;
});

test("贴 115 分享链接：读分享、列前几项、选任务后走 receiveShare", async () => {
  await handleUpdate(bot, msg("https://115cdn.com/s/swhk9bx3wwq?password=sff1"));
  assert.match(sent[0].text, /分享转存功能未开启/);

  settings.telegram!.allowShareReceive = true;
  sent.length = 0;
  await handleUpdate(bot, msg("看看这个 https://115cdn.com/s/swhk9bx3wwq?password=sff1 不错"));
  assert.deepEqual(calls, [{ fn: "shareInfo", args: "https://115cdn.com/s/swhk9bx3wwq?password=sff1" }]);
  assert.match(sent[0].text, /📦 <b>剧集合集<\/b>\n📁 S01\n📄 readme\.txt/);
  const dest = findButton("转存到 tv")!;
  calls.length = 0;
  await handleUpdate(bot, cb(dest.callback_data));
  assert.equal(calls[0].fn, "receiveShare");
  // deepEqual 的断言签名把 calls 收窄成了 args: string，这里要先绕回 unknown
  const args = calls[0].args as unknown as { task: TaskDefinition; shareCode: string; fileIds: string[] };
  assert.equal(args.task.id, "t1");
  assert.equal(args.shareCode, "sc");
  assert.deepEqual(args.fileIds, ["1", "2"]);
  assert.match(edited[0].text, /✅ <b>剧集合集<\/b>\n目录：tv\n已转存，后台同步已启动/);
});

test("其它文本：不认识的链接和闲聊各有提示；/help 说明当前开关状态；/id 回 chat id", async () => {
  await handleUpdate(bot, msg("thunder://abc"));
  assert.match(sent[0].text, /不认识这种链接/);
  await handleUpdate(bot, msg("你好"));
  assert.match(sent[1].text, /直接把 115 分享链接/);
  await handleUpdate(bot, msg("/help"));
  assert.match(sent[2].text, /未开启，到 Telegram 页打开/);
  await handleUpdate(bot, msg("/id"));
  assert.match(sent[3].text, /<code>42<\/code>/);
});

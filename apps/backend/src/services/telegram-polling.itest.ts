/**
 * Telegram 按钮启动任务的开关验证。
 *
 * 钉住「默认不动手、显式开启才动手」这个行为——按钮会真的跑任务，
 * 不能因为一次升级就悄悄生效。
 *
 *   CONFIG_DIR=... DATA_DIR=... npx tsx src/services/telegram-polling.itest.ts
 */
import assert from "node:assert/strict";
import { setTaskStarter, __test_handleCallbackQuery } from "./telegram-polling.js";
import { readAppSettings, replaceAppSettings } from "../db/repositories/settings.js";
import { listTasks, replaceTasks } from "../db/repositories/tasks.js";

const sent: string[] = [];
const bot = {
  answerCallbackQuery: async () => {},
  sendMessage: async (m: { text: string }) => { sent.push(m.text); },
} as unknown as Parameters<typeof __test_handleCallbackQuery>[0];

let started: string[] = [];
setTaskStarter(async (taskId) => { started.push(taskId); return { ok: true, body: "{}" }; });

const baseline = readAppSettings();

/**
 * 自己造一条任务再跑：handler 找不到任务只会回 "Task not found"，
 * 空库时用例必挂。
 */
const existing = listTasks();
if (existing.length === 0) {
  replaceTasks([
    {
      id: "itest-task",
      account: "itest",
      originPath: "/tv",
      targetPath: "/data/tv",
    },
  ]);
}
const taskId = listTasks()[0].id;
const callback = { id: "q1", data: `start_task_${taskId}`, message: { chat: { id: 123 } } };

function withAllowTaskStart(allow: boolean) {
  replaceAppSettings({
    ...baseline,
    telegram: { ...(baseline.telegram ?? {}), allowTaskStart: allow },
  });
  sent.length = 0;
  started = [];
}

async function main() {
  let pass = 0;

  withAllowTaskStart(false);
  await __test_handleCallbackQuery(bot, callback);
  assert.equal(started.length, 0, "开关关闭时绝不能启动任务");
  assert.match(sent.join("\n"), /任务启动未开启/);
  pass++; console.log("  ok  默认关闭：不启动任务，只回一条说明");

  withAllowTaskStart(true);
  await __test_handleCallbackQuery(bot, callback);
  assert.deepEqual(started, [taskId], "开启后应经 taskStarter 启动任务");
  pass++; console.log("  ok  显式开启后：经注入的 taskStarter 启动任务");

  // 执行器报失败时要把原因回给用户，而不是当成功、也不是抛出去炸掉轮询
  setTaskStarter(async () => ({ ok: false, body: JSON.stringify({ message: "boom" }) }));
  withAllowTaskStart(true);
  await __test_handleCallbackQuery(bot, callback);
  assert.equal(started.length, 0);
  assert.match(sent.join("\n"), /Failed to start task[\s\S]*boom/);
  pass++; console.log("  ok  执行器失败时把原因回给用户");
  setTaskStarter(null);

  console.log(`\n${pass} passed`);
}

main()
  .then(() => replaceAppSettings(baseline))
  .catch((err) => { replaceAppSettings(baseline); console.error(err); process.exit(1); });

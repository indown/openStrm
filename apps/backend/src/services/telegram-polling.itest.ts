/**
 * Telegram 按钮启动任务的开关验证。
 *
 * 这条链路此前因为请求地址和鉴权都不对而从未生效过，修好之后默认保持关闭，
 * 这个用例就是用来钉住「默认不动手、显式开启才动手」这个行为的。
 *
 *   CONFIG_DIR=... DATA_DIR=... npx tsx src/services/telegram-polling.itest.ts
 */
import assert from "node:assert/strict";
import { setTaskStarter, __test_handleCallbackQuery } from "./telegram-polling.js";
import { readAppSettings, writeAppSettings } from "../db/repositories/settings.js";
import { listTasks, writeTasks } from "../db/repositories/tasks.js";

const sent: string[] = [];
const bot = {
  answerCallbackQuery: async () => {},
  sendMessage: async (m: { text: string }) => { sent.push(m.text); },
} as unknown as Parameters<typeof __test_handleCallbackQuery>[0];

let started: string[] = [];
setTaskStarter(async (taskId) => { started.push(taskId); return { ok: true, body: "{}" }; });

const baseline = readAppSettings();

/**
 * 自己造一条任务再跑。
 * 原来是 `listTasks()[0]?.id ?? "task-1"`，空库时退回一个并不存在的 id，
 * 而 handler 找不到任务只会回 "Task not found"，用例必挂——
 * 等于这个测试只能在"库里恰好有任务"的机器上通过，CI 里跑不了。
 */
const existing = listTasks();
if (existing.length === 0) {
  writeTasks([
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
  writeAppSettings({
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

  // 没注入执行器时也不能炸，更不能绕过去
  setTaskStarter(null);
  withAllowTaskStart(true);
  await __test_handleCallbackQuery(bot, callback);
  assert.equal(started.length, 0);
  assert.match(sent.join("\n"), /Task runner unavailable/);
  pass++; console.log("  ok  执行器未就绪时安全降级");

  console.log(`\n${pass} passed`);
}

main()
  .then(() => writeAppSettings(baseline))
  .catch((err) => { writeAppSettings(baseline); console.error(err); process.exit(1); });

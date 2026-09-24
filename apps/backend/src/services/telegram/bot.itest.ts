/**
 * TelegramBot 对着本地假的 Bot API：失败时回的形状（命令处理器认「message is not modified」、commands.test.ts 的桩都照这个来），
 * 以及发出去的字符串里不留半个 emoji。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/telegram/bot.itest.ts
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import http from "node:http";
import type { AppSettings } from "@openstrm/shared";
import { TelegramBot, type TelegramUpdate } from "./bot.js";
import { handleUpdate, setCommandDeps } from "./commands.js";

const NOT_MODIFIED = "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message";

// ---- 假 Bot API：记下每次调用；editMessageText 和真的一样，内容没变就回 400 ----
const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
/** chat_id:message_id → 当前的正文和按钮 */
const contents = new Map<string, string>();

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const method = new URL(req.url ?? "/", "http://x").pathname.split("/").pop() ?? "";
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    requests.push({ method, body });
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (method === "editMessageText") {
      const key = `${body.chat_id}:${body.message_id}`;
      const content = JSON.stringify([body.text, body.reply_markup]);
      if (contents.get(key) === content) return json(400, { ok: false, error_code: 400, description: NOT_MODIFIED });
      contents.set(key, content);
      return json(200, { ok: true, result: true });
    }
    json(200, { ok: true, result: method === "sendMessage" ? { message_id: 99 } : true });
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const bot = new TelegramBot("t", `http://127.0.0.1:${(server.address() as { port: number }).port}`);

const settings: AppSettings = { telegram: { botToken: "t", chatId: "-100", allowedUsers: [42] } };

beforeEach(() => {
  requests.length = 0;
  contents.clear();
  setCommandDeps({ settings: () => settings });
});
after(() => {
  setCommandDeps(null);
  server.close();
});

test("Bot API 回 4xx：原话在 error 里、description 是空的（commands 的测试桩照这个形状回）", async () => {
  assert.equal((await bot.editMessage(42, 10, "同一段")).ok, true);
  assert.deepEqual(await bot.editMessage(42, 10, "同一段"), { ok: false, error: NOT_MODIFIED, error_code: 400 });
});

test("连点两下「取消」：第二次改不动（not modified）就当改好了，不再发一条「已取消。」", async () => {
  const tap: TelegramUpdate = {
    update_id: 1,
    callback_query: {
      id: "q",
      from: { id: 42, is_bot: false, first_name: "A" },
      message: { message_id: 10, chat: { id: 42, type: "private" }, date: 0 },
      data: "drop:gone",
    },
  };
  await handleUpdate(bot, tap);
  await handleUpdate(bot, tap);
  assert.deepEqual(
    requests.map((r) => r.method),
    ["answerCallbackQuery", "editMessageText", "answerCallbackQuery", "editMessageText"],
  );
});

test("发出去的正文、按钮文字里落单的半个 emoji 换成 U+FFFD，成对的原样", async () => {
  const half = "\uD83D";
  await bot.sendMessage(42, `🔍 在搜「甲${half}」…`, { buttons: [[{ text: `📁 乙${half}`, callback_data: "x" }]] });
  await bot.editMessage(42, 10, `${half}丙`);
  const [send, edit] = requests.map((r) => r.body) as Array<{ text: string; reply_markup: { inline_keyboard: Array<Array<{ text: string }>> } }>;
  assert.equal(send.text, "🔍 在搜「甲\uFFFD」…");
  assert.equal(send.reply_markup.inline_keyboard[0][0].text, "📁 乙\uFFFD");
  assert.equal(edit.text, "\uFFFD丙");
});

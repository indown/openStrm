/**
 * 「加入影库」收的分享写法和 /api/share 一样：整段「链接：… 提取码：…」、夸克链接外面包着中文标点、115 的裸分享码
 * （码?password=提取码）都认；存的是认出来的链接和提取码，不是用户贴的那一整段。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/library/library.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, AppSettings, MediaLibraryEntry } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import libraryRoute from "./index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { remove } from "../../db/repositories/media-library.js";
import { deleteAppSetting, readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { settings: AppSettings; accounts: AccountInfo[] };
const created: string[] = [];

before(async () => {
  baseline = { settings: readAppSettings(), accounts: listAccounts() };
  // 没有账号：不去网盘上补标题；没有 TMDB：不排刮削
  replaceAccounts([]);
  deleteAppSetting("tmdb");
  await writeAuthPassword("library-itest-pw");

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(libraryRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  for (const id of created) remove(id);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  await writeAuthPassword(DEFAULT_AUTH.password);
});

async function add(payload: Record<string, unknown>): Promise<{ mode: string; entry: MediaLibraryEntry }> {
  const res = await app.inject({ method: "POST", url: "/api/library", headers: auth, payload });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as { mode: string; entry: MediaLibraryEntry };
  created.push(body.entry.id);
  return body;
}

test("整段「链接：… 提取码：…」也能加入影库：存认出来的链接，提取码单存一份", async () => {
  const { mode, entry } = await add({ shareUrl: "链接：https://115.com/s/swlib001xyz 提取码：abcd", title: "沙丘2", fileCount: 3 });
  assert.equal(mode, "single");
  assert.equal(entry.shareCode, "swlib001xyz");
  assert.equal(entry.receiveCode, "abcd");
  assert.equal(entry.shareUrl, "https://115.com/s/swlib001xyz?password=abcd");
});

test("115 叫访问码、夸克链接外面包着中文标点、裸分享码带 ?password=：提取码都认得对", async () => {
  const sub = await add({ shareUrl: "【链接：https://115.com/s/swlib002xyz】访问码：u796", cid: "123", rawName: "Season 1", sharePath: "繁花/Season 1" });
  assert.equal(sub.mode, "subdir");
  assert.equal(sub.entry.receiveCode, "u796");
  assert.equal(sub.entry.shareUrl, "https://115.com/s/swlib002xyz?password=u796");

  const quark = await add({ shareUrl: "「https://pan.quark.cn/s/lib003abcdef?pwd=ab12」", title: "繁花", fileCount: 1 });
  assert.equal(quark.entry.shareCode, "lib003abcdef");
  assert.equal(quark.entry.receiveCode, "ab12");
  assert.equal(quark.entry.shareUrl, "https://pan.quark.cn/s/lib003abcdef?pwd=ab12");

  const bare = await add({ shareUrl: "swlib004xyz?password=v421", title: "三体", fileCount: 1 });
  assert.equal(bare.entry.shareCode, "swlib004xyz");
  assert.equal(bare.entry.receiveCode, "v421");
  assert.equal(bare.entry.shareUrl, "https://115.com/s/swlib004xyz?password=v421");
});

test("认不出分享的还是 400", async () => {
  const res = await app.inject({ method: "POST", url: "/api/library", headers: auth, payload: { shareUrl: "随便一句话" } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().message, "Invalid share url");
});

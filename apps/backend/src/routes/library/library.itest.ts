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
import { getById, remove } from "../../db/repositories/media-library.js";
import { isLibraryShare } from "../../db/repositories/library-shares.js";
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

test("季目录子目录：标题和年份从上一级的作品目录来，rawName 还是网盘上的目录名", async () => {
  const { mode, entry } = await add({
    shareUrl: "https://115.com/s/swlib005xyz?password=w123",
    cid: "3087",
    rawName: "Season 2",
    sharePath: "美剧/怒呛人生 (2023)/Season 2",
  });
  assert.equal(mode, "subdir");
  assert.equal(entry.title, "怒呛人生 · Season 2");
  assert.equal(entry.year, "2023");
  assert.equal(entry.rawName, "Season 2");
  assert.equal(entry.sharePath, "/美剧/怒呛人生 (2023)/Season 2");
});

test("DELETE /api/library/:id：删条目，这个分享没别的条目在用了就不再巡检；再删一次 404", async () => {
  const { entry } = await add({ shareUrl: "https://115.com/s/swlib006xyz?password=abcd", title: "删我", fileCount: 1 });
  assert.equal(isLibraryShare(entry.shareCode), true, "加进来的分享要登记巡检");
  const res = await app.inject({ method: "DELETE", url: `/api/library/${entry.id}`, headers: auth });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(getById(entry.id), null);
  assert.equal(isLibraryShare(entry.shareCode), false, "分享没人用了，巡检登记一起去掉");
  const again = await app.inject({ method: "DELETE", url: `/api/library/${entry.id}`, headers: auth });
  assert.equal(again.statusCode, 404);
});

test("PUT /api/library/:id 改提取码：同一个分享收的几处一起改，链接里的提取码也换；别的字段只改自己", async () => {
  const a = await add({ shareUrl: "https://115.com/s/swlib007xyz?password=aaaa", cid: "555", rawName: "Season 1", sharePath: "剧/Season 1" });
  const b = await add({ shareUrl: "https://115.com/s/swlib007xyz?password=aaaa", cid: "556", rawName: "Season 2", sharePath: "剧/Season 2" });
  assert.equal(a.entry.shareCode, b.entry.shareCode);

  const res = await app.inject({ method: "PUT", url: `/api/library/${a.entry.id}`, headers: auth, payload: { title: "改过的标题", receiveCode: "bbbb" } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as MediaLibraryEntry & { health?: unknown };
  assert.equal(body.title, "改过的标题");
  assert.equal(body.receiveCode, "bbbb");
  assert.equal(body.shareUrl, "https://115.com/s/swlib007xyz?password=bbbb");
  assert.ok(body.health, "改了提取码要顺手查一次分享，结果带回去");
  const other = getById(b.entry.id)!;
  assert.equal(other.receiveCode, "bbbb", "同一个分享的另一条也改了");
  assert.equal(other.shareUrl, "https://115.com/s/swlib007xyz?password=bbbb");
  assert.equal(other.title, b.entry.title, "标题是各条自己的，不跟着改");

  const missing = await app.inject({ method: "PUT", url: "/api/library/no-such-entry", headers: auth, payload: { title: "x" } });
  assert.equal(missing.statusCode, 404);
});

test("认不出分享的还是 400", async () => {
  const res = await app.inject({ method: "POST", url: "/api/library", headers: auth, payload: { shareUrl: "随便一句话" } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().message, "Invalid share url");
});

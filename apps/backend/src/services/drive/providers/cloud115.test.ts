/**
 * 115 Provider 的路径解析：115 对不存在的路径回 id 0，这才是「目录不存在」；
 * cookie 失效、超时这些错误必须原样抛出，不能说成目录不存在（同步会误报「源目录已改名」，cookie 告警发不出来）。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { RemoteDirNotFoundError } from "../types.js";
import { Cloud115Provider, setCloud115ProviderDeps } from "./cloud115.js";

const provider = new Cloud115Provider({ accountType: "115", name: "p115", cookie: "c" });

after(() => setCloud115ProviderDeps(null));

test("getid 回 id 0 → 目录不存在：resolvePath 是 null、listSubtree 是 RemoteDirNotFoundError", async () => {
  setCloud115ProviderDeps({ fsDirGetId: async () => ({ id: 0 }) });
  assert.equal(await provider.resolvePath("tv/nope"), null);
  await assert.rejects(provider.listSubtree("tv/nope"), RemoteDirNotFoundError);
});

test("getid 回真 id → 目录", async () => {
  setCloud115ProviderDeps({ fsDirGetId: async () => ({ id: 123 }) });
  assert.deepEqual(await provider.resolvePath("/tv/Show/"), { id: "123", isDir: true });
});

test("getid 抛错（请重新登录 / 超时）→ 原样抛出，不是「目录不存在」", async () => {
  setCloud115ProviderDeps({
    fsDirGetId: async () => {
      throw new Error("115：请重新登录（errno 990001）");
    },
  });
  await assert.rejects(provider.resolvePath("tv/Show"), (e: unknown) => e instanceof Error && /请重新登录/.test(e.message) && !(e instanceof RemoteDirNotFoundError));
  await assert.rejects(provider.listSubtree("tv/Show"), (e: unknown) => e instanceof Error && /请重新登录/.test(e.message) && !(e instanceof RemoteDirNotFoundError));
  assert.equal(provider.classifyError(new Error("115：请重新登录（errno 990001）")), "auth");
});

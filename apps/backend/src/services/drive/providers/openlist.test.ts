/**
 * OpenList Provider 的错误归类：401 是登录态没了；403 只有说的是权限 / token 才算，`file [x] exists` 这种文件系统层的 403 不是账号问题。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountOpenlist } from "@openstrm/shared";
import { OpenlistError } from "../../openlist/client.js";
import { OpenlistProvider } from "./openlist.js";

const provider = new OpenlistProvider({ accountType: "openlist", name: "ol", account: "a", password: "p", url: "http://127.0.0.1:1" } satisfies AccountOpenlist);

test("classifyError：401 / 权限类 403 是 auth，撞名的 403 和其它错误不是账号问题", () => {
  assert.equal(provider.classifyError(new OpenlistError("OpenList /api/fs/list 失败：token is expired", 401)), "auth");
  assert.equal(provider.classifyError(new OpenlistError("OpenList /api/fs/list 失败：permission denied", 403)), "auth");
  assert.equal(provider.classifyError(new OpenlistError("OpenList /api/fs/move 失败：file [x.mkv] exists", 403)), null);
  assert.equal(provider.classifyError(new OpenlistError("OpenList /api/fs/rename 失败：object not found", 500)), null);
  assert.equal(provider.classifyError(new OpenlistError("OpenList 连不上", undefined, true)), null);
  assert.equal(provider.classifyError(new Error("x")), null);
});

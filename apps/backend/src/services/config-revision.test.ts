import assert from "node:assert/strict";
import { after, test } from "node:test";
import { listAccounts, replaceAccounts, updateAccount } from "../db/repositories/accounts.js";
import { configRevision, resetConfigRevisionMemo } from "./config-revision.js";

const baseline = listAccounts();
after(() => {
  replaceAccounts(baseline);
  resetConfigRevisionMemo();
});

function revision(): string {
  resetConfigRevisionMemo();
  return configRevision();
}

test("115 的 cookie 变了指纹要变；夸克的 cookie 每次请求都可能轮换，变了指纹不动", () => {
  replaceAccounts([
    { accountType: "115", name: "rev-115", cookie: "UID=1" },
    { accountType: "quark", name: "rev-quark", cookie: "__puus=a" },
  ]);
  const base = revision();
  updateAccount("rev-quark", { cookie: "__puus=b" });
  assert.equal(revision(), base, "夸克不参与 302，它的轮换不该让直链缓存作废");
  updateAccount("rev-115", { cookie: "UID=2" });
  assert.notEqual(revision(), base);
});

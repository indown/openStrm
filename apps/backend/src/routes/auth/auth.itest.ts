/**
 * 登录与强制改密码的闭环验证。
 *
 * 钉住四件事：口令不以明文入库、默认口令下除改密码外一律 403、改密码接口自身
 * 必须放行、密钥没有写死的兜底值。任何一条塌了，实例都等同于不设防。
 *
 *   CONFIG_DIR=... DATA_DIR=... npx tsx src/routes/auth/auth.itest.ts
 */
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";

/**
 * 这些用例会改写 auth 表里的口令。没指定 CONFIG_DIR 就会打在开发者真实的库上，
 * 把他自己的密码换掉——直接拒绝跑。
 */
if (!process.env.CONFIG_DIR) {
  console.error("拒绝在默认 CONFIG_DIR 上运行：请显式指定 CONFIG_DIR / DATA_DIR 到临时目录");
  process.exit(2);
}

import { authPlugin, PASSWORD_CHANGE_REQUIRED } from "../../plugins/auth.js";
import { db } from "../../db/client.js";
import { settings } from "../../db/schema.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import {
  isUsingDefaultPassword,
  readAuthConfig,
  resolveJwtSecret,
  writeAuthPassword,
} from "../../db/repositories/auth.js";
import { isHashed } from "../../services/password.js";
import loginRoute from "./login.js";
import passwordRoute from "./password.js";

const NEW_PASSWORD = "openstrm-itest-pw";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(authPlugin);
  await app.register(loginRoute);
  await app.register(passwordRoute);
  // 代表所有普通受保护路由：它们共用 authenticate，验一个等于验全部
  app.get("/api/_probe", { preHandler: [app.authenticate] }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

const login = (app: FastifyInstance, password: string) =>
  app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: DEFAULT_AUTH.username, password },
  });

const changePassword = (app: FastifyInstance, token: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/api/auth/password",
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

const storedPassword = () => String(readAuthConfig().password ?? "");

/** 直接写库绕开哈希，用来伪造升级前那种明文口令的库 */
function forgeLegacyPlaintext(value: string): void {
  const encoded = JSON.stringify(value);
  db.insert(settings)
    .values({ key: "auth.password", value: encoded })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: encoded, updatedAt: sql`(unixepoch())` },
    })
    .run();
  // 老库里没有这个标记
  db.delete(settings).where(eq(settings.key, "auth.mustChangePassword")).run();
}

async function main() {
  let pass = 0;
  await writeAuthPassword(DEFAULT_AUTH.password);
  const app = await buildApp();

  console.log("存储形态");

  await t("默认口令也以哈希入库，且仍被判定为默认", () => {
    const stored = storedPassword();
    assert.ok(isHashed(stored), "默认口令同样不能明文落库");
    assert.notEqual(stored, DEFAULT_AUTH.password);
    assert.equal(isUsingDefaultPassword(), true, "哈希之后仍要认得出这是默认口令");
  });

  await t("同一口令两次入库得到不同的串（加了盐）", async () => {
    const a = storedPassword();
    await writeAuthPassword(DEFAULT_AUTH.password);
    assert.notEqual(storedPassword(), a, "没有盐的话两次结果会一样");
    assert.equal((await login(app, DEFAULT_AUTH.password)).statusCode, 200);
  });

  console.log("默认口令下的强制改密");

  const first = await login(app, DEFAULT_AUTH.password);
  assert.equal(first.statusCode, 200);
  const token = first.json().token as string;
  assert.equal(first.json().mustChangePassword, true, "默认口令下必须要求改密码");
  pass++; console.log("  ok  默认口令登录成功，且标记 mustChangePassword");

  const blocked = await app.inject({
    method: "GET",
    url: "/api/_probe",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(blocked.statusCode, 403, "token 有效不代表放行——口令还是公开的默认值");
  assert.equal(blocked.json().code, PASSWORD_CHANGE_REQUIRED);
  pass++; console.log("  ok  默认口令下普通受保护路由一律 403");

  // 401 而不是 403，说明请求进到了处理函数，没被强制改密的守卫挡在门外
  const wrongCurrent = await changePassword(app, token, {
    currentPassword: "not-the-password",
    newPassword: NEW_PASSWORD,
  });
  assert.equal(wrongCurrent.statusCode, 401, "改密码接口必须放行，否则用户被锁在门外");
  pass++; console.log("  ok  改密码接口自身不被拦截，且校验当前密码");

  for (const [label, newPassword] of [
    ["默认值", DEFAULT_AUTH.password],
    ["过短", "short"],
  ] as const) {
    const res = await changePassword(app, token, {
      currentPassword: DEFAULT_AUTH.password,
      newPassword,
    });
    assert.equal(res.statusCode, 400, `新密码为${label}时应被拒绝`);
  }
  pass++; console.log("  ok  新密码为默认值或过短都被拒绝");

  const changed = await changePassword(app, token, {
    currentPassword: DEFAULT_AUTH.password,
    newPassword: NEW_PASSWORD,
  });
  assert.equal(changed.statusCode, 200);
  assert.ok(isHashed(storedPassword()), "改完之后依然是哈希");
  assert.equal(isUsingDefaultPassword(), false, "标记要跟着口令一起翻转");
  pass++; console.log("  ok  提供正确的当前密码后修改成功，标记随之翻转");

  const sameAsCurrent = await changePassword(app, token, {
    currentPassword: NEW_PASSWORD,
    newPassword: NEW_PASSWORD,
  });
  assert.equal(sameAsCurrent.statusCode, 400, "新密码与当前相同应被拒绝");
  pass++; console.log("  ok  新密码与当前密码相同被拒绝");

  assert.equal((await login(app, DEFAULT_AUTH.password)).statusCode, 401);
  pass++; console.log("  ok  旧密码不再能登录");

  const second = await login(app, NEW_PASSWORD);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().mustChangePassword, false);
  pass++; console.log("  ok  新密码可登录，不再要求改密码");

  // 同一个 app 实例直接放行，说明判定是每次请求现查的，不需要重启
  const allowed = await app.inject({
    method: "GET",
    url: "/api/_probe",
    headers: { authorization: `Bearer ${second.json().token}` },
  });
  assert.equal(allowed.statusCode, 200, "改完密码应立即放行，不必重启");
  pass++; console.log("  ok  改密后无需重启即放行");

  console.log("存量库升级");

  await t("升级前的明文口令仍能登录，并就地转成哈希", async () => {
    forgeLegacyPlaintext("legacy-plain-pw");
    assert.ok(!isHashed(storedPassword()), "前置条件：库里此刻是明文");

    const res = await login(app, "legacy-plain-pw");
    assert.equal(res.statusCode, 200, "明文口令必须仍能登录，否则升级即把人锁在门外");

    const now = storedPassword();
    assert.ok(isHashed(now), "登录成功后应已改写为哈希");
    assert.notEqual(now, "legacy-plain-pw");

    assert.equal((await login(app, "legacy-plain-pw")).statusCode, 200, "转哈希后仍认同一个口令");
    assert.equal((await login(app, "wrong-pw")).statusCode, 401);
  });

  await t("存量库里的明文默认口令同样会被要求改密", async () => {
    forgeLegacyPlaintext(DEFAULT_AUTH.password);
    assert.equal(isUsingDefaultPassword(), true, "明文分支要在不跑 KDF 的情况下认出默认口令");
    const res = await login(app, DEFAULT_AUTH.password);
    assert.equal(res.json().mustChangePassword, true);
  });

  await app.close();

  console.log("密钥");

  await t("密钥自动生成、可复现，且无写死兜底", () => {
    assert.equal(process.env.JWT_SECRET, undefined, "本用例要求 JWT_SECRET 未设置");
    const secret = resolveJwtSecret();
    assert.ok(secret.length >= 40, "自动生成的密钥长度不足");
    assert.notEqual(
      secret,
      "your-super-secret-jwt-key-change-in-production",
      "写死的兜底值必须已删除",
    );
    assert.equal(resolveJwtSecret(), secret, "重复解析必须拿到同一个密钥");
  });

  console.log(`\n${pass} passed`);

  async function t(name: string, fn: () => Promise<void> | void) {
    await fn();
    pass++;
    console.log("  ok  " + name);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

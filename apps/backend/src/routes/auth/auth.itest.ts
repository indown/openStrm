/**
 * 强制改密码的闭环验证。
 *
 * 钉住三件事：默认口令下除改密码外一律 403、改密码接口自身必须放行、
 * 密钥没有写死的兜底值。任何一条塌了，实例都等同于不设防。
 *
 *   CONFIG_DIR=... DATA_DIR=... npx tsx src/routes/auth/auth.itest.ts
 */
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { configPlugin } from "../../plugins/config.js";
import { authPlugin, PASSWORD_CHANGE_REQUIRED } from "../../plugins/auth.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { readAuthConfig, resolveJwtSecret, writeAuthPassword } from "../../db/repositories/auth.js";
import loginRoute from "./login.js";
import passwordRoute from "./password.js";

const NEW_PASSWORD = "openstrm-itest-pw";
const baseline = readAuthConfig().password as string;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(configPlugin);
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

async function main() {
  let pass = 0;
  writeAuthPassword(DEFAULT_AUTH.password);
  const app = await buildApp();

  // --- 默认口令状态 ---
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

  // --- 改密码，然后确认整个状态翻转 ---
  const changed = await changePassword(app, token, {
    currentPassword: DEFAULT_AUTH.password,
    newPassword: NEW_PASSWORD,
  });
  assert.equal(changed.statusCode, 200);
  pass++; console.log("  ok  提供正确的当前密码后修改成功");

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

  await app.close();

  // --- 密钥 ---
  assert.equal(process.env.JWT_SECRET, undefined, "本用例要求 JWT_SECRET 未设置");
  const secret = resolveJwtSecret();
  assert.ok(secret.length >= 40, "自动生成的密钥长度不足");
  assert.notEqual(secret, "your-super-secret-jwt-key-change-in-production", "写死的兜底值必须已删除");
  assert.equal(resolveJwtSecret(), secret, "重复解析必须拿到同一个密钥");
  pass++; console.log("  ok  密钥自动生成、可复现，且无写死兜底");

  console.log(`\n${pass} passed`);
}

main()
  .then(() => writeAuthPassword(baseline))
  .catch((err) => {
    writeAuthPassword(baseline);
    console.error(err);
    process.exit(1);
  });

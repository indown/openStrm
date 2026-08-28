import { createHash, randomBytes } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { db } from "../client.js";
import { settings } from "../schema.js";
import { DEFAULT_AUTH } from "../defaults.js";
import { hashPassword, isHashed } from "../../services/password.js";
import { KEY } from "../keys.js";

const AUTH_PREFIX = KEY.authPrefix;

// 刻意留在 auth. 前缀之外：readAuthConfig 按 auth.% 通配后整体返回，
// 密钥搁进那个前缀，迟早会跟着某个响应体一起发出去。
const JWT_SECRET_KEY = KEY.jwtSecret;

export function readAuthConfig(): Record<string, unknown> {
  const rows = db.select().from(settings).where(like(settings.key, `${AUTH_PREFIX}%`)).all();
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const k = r.key.slice(AUTH_PREFIX.length);
    try {
      out[k] = JSON.parse(r.value);
    } catch {
      out[k] = r.value;
    }
  }
  return out;
}

function readStoredJwtSecret(): string | null {
  const row = db.select().from(settings).where(eq(settings.key, JWT_SECRET_KEY)).get();
  return row ? (JSON.parse(row.value) as string) : null;
}

/**
 * JWT_SECRET 环境变量优先，没有就在首次调用时随机生成一个并落库。
 *
 * 这里不留任何写死的兜底值：开源仓库里的默认密钥是公开的，谁都能拿它签出
 * 合法 token，等于没有认证。生成的值存在 CONFIG_DIR 的库里，重启后仍然有效；
 * 环境变量留给需要轮换密钥或多副本共享的人。
 */
export function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET?.trim();
  if (fromEnv) return fromEnv;

  const existing = readStoredJwtSecret();
  if (existing) return existing;

  // 主键冲突说明别的进程抢先写好了。忽略写入再回读，保证大家拿到同一个值，
  // 否则两个进程各签各的，互相验不过对方的 token。
  db.insert(settings)
    .values({
      key: JWT_SECRET_KEY,
      value: JSON.stringify(randomBytes(48).toString("base64url")),
    })
    .onConflictDoNothing({ target: settings.key })
    .run();

  const stored = readStoredJwtSecret();
  if (!stored) throw new Error("JWT 密钥持久化失败");
  return stored;
}

function upsert(key: string, value: unknown): void {
  const encoded = JSON.stringify(value);
  db.insert(settings)
    .values({ key, value: encoded })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: encoded, updatedAt: sql`(unixepoch())` },
    })
    .run();
}

/**
 * 口令还是仓库里公开的那个默认值时，这个实例等同于没有认证。
 *
 * 这个判断挂在每个受保护请求的 authenticate 上，所以**绝不能跑 KDF**——
 * 口令已经是哈希，没法当场比对，只能读写入时一并记下的标记。
 * 升级前的库里还是明文，那种直接比就行，同样不花什么代价。
 */
export function isUsingDefaultPassword(): boolean {
  const config = readAuthConfig();
  const stored = typeof config.password === "string" ? config.password : "";
  if (!isHashed(stored)) return stored === DEFAULT_AUTH.password;
  return config.mustChangePassword === true;
}

/**
 * 当前口令的短指纹，签进 JWT 的 pv claim：改了密码，之前签发的 token 立刻失效。
 * 取的是库里存的哈希的哈希，不暴露任何口令信息；读的是每个请求本来就在读的 auth 配置，不额外开销。
 */
export function passwordVersion(): string {
  const stored = String(readAuthConfig().password ?? "");
  return createHash("sha256").update(stored).digest("base64url").slice(0, 12);
}

/** 传明文。哈希是这里做的，调用方没有机会忘记。 */
export async function writeAuthPassword(plain: string): Promise<void> {
  const hash = await hashPassword(plain);
  // 标记和口令必须一起落，否则两者会各自漂移
  db.transaction(() => {
    upsert(`${AUTH_PREFIX}password`, hash);
    upsert(`${AUTH_PREFIX}mustChangePassword`, plain === DEFAULT_AUTH.password);
  });
}

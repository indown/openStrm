import { createHash, randomBytes, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { AgentScope, AgentToken, AgentToolset } from "@openstrm/shared";
import { db } from "../client.js";
import { apiTokens } from "../schema.js";

type Row = typeof apiTokens.$inferSelect;

/** 明文的前缀：人和密钥扫描工具一眼认得出，也和 JWT 区分开 */
export const TOKEN_PREFIX = "ostk_";
/** 列表里显示的前几位：前缀加 7 个随机字符，够认、不够用 */
const DISPLAY_PREFIX_LEN = TOKEN_PREFIX.length + 7;

export const AGENT_SCOPES: readonly AgentScope[] = ["read", "run", "write", "danger"];
export const AGENT_TOOLSETS: readonly AgentToolset[] = ["sync", "transfer"];

/** 同一个令牌多久最多写一次「最近使用」：每个请求都写库不值当 */
const TOUCH_INTERVAL_S = 60;
/** 令牌 id → 上次写「最近使用」的时间（秒）和 IP */
const lastTouch = new Map<string, { at: number; ip: string | null }>();

function parseList<T extends string>(raw: string | null, allowed: readonly T[]): T[] | null {
  if (raw == null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return v.filter((x): x is T => typeof x === "string" && (allowed as readonly string[]).includes(x));
  } catch {
    return null;
  }
}

function deserialize(row: Row): AgentToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseList(row.scopes, AGENT_SCOPES) ?? [],
    toolsets: parseList(row.toolsets, AGENT_TOOLSETS) ?? [],
    createdAt: row.createdAt,
    expiresAt: row.expiresAt ?? null,
    lastUsedAt: row.lastUsedAt ?? null,
    lastUsedIp: row.lastUsedIp ?? null,
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface NewApiToken {
  name: string;
  scopes: AgentScope[];
  toolsets: AgentToolset[];
  /** 秒；null 表示不过期 */
  expiresAt: number | null;
}

/** 建一个令牌。明文只从这里出去一次，库里只有哈希 */
export function createApiToken(input: NewApiToken): { token: string; info: AgentToken } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  db.insert(apiTokens)
    .values({
      id,
      name: input.name,
      tokenHash: hashToken(token),
      prefix: token.slice(0, DISPLAY_PREFIX_LEN),
      scopes: JSON.stringify(input.scopes),
      toolsets: JSON.stringify(input.toolsets),
      expiresAt: input.expiresAt,
    })
    .run();
  return { token, info: getApiToken(id)! };
}

export function listApiTokens(): AgentToken[] {
  return db.select().from(apiTokens).orderBy(desc(apiTokens.createdAt), desc(apiTokens.id)).all().map(deserialize);
}

export function getApiToken(id: string): AgentToken | undefined {
  const row = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
  return row ? deserialize(row) : undefined;
}

export function updateApiToken(
  id: string,
  patch: { name?: string; scopes?: AgentScope[]; toolsets?: AgentToolset[] },
): AgentToken | undefined {
  const set: Partial<typeof apiTokens.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.scopes !== undefined) set.scopes = JSON.stringify(patch.scopes);
  if (patch.toolsets !== undefined) set.toolsets = JSON.stringify(patch.toolsets);
  if (Object.keys(set).length > 0) db.update(apiTokens).set(set).where(eq(apiTokens.id, id)).run();
  return getApiToken(id);
}

/** 撤销 = 删行。调用记录里留着令牌名，删了也查得到是谁干的 */
export function deleteApiToken(id: string): boolean {
  lastTouch.delete(id);
  return db.delete(apiTokens).where(eq(apiTokens.id, id)).run().changes > 0;
}

export function deleteAllApiTokens(): number {
  lastTouch.clear();
  return db.delete(apiTokens).run().changes;
}

/** 按明文找令牌；过期的当不存在 */
export function findApiToken(token: string, nowS = Math.floor(Date.now() / 1000)): AgentToken | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const row = db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hashToken(token))).get();
  if (!row) return undefined;
  if (row.expiresAt != null && row.expiresAt <= nowS) return undefined;
  return deserialize(row);
}

/**
 * 记「最近使用」：同一个令牌 60 秒内只写一次库；换了 IP 立刻写——令牌泄露后被别处用，
 * 设置页上看到的「最近使用（IP）」得马上变
 */
export function touchApiToken(id: string, ip: string | null, nowS = Math.floor(Date.now() / 1000)): void {
  const prev = lastTouch.get(id);
  if (prev !== undefined && prev.ip === ip && nowS - prev.at < TOUCH_INTERVAL_S) return;
  lastTouch.set(id, { at: nowS, ip });
  db.update(apiTokens)
    .set({ lastUsedAt: nowS, lastUsedIp: ip })
    .where(eq(apiTokens.id, id))
    .run();
}

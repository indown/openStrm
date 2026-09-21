/**
 * OAuth 授权服务器的存储：客户端、授权请求（等人批准）、授权（已连接的客户端）、换过的刷新令牌。
 * 密钥（授权码、访问令牌、刷新令牌、预注册客户端的 secret、授权页的轮询密钥）一律只存 SHA-256。
 *
 * 访问令牌、刷新令牌不是随手生成的随机串，而是用本机的密钥从「上一个」（授权码或旧刷新令牌）派生出来的：
 * 同一个授权码 / 刷新令牌在宽限期内又来一次（客户端并发刷新、回应丢了重试），能算出同一对令牌原样回过去，
 * 不用把明文令牌存下来；没有本机密钥的人拿着旧刷新令牌也算不出新的。
 */
import { createHmac, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, gte, inArray, lt, notExists, or } from "drizzle-orm";
import type { AgentScope, AgentToolset, OAuthClientInfo, OAuthClientKind, OAuthGrantInfo } from "@openstrm/shared";
import { db } from "../client.js";
import { KEY } from "../keys.js";
import { oauthClients, oauthGrants, oauthRequests, oauthUsedRefresh, settings } from "../schema.js";
import { AGENT_SCOPES, AGENT_TOOLSETS, hashToken } from "./api-tokens.js";

export const ACCESS_TOKEN_PREFIX = "osat_";
export const REFRESH_TOKEN_PREFIX = "osrt_";
const CODE_PREFIX = "osac_";
const CLIENT_SECRET_PREFIX = "ocs_";

const nowS = () => Math.floor(Date.now() / 1000);
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const onlyScopes = (v: unknown): AgentScope[] => (Array.isArray(v) ? AGENT_SCOPES.filter((s) => v.includes(s)) : []);
const onlyToolsets = (v: unknown): AgentToolset[] => (Array.isArray(v) ? AGENT_TOOLSETS.filter((s) => v.includes(s)) : []);
const onlyStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/* ------------------------------- 派生令牌用的密钥 ------------------------------- */

let tokenKeyCache: Buffer | null = null;

/** 首次用到时随机生成一把落库（和 JWT 密钥一样放 system.*），之后一直用它 */
function tokenKey(): Buffer {
  if (tokenKeyCache) return tokenKeyCache;
  const read = () => {
    const row = db.select().from(settings).where(eq(settings.key, KEY.oauthTokenKey)).get();
    return row ? (JSON.parse(row.value) as string) : null;
  };
  let stored = read();
  if (!stored) {
    // 主键冲突说明别的进程抢先写好了：忽略写入再回读，大家拿到同一把
    db.insert(settings)
      .values({ key: KEY.oauthTokenKey, value: JSON.stringify(randomBytes(32).toString("base64url")) })
      .onConflictDoNothing({ target: settings.key })
      .run();
    stored = read();
  }
  if (!stored) throw new Error("OAuth 令牌密钥持久化失败");
  tokenKeyCache = Buffer.from(stored, "base64url");
  return tokenKeyCache;
}

/** 从上一个（授权码或旧刷新令牌）派生：不同授权、不同用途各算各的 */
function derive(prefix: string, purpose: string, grantId: string, parent: string): string {
  return `${prefix}${createHmac("sha256", tokenKey()).update(`${purpose}|${grantId}|${parent}`).digest("base64url")}`;
}

/* ------------------------------- 客户端 ------------------------------- */

export interface OAuthClientRecord {
  id: string;
  kind: OAuthClientKind;
  name: string;
  redirectUris: string[];
  secretHash: string | null;
  scope: string;
  createdAt: number;
  fetchedAt: number | null;
  cacheUntil: number | null;
  lastUsedAt: number | null;
}

type ClientRow = typeof oauthClients.$inferSelect;

function toClient(row: ClientRow): OAuthClientRecord {
  return {
    id: row.id,
    kind: row.kind as OAuthClientKind,
    name: row.name,
    redirectUris: onlyStrings(parseJson(row.redirectUris, [])),
    secretHash: row.secretHash ?? null,
    scope: row.scope,
    createdAt: row.createdAt,
    fetchedAt: row.fetchedAt ?? null,
    cacheUntil: row.cacheUntil ?? null,
    lastUsedAt: row.lastUsedAt ?? null,
  };
}

export function toClientInfo(c: OAuthClientRecord): OAuthClientInfo {
  return { id: c.id, kind: c.kind, name: c.name, redirectUris: c.redirectUris, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt };
}

export function getOAuthClient(id: string): OAuthClientRecord | undefined {
  const row = db.select().from(oauthClients).where(eq(oauthClients.id, id)).get();
  return row ? toClient(row) : undefined;
}

/** CIMD：client_id 就是元数据地址，取到的元数据按它存（再取就覆盖）；cacheUntil 之前不再去取 */
export function saveCimdClient(input: { id: string; name: string; redirectUris: string[]; scope: string; cacheUntil: number }, now = nowS()): OAuthClientRecord {
  const values = { name: input.name, redirectUris: JSON.stringify(input.redirectUris), scope: input.scope, fetchedAt: now, cacheUntil: input.cacheUntil };
  db.insert(oauthClients)
    .values({ id: input.id, kind: "cimd", ...values })
    .onConflictDoUpdate({ target: oauthClients.id, set: values })
    .run();
  return getOAuthClient(input.id)!;
}

/** DCR：client_id 由我们发 */
export function createDcrClient(input: { name: string; redirectUris: string[]; scope: string }): OAuthClientRecord {
  const id = `oc_${randomBytes(16).toString("base64url")}`;
  db.insert(oauthClients)
    .values({ id, kind: "dcr", name: input.name, redirectUris: JSON.stringify(input.redirectUris), scope: input.scope })
    .run();
  return getOAuthClient(id)!;
}

/** 预注册客户端（设置页手建）：secret 明文只从这里出去一次 */
export function createManualClient(input: { name: string; redirectUris: string[] }): { record: OAuthClientRecord; secret: string } {
  const id = `ocm_${randomBytes(12).toString("base64url")}`;
  const clientSecret = secret(CLIENT_SECRET_PREFIX);
  db.insert(oauthClients)
    .values({ id, kind: "manual", name: input.name, redirectUris: JSON.stringify(input.redirectUris), secretHash: hashToken(clientSecret) })
    .run();
  return { record: getOAuthClient(id)!, secret: clientSecret };
}

export function listManualClients(): OAuthClientInfo[] {
  return db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.kind, "manual"))
    .orderBy(desc(oauthClients.createdAt))
    .all()
    .map((r) => toClientInfo(toClient(r)));
}

/** 还没走完的授权请求：批准前、批准后没取授权码、取了没换令牌 */
const LIVE_REQUEST = ["pending", "approved", "issued"];

/**
 * 删客户端连带撤掉它的授权、拒掉它还没走完的授权请求：预注册客户端删了，用它连上的客户端该断，
 * 已经批了、授权码还没换令牌的也不能再换出来
 */
export function deleteOAuthClient(id: string, now = nowS()): boolean {
  return db.transaction((tx) => {
    const grantIds = tx.select({ id: oauthGrants.id }).from(oauthGrants).where(eq(oauthGrants.clientId, id)).all();
    for (const g of grantIds) lastTouch.delete(g.id);
    tx.delete(oauthGrants).where(eq(oauthGrants.clientId, id)).run();
    tx.update(oauthRequests)
      .set({ status: "denied", codeHash: null, approvedVia: "revoked", decidedAt: now })
      .where(and(eq(oauthRequests.clientId, id), inArray(oauthRequests.status, LIVE_REQUEST)))
      .run();
    return tx.delete(oauthClients).where(eq(oauthClients.id, id)).run().changes > 0;
  });
}

export function touchOAuthClient(id: string, now = nowS()): void {
  db.update(oauthClients).set({ lastUsedAt: now }).where(eq(oauthClients.id, id)).run();
}

/**
 * 久没用、也没有授权挂在上面、没有授权请求在走的 DCR / CIMD 客户端：注册谁都能发、CIMD 谁都能让我们去取，不清会越攒越多。
 * 「久」按最后一次用到（发起授权、换令牌）算，没用过按取到 / 注册的时间
 */
export function deleteStaleOAuthClients(cutoff: number): number {
  const stale = db
    .select({ id: oauthClients.id, created: oauthClients.createdAt, fetched: oauthClients.fetchedAt, used: oauthClients.lastUsedAt })
    .from(oauthClients)
    .where(
      and(
        inArray(oauthClients.kind, ["dcr", "cimd"]),
        notExists(db.select({ one: oauthGrants.id }).from(oauthGrants).where(eq(oauthGrants.clientId, oauthClients.id))),
        notExists(
          db
            .select({ one: oauthRequests.id })
            .from(oauthRequests)
            .where(and(eq(oauthRequests.clientId, oauthClients.id), inArray(oauthRequests.status, LIVE_REQUEST))),
        ),
      ),
    )
    .all()
    .filter((r) => (r.used ?? r.fetched ?? r.created) < cutoff)
    .map((r) => r.id);
  if (stale.length === 0) return 0;
  return db.delete(oauthClients).where(inArray(oauthClients.id, stale)).run().changes;
}

/* ------------------------------- 授权请求 ------------------------------- */

export type OAuthRequestStatus = "pending" | "approved" | "issued" | "used" | "denied";

export interface OAuthRequestRecord {
  id: string;
  clientId: string;
  clientName: string;
  clientKind: OAuthClientKind;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  requestedScope: string;
  resource: string;
  pairingCode: string;
  status: OAuthRequestStatus;
  grantedScopes: AgentScope[] | null;
  grantedToolsets: AgentToolset[] | null;
  approvedVia: string | null;
  codeExpiresAt: number | null;
  usedAt: number | null;
  grantId: string | null;
  ip: string;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}

type RequestRow = typeof oauthRequests.$inferSelect;

function toRequest(row: RequestRow): OAuthRequestRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName,
    clientKind: row.clientKind as OAuthClientKind,
    redirectUri: row.redirectUri,
    state: row.state ?? null,
    codeChallenge: row.codeChallenge,
    requestedScope: row.requestedScope,
    resource: row.resource,
    pairingCode: row.pairingCode,
    status: row.status as OAuthRequestStatus,
    grantedScopes: row.grantedScopes == null ? null : onlyScopes(parseJson(row.grantedScopes, [])),
    grantedToolsets: row.grantedToolsets == null ? null : onlyToolsets(parseJson(row.grantedToolsets, [])),
    approvedVia: row.approvedVia ?? null,
    codeExpiresAt: row.codeExpiresAt ?? null,
    usedAt: row.usedAt ?? null,
    grantId: row.grantId ?? null,
    ip: row.ip,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt ?? null,
  };
}

/** 配对码：去掉 0 / O / 1 / I 这些容易认错的字符，32 个字符正好整除一个字节，没有偏差 */
const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function pairingCode(): string {
  const chars = [...randomBytes(8)].map((b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** 人输入的配对码规范成存的写法：不分大小写、空格和横线随便；不像配对码返回 null */
export function normalizePairingCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== 8 || [...s].some((c) => !PAIRING_ALPHABET.includes(c))) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export interface NewOAuthRequest {
  clientId: string;
  clientName: string;
  clientKind: OAuthClientKind;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  requestedScope: string;
  resource: string;
  ip: string;
  ipKey: string;
  ttlSeconds: number;
}

/** 新的授权请求：返回记录和授权页轮询要带的密钥（明文只在这里） */
export function createOAuthRequest(input: NewOAuthRequest, now = nowS()): { record: OAuthRequestRecord; pollSecret: string } {
  // 9 字节 → 12 个字符：Telegram 按钮的回调数据有 64 字节的上限
  const id = randomBytes(9).toString("base64url");
  const pollSecret = randomBytes(24).toString("base64url");
  db.insert(oauthRequests)
    .values({
      id,
      pollHash: hashToken(pollSecret),
      clientId: input.clientId,
      clientName: input.clientName,
      clientKind: input.clientKind,
      redirectUri: input.redirectUri,
      state: input.state,
      codeChallenge: input.codeChallenge,
      requestedScope: input.requestedScope,
      resource: input.resource,
      pairingCode: pairingCode(),
      ip: input.ip,
      ipKey: input.ipKey,
      createdAt: now,
      expiresAt: now + input.ttlSeconds,
    })
    .run();
  return { record: getOAuthRequest(id)!, pollSecret };
}

export function getOAuthRequest(id: string): OAuthRequestRecord | undefined {
  const row = db.select().from(oauthRequests).where(eq(oauthRequests.id, id)).get();
  return row ? toRequest(row) : undefined;
}

/** 授权页轮询：id 和轮询密钥都对上才给看 */
export function getOAuthRequestForPoll(id: string, pollSecret: string): OAuthRequestRecord | undefined {
  const row = db
    .select()
    .from(oauthRequests)
    .where(and(eq(oauthRequests.id, id), eq(oauthRequests.pollHash, hashToken(pollSecret))))
    .get();
  return row ? toRequest(row) : undefined;
}

/** 还在等批准、没过期的，按配对码找（Telegram 里把配对码发给机器人时用） */
export function findPendingOAuthRequestByCode(code: string, now = nowS()): OAuthRequestRecord | undefined {
  const normalized = normalizePairingCode(code);
  if (!normalized) return undefined;
  const row = db
    .select()
    .from(oauthRequests)
    .where(and(eq(oauthRequests.status, "pending"), gt(oauthRequests.expiresAt, now), eq(oauthRequests.pairingCode, normalized)))
    .get();
  return row ? toRequest(row) : undefined;
}

/** 还在等批准、没过期的（先来的在前：新来的插在后面，不会把人正要点的那一行挤走） */
export function listPendingOAuthRequests(now = nowS()): OAuthRequestRecord[] {
  return db
    .select()
    .from(oauthRequests)
    .where(and(eq(oauthRequests.status, "pending"), gt(oauthRequests.expiresAt, now)))
    .orderBy(oauthRequests.createdAt)
    .all()
    .map(toRequest);
}

/** 回调地址给人核对时显示的部分：http(s) 的是域名，私有 scheme 的是 scheme 加主机 */
export function hostOf(uri: string): string {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : `${u.protocol}//${u.host}`;
  } catch {
    return uri;
  }
}

/** 这个来源（ipKey）从 since（秒）起发起过几个授权请求：授权页谁都能打开，不限的话能拿它刷通知 */
export function countOAuthRequestsSince(ipKey: string, since: number): number {
  return db
    .select({ n: count() })
    .from(oauthRequests)
    .where(and(eq(oauthRequests.ipKey, ipKey), gte(oauthRequests.createdAt, since)))
    .get()!.n;
}

/** 还在等批准的：给了 ipKey 就只数这个来源的 */
export function countPendingOAuthRequests(now = nowS(), ipKey?: string): number {
  return db
    .select({ n: count() })
    .from(oauthRequests)
    .where(and(eq(oauthRequests.status, "pending"), gt(oauthRequests.expiresAt, now), ipKey === undefined ? undefined : eq(oauthRequests.ipKey, ipKey)))
    .get()!.n;
}

/**
 * 批准 / 拒绝：只对还在等、没过期的请求生效，返回是否改成了。
 * 批准后给授权页 10 分钟来取授权码（页面每两秒问一次，正常马上就取走了）
 */
export function decideOAuthRequest(
  id: string,
  decision: { approved: true; scopes: AgentScope[]; toolsets: AgentToolset[]; via: string } | { approved: false; via: string },
  now = nowS(),
  codeWindowSeconds = 600,
): boolean {
  const set = decision.approved
    ? {
        status: "approved",
        grantedScopes: JSON.stringify(decision.scopes),
        grantedToolsets: JSON.stringify(decision.toolsets),
        approvedVia: decision.via,
        decidedAt: now,
        expiresAt: now + codeWindowSeconds,
      }
    : { status: "denied", approvedVia: decision.via, decidedAt: now };
  return (
    db
      .update(oauthRequests)
      .set(set)
      .where(and(eq(oauthRequests.id, id), eq(oauthRequests.status, "pending"), gt(oauthRequests.expiresAt, now)))
      .run().changes > 0
  );
}

/** 全部拒绝：怀疑有人在刷授权请求时一键清掉 */
export function denyAllPendingOAuthRequests(via: string, now = nowS()): number {
  return db
    .update(oauthRequests)
    .set({ status: "denied", approvedVia: via, decidedAt: now })
    .where(and(eq(oauthRequests.status, "pending"), gt(oauthRequests.expiresAt, now)))
    .run().changes;
}

/**
 * 授权页来取授权码（明文只从这里出去）：批准了的第一次取时生成；已经发过、还没换令牌的再来取就换一个新的
 * （上一次的回应可能丢了，旧的作废），过了授权码的时限就没有了
 */
export function issueOAuthCode(id: string, now = nowS(), ttlSeconds = 600): string | undefined {
  const code = secret(CODE_PREFIX);
  const changed = db
    .update(oauthRequests)
    .set({ status: "issued", codeHash: hashToken(code), codeExpiresAt: now + ttlSeconds })
    .where(and(eq(oauthRequests.id, id), eq(oauthRequests.status, "approved"), gt(oauthRequests.expiresAt, now)))
    .run().changes;
  if (changed > 0) return code;
  const reissued = db
    .update(oauthRequests)
    .set({ codeHash: hashToken(code) })
    .where(and(eq(oauthRequests.id, id), eq(oauthRequests.status, "issued"), gt(oauthRequests.codeExpiresAt, now)))
    .run().changes;
  return reissued > 0 ? code : undefined;
}

export function findOAuthRequestByCode(code: string): OAuthRequestRecord | undefined {
  const row = db.select().from(oauthRequests).where(eq(oauthRequests.codeHash, hashToken(code))).get();
  return row ? toRequest(row) : undefined;
}

/** 授权码换过令牌了：记下换出来的授权和时间，同一个授权码再来就知道该撤谁、是不是宽限期内的重试 */
export function markOAuthCodeUsed(id: string, grantId: string, now = nowS()): boolean {
  return (
    db
      .update(oauthRequests)
      .set({ status: "used", grantId, usedAt: now })
      .where(and(eq(oauthRequests.id, id), eq(oauthRequests.status, "issued")))
      .run().changes > 0
  );
}

/** 清掉过期的请求：没走完的过期一小时后删，走完了的留一天（授权码被重放时还认得出来） */
export function deleteExpiredOAuthRequests(now = nowS()): number {
  return db
    .delete(oauthRequests)
    .where(
      or(
        and(inArray(oauthRequests.status, ["pending", "approved", "denied"]), lt(oauthRequests.expiresAt, now - 3600)),
        and(inArray(oauthRequests.status, ["issued", "used"]), lt(oauthRequests.createdAt, now - 86400)),
      ),
    )
    .run().changes;
}

/* ------------------------------- 授权（已连接的客户端） ------------------------------- */

export interface OAuthGrantRecord {
  id: string;
  clientId: string;
  clientName: string;
  scopes: AgentScope[];
  toolsets: AgentToolset[];
  offline: boolean;
  resource: string;
  accessHash: string;
  accessExpiresAt: number;
  refreshHash: string;
  refreshExpiresAt: number;
  approvedVia: string | null;
  approvedAt: number | null;
  requestIp: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
}

type GrantRow = typeof oauthGrants.$inferSelect;

function toGrant(row: GrantRow): OAuthGrantRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName,
    scopes: onlyScopes(parseJson(row.scopes, [])),
    toolsets: onlyToolsets(parseJson(row.toolsets, [])),
    offline: row.offline,
    resource: row.resource,
    accessHash: row.accessHash,
    accessExpiresAt: row.accessExpiresAt,
    refreshHash: row.refreshHash,
    refreshExpiresAt: row.refreshExpiresAt,
    approvedVia: row.approvedVia ?? null,
    approvedAt: row.approvedAt ?? null,
    requestIp: row.requestIp ?? null,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt ?? null,
    lastUsedIp: row.lastUsedIp ?? null,
  };
}

/** currentResource：现在的 <公网地址>/mcp；授权绑的不是它（公网地址改过了）就标成失效 */
export function toGrantInfo(g: OAuthGrantRecord, currentResource: string | null): OAuthGrantInfo {
  return {
    id: g.id,
    clientId: g.clientId,
    clientName: g.clientName,
    scopes: g.scopes,
    toolsets: g.toolsets,
    createdAt: g.createdAt,
    lastUsedAt: g.lastUsedAt,
    lastUsedIp: g.lastUsedIp,
    refreshExpiresAt: g.refreshExpiresAt,
    status: currentResource !== null && g.resource === currentResource ? "active" : "stale",
    approvedVia: g.approvedVia,
    approvedAt: g.approvedAt,
    requestIp: g.requestIp,
  };
}

export interface TokenTtl {
  accessSeconds: number;
  refreshSeconds: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

/** 从上一个（授权码或旧刷新令牌）派生出的一对令牌 */
function derivedTokens(grantId: string, parent: string, ttl: TokenTtl, now: number): IssuedTokens {
  return {
    accessToken: derive(ACCESS_TOKEN_PREFIX, "access", grantId, parent),
    refreshToken: derive(REFRESH_TOKEN_PREFIX, "refresh", grantId, parent),
    accessExpiresAt: now + ttl.accessSeconds,
    refreshExpiresAt: now + ttl.refreshSeconds,
  };
}

/**
 * 同一个上一个（授权码 / 旧刷新令牌）在宽限期内又来了：算出当时发出去的那一对，
 * 授权的刷新令牌还是它（之后没再刷新过）才算数，否则返回 undefined
 */
export function replayTokens(grant: OAuthGrantRecord, parent: string): IssuedTokens | undefined {
  const refreshToken = derive(REFRESH_TOKEN_PREFIX, "refresh", grant.id, parent);
  if (hashToken(refreshToken) !== grant.refreshHash) return undefined;
  return {
    accessToken: derive(ACCESS_TOKEN_PREFIX, "access", grant.id, parent),
    refreshToken,
    accessExpiresAt: grant.accessExpiresAt,
    refreshExpiresAt: grant.refreshExpiresAt,
  };
}

export interface NewOAuthGrant {
  clientId: string;
  clientName: string;
  scopes: AgentScope[];
  toolsets: AgentToolset[];
  offline: boolean;
  resource: string;
  approvedVia: string | null;
  approvedAt: number | null;
  requestIp: string | null;
}

/** 授权码换令牌：令牌从授权码派生（见文件头） */
export function createOAuthGrant(input: NewOAuthGrant, code: string, ttl: TokenTtl, now = nowS()): { grant: OAuthGrantRecord; tokens: IssuedTokens } {
  const id = `og_${randomBytes(12).toString("base64url")}`;
  const tokens = derivedTokens(id, code, ttl, now);
  db.insert(oauthGrants)
    .values({
      id,
      clientId: input.clientId,
      clientName: input.clientName,
      scopes: JSON.stringify(input.scopes),
      toolsets: JSON.stringify(input.toolsets),
      offline: input.offline,
      resource: input.resource,
      accessHash: hashToken(tokens.accessToken),
      accessExpiresAt: tokens.accessExpiresAt,
      refreshHash: hashToken(tokens.refreshToken),
      refreshExpiresAt: tokens.refreshExpiresAt,
      approvedVia: input.approvedVia,
      approvedAt: input.approvedAt,
      requestIp: input.requestIp,
      createdAt: now,
    })
    .run();
  return { grant: getOAuthGrant(id)!, tokens };
}

export function getOAuthGrant(id: string): OAuthGrantRecord | undefined {
  const row = db.select().from(oauthGrants).where(eq(oauthGrants.id, id)).get();
  return row ? toGrant(row) : undefined;
}

/** 访问令牌 → 授权：当前的那个，或者刷新前的那个（到它自己过期前都认）；过期了当不存在 */
export function findGrantByAccessToken(token: string, now = nowS()): OAuthGrantRecord | undefined {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return undefined;
  const hash = hashToken(token);
  const current = db.select().from(oauthGrants).where(eq(oauthGrants.accessHash, hash)).get();
  if (current) return current.accessExpiresAt > now ? toGrant(current) : undefined;
  const prev = db.select().from(oauthGrants).where(eq(oauthGrants.prevAccessHash, hash)).get();
  return prev && (prev.prevAccessExpiresAt ?? 0) > now ? toGrant(prev) : undefined;
}

/** 刷新令牌 → 授权（过期由调用方判断：过期和「不认识」回的错一样，但要先查是不是换过的） */
export function findGrantByRefreshToken(token: string): OAuthGrantRecord | undefined {
  if (!token.startsWith(REFRESH_TOKEN_PREFIX)) return undefined;
  const row = db.select().from(oauthGrants).where(eq(oauthGrants.refreshHash, hashToken(token))).get();
  return row ? toGrant(row) : undefined;
}

/** 这个刷新令牌以前换过：返回它属于的授权和换的时间 */
export function usedRefreshToken(token: string): { grantId: string; usedAt: number } | undefined {
  return db
    .select({ grantId: oauthUsedRefresh.grantId, usedAt: oauthUsedRefresh.usedAt })
    .from(oauthUsedRefresh)
    .where(eq(oauthUsedRefresh.hash, hashToken(token)))
    .get();
}

/**
 * 刷新：旧的刷新令牌记进「换过的」，访问令牌和刷新令牌都换成从它派生的新的；
 * 旧的访问令牌挪到「刷新前的那个」，到它自己过期前照样认。
 * 旧刷新令牌必须还是这个授权当前的那个（WHERE 里卡着）
 */
export function rotateOAuthGrant(id: string, oldRefreshToken: string, ttl: TokenTtl, now = nowS()): IssuedTokens | undefined {
  const oldHash = hashToken(oldRefreshToken);
  const tokens = derivedTokens(id, oldRefreshToken, ttl, now);
  return db.transaction((tx) => {
    const row = tx.select().from(oauthGrants).where(and(eq(oauthGrants.id, id), eq(oauthGrants.refreshHash, oldHash))).get();
    if (!row) return undefined;
    const keepPrev = row.accessExpiresAt > now;
    tx.update(oauthGrants)
      .set({
        accessHash: hashToken(tokens.accessToken),
        accessExpiresAt: tokens.accessExpiresAt,
        prevAccessHash: keepPrev ? row.accessHash : null,
        prevAccessExpiresAt: keepPrev ? row.accessExpiresAt : null,
        refreshHash: hashToken(tokens.refreshToken),
        refreshExpiresAt: tokens.refreshExpiresAt,
      })
      .where(eq(oauthGrants.id, id))
      .run();
    tx.insert(oauthUsedRefresh).values({ hash: oldHash, grantId: id, usedAt: now }).onConflictDoNothing().run();
    return tokens;
  });
}

/** 只作废访问令牌（撤销接口收到访问令牌时）：刷新令牌还能换新的 */
export function expireOAuthAccessToken(token: string): boolean {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return false;
  const hash = hashToken(token);
  const current = db
    .update(oauthGrants)
    .set({ accessHash: hashToken(secret(ACCESS_TOKEN_PREFIX)), accessExpiresAt: 0 })
    .where(eq(oauthGrants.accessHash, hash))
    .run().changes;
  const prev = db.update(oauthGrants).set({ prevAccessHash: null, prevAccessExpiresAt: null }).where(eq(oauthGrants.prevAccessHash, hash)).run().changes;
  return current + prev > 0;
}

const TOUCH_INTERVAL_S = 60;
/** 授权 id → 上次写「最近使用」的时间（秒）和 IP：和手建令牌一样，同一个 IP 60 秒内只写一次，换了 IP 立刻写 */
const lastTouch = new Map<string, { at: number; ip: string | null }>();

export function deleteOAuthGrant(id: string): boolean {
  lastTouch.delete(id);
  return db.delete(oauthGrants).where(eq(oauthGrants.id, id)).run().changes > 0;
}

/**
 * 全部断开（设置页、改密码时勾「同时撤销」）：授权全删，还没走完的授权请求也一起拒掉——
 * 不然已经批了、授权码还没换令牌的，撤完还能换出一个新的来
 */
export function deleteAllOAuthGrants(now = nowS()): number {
  lastTouch.clear();
  return db.transaction((tx) => {
    tx.update(oauthRequests)
      .set({ status: "denied", codeHash: null, approvedVia: "revoked", decidedAt: now })
      .where(inArray(oauthRequests.status, LIVE_REQUEST))
      .run();
    return tx.delete(oauthGrants).run().changes;
  });
}

export function listOAuthGrants(currentResource: string | null, now = nowS()): OAuthGrantInfo[] {
  return db
    .select()
    .from(oauthGrants)
    .where(gt(oauthGrants.refreshExpiresAt, now))
    .orderBy(desc(oauthGrants.createdAt))
    .all()
    .map((r) => toGrantInfo(toGrant(r), currentResource));
}

export function touchOAuthGrant(id: string, ip: string | null, now = nowS()): void {
  const prev = lastTouch.get(id);
  if (prev !== undefined && prev.ip === ip && now - prev.at < TOUCH_INTERVAL_S) return;
  if (lastTouch.size > 5000) lastTouch.clear();
  lastTouch.set(id, { at: now, ip });
  db.update(oauthGrants).set({ lastUsedAt: now, lastUsedIp: ip }).where(eq(oauthGrants.id, id)).run();
}

/** 刷新令牌过期了的授权：这时客户端只能重新授权，行留着没用 */
export function deleteExpiredOAuthGrants(now = nowS()): number {
  const n = db.delete(oauthGrants).where(lt(oauthGrants.refreshExpiresAt, now)).run().changes;
  // 只是「多久写一次最近使用」的节流记录：删掉的授权的条目顺手清掉，清多了顶多多写一次库
  if (n > 0) lastTouch.clear();
  return n;
}

export function deleteUsedRefreshBefore(cutoff: number): number {
  return db.delete(oauthUsedRefresh).where(lt(oauthUsedRefresh.usedAt, cutoff)).run().changes;
}

/** 仅供测试：清掉缓存的派生密钥（测试之间换库） */
export function __test_resetOAuthTokenKey(): void {
  tokenKeyCache = null;
}

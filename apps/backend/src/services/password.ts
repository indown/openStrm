/**
 * 口令哈希。
 *
 * 用 node:crypto 的 scrypt，而不是 argon2 或 bcrypt：后两者都是原生模块，
 * 这个项目已经为 better-sqlite3 的 ABI 付过一次代价——升一次 Node 就要换预编译
 * 产物，还得覆盖 musl/glibc × arm64/amd64 四种组合。scrypt 是 OWASP 认可的备选，
 * 随 Node 内置，不给构建和发版增加任何新面。
 *
 * 参数取 OWASP 列出的等价档位里内存最省的那档（N=2^14 → 16 MiB, r=8, p=5）。
 * 这东西常跑在 NAS 和树莓派上，而 scrypt 的内存开销会被并发登录放大；异步 scrypt
 * 走 libuv 线程池，并发被池大小卡住，峰值内存因此有界。
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const PREFIX = "scrypt";
const N = 1 << 14;
const R = 8;
const P = 5;
const KEY_LEN = 32;
const SALT_LEN = 16;

// Node 在 128*N*r 超过 maxmem 时直接抛错，默认的 32 MiB 不够这组参数用
const MAX_MEM = 64 * 1024 * 1024;
// 只有本模块会写这个串，但库是可以被手工改的，别让一个畸形的 N 把进程撑爆
const MAX_N = 1 << 20;

function derive(plain: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, KEY_LEN, { N: n, r, p, maxmem: MAX_MEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** 先摘要再比，绕开 timingSafeEqual 对等长的要求，同时不泄露长度 */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

export function isHashed(stored: string): boolean {
  return stored.startsWith(`${PREFIX}$`);
}

/** `scrypt$N$r$p$salt$hash`——参数写在串里，将来调参才认得出哪些是旧记录 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(plain, salt, N, R, P);
  return [PREFIX, N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!stored) return false;

  // 升级前的库里是明文。照常校验，登录成功时由调用方就地补哈希。
  if (!isHashed(stored)) return sameSecret(plain, stored);

  const parts = stored.split("$");
  if (parts.length !== 6) return false;
  const [, rawN, rawR, rawP, saltB64, hashB64] = parts;

  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(n) || n < 2 || n > MAX_N) return false;
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) return false;

  const expected = Buffer.from(hashB64, "base64");
  if (expected.length !== KEY_LEN) return false;

  const actual = await derive(plain, Buffer.from(saltB64, "base64"), n, r, p);
  return timingSafeEqual(expected, actual);
}

/** 明文，或者参数已经和当前档位对不上——都该在下次拿到明文时重算 */
export function needsRehash(stored: string): boolean {
  if (!isHashed(stored)) return true;
  const [, n, r, p] = stored.split("$");
  return Number(n) !== N || Number(r) !== R || Number(p) !== P;
}

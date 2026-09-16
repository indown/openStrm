/**
 * 当前版本号，和「哪个版本更新」的比较。纯函数，规则改动先过 version.test.ts。
 *
 * 版本形状是发版工作流保证的：tag `vX.Y.Z` 或 `vX.Y.Z-rc.N`，镜像里把去掉 v 前缀的那串写进 APP_VERSION，
 * 本地开发退回 package.json。自己 build 出来的版本号可能什么都不是（`dev`），比不了就当「没有更新」，别去烦用户。
 */
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

/** 当前跑的版本，裸版本号（不带 v） */
export const APP_VERSION = process.env.APP_VERSION || pkg.version;

interface Parsed {
  nums: [number, number, number];
  /** 预发布段（`rc.2` → ["rc", 2]）；正式版是空数组 */
  pre: Array<string | number>;
}

const RE_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** `v2.7.0-rc.2` → { nums: [2,7,0], pre: ["rc", 2] }；不是这个形状的返回 null */
export function parseVersion(raw: string): Parsed | null {
  const m = RE_VERSION.exec((raw ?? "").trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg)) : [];
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

/** semver 的预发布比较：数字段比数字，字符串段按字典序，数字段小于字符串段，段少的小（`1.0.0-rc < 1.0.0-rc.1`） */
function comparePre(a: Array<string | number>, b: Array<string | number>): number {
  // 有预发布段的小于没有的：2.7.0-rc.2 < 2.7.0
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x < y ? -1 : 1;
      continue;
    }
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** a 比 b 小 → -1，相等 → 0，大 → 1；有一边解析不了返回 null（比不了） */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  const pre = comparePre(pa.pre, pb.pre);
  return pre === 0 ? 0 : pre < 0 ? -1 : 1;
}

/** candidate 比 current 新（比不了当作不新） */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}

/** 是不是预发布版本（`2.8.0-rc.1`）；解析不了当正式版 */
export function isPrerelease(raw: string): boolean {
  return (parseVersion(raw)?.pre.length ?? 0) > 0;
}

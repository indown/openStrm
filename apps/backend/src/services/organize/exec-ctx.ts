/**
 * 执行和撤销共用的网盘操作上下文：目录列举缓存（改名 / 移动后顺手更新，不用重新列）、临时失败的重试。
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { AppSettings, TaskDefinition } from "@openstrm/shared";
import { isAbortError } from "../../lib/errors.js";
import { normalizePath, splitPath, type DriveProvider } from "../drive/types.js";
import { classifyFailure, messageOf, OrganizeFailure, StaleError } from "./failures.js";
import { deps, type Job, jobLog, baseOf } from "./run-state.js";

/* ------------------------------- 执行 ------------------------------- */

export type DirEntryRef = { id: string; isDir: boolean };

/** 列目录 / 撞名检查要的最小上下文：执行、撤销、放弃共用 */
export interface ListCtx {
  provider: DriveProvider;
  signal: AbortSignal;
  /** 网盘绝对路径 → 目录 id */
  dirIds: Map<string, string>;
  /** 本轮列过的目录：绝对路径 → 名字 → { id, isDir }；我们自己改名 / 挪动之后原地更新，别整个丢掉再列 */
  listings: Map<string, Map<string, DirEntryRef>>;
}

export interface ExecCtx extends ListCtx {
  job: Job;
  task: TaskDefinition;
  settings: AppSettings;
  tasks: TaskDefinition[];
}

export const listCtx = (provider: DriveProvider, signal: AbortSignal): ListCtx => ({ provider, signal, dirIds: new Map(), listings: new Map() });

/** 我们自己在目录里改了名：更新本轮的目录缓存 */
export function noteRenamed(ctx: ListCtx, dir: string, oldName: string, newName: string, node: DirEntryRef): void {
  const listing = ctx.listings.get(normalizePath(dir));
  if (!listing) return;
  listing.delete(oldName);
  listing.set(newName, node);
}

/** 我们自己把目录里的一项删掉了：更新本轮的目录缓存 */
export function noteRemoved(ctx: ListCtx, dir: string, name: string): void {
  ctx.listings.get(normalizePath(dir))?.delete(name);
}

/** 我们自己把文件从 from 挪到了 to：两边的目录缓存都更新 */
export function noteMoved(ctx: ListCtx, from: string, to: string, name: string, node: DirEntryRef): void {
  ctx.listings.get(normalizePath(from))?.delete(name);
  ctx.listings.get(normalizePath(to))?.set(name, node);
}

export async function dirIdOf(ctx: ListCtx, abs: string): Promise<string> {
  const hit = ctx.dirIds.get(abs);
  if (hit) return hit;
  const node = await ctx.provider.resolvePath(abs, ctx.signal);
  if (!node || !node.isDir) throw new StaleError(`网盘上没有目录 ${abs}`);
  ctx.dirIds.set(abs, node.id);
  return node.id;
}

/**
 * 目录里现在有哪些名字。本轮列过的用 ctx 里的缓存（我们自己在里面改过名 / 挪过之后调用方会把它清掉）；
 * 真去列时绕过网盘客户端自己的缓存（115 的进程内缓存 5 分钟），不然预览之后别人放进来的同名文件看不见
 */
export async function namesIn(ctx: ListCtx, dirAbs: string): Promise<Map<string, DirEntryRef>> {
  const dir = normalizePath(dirAbs);
  let listing = ctx.listings.get(dir);
  if (!listing) {
    const pid = await dirIdOf(ctx, dir);
    listing = new Map((await ctx.provider.listDir(pid, ctx.signal, { fresh: true })).map((e) => [e.name, { id: e.id, isDir: e.isDir }]));
    ctx.listings.set(dir, listing);
  }
  return listing;
}

export async function nodeOf(ctx: ListCtx, abs: string, knownId: string): Promise<DirEntryRef> {
  if (knownId) return { id: knownId, isDir: false };
  const hit = (await namesIn(ctx, normalizePath(splitPath(abs).slice(0, -1).join("/")))).get(baseOf(abs));
  if (!hit) throw new StaleError(`网盘上找不到 ${abs}`);
  return hit;
}

/**
 * 预览之后目标位置可能被别人占了：网盘对同名要么拒绝（夸克 23008 / OpenList 403），要么自己加个 (1)（115 的 move）——
 * 后者会让记账和真实名字对不上、本地 strm 指向别人的文件。所以动手前先看一眼，撞名的记 rejected、不碰网盘。
 * ours：本轮自己的项的节点 id（或单个 id），占着名字的是它们就不算别人（连环改名、上次挪过去没记账）
 */
export const occupied = (names: Map<string, DirEntryRef>, name: string, ours?: ReadonlySet<string> | string): boolean => {
  const hit = names.get(name);
  if (!hit) return false;
  if (typeof ours === "string") return hit.id !== ours;
  return !ours?.has(hit.id);
};

export const clashError = (where: string, name: string): OrganizeFailure => new OrganizeFailure("rejected", new Error(`${where}已经有同名文件 ${name}，网盘不会覆盖`));

/**
 * 网盘调用统一从这里走：失败先分类，临时失败（网络 / 超时 / 5xx）等 retryDelayMs 再来一次，仍失败按类别抛 OrganizeFailure；
 * 风控 / 登录失效 / 预览后变了 / 名字不被接受 不重试
 */
export async function withRetry<T>(ctx: ExecCtx, fn: () => Promise<T>): Promise<T> {
  const signal = ctx.job.abort.signal;
  for (let n = 0; ; n++) {
    try {
      return await fn();
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      const kind = classifyFailure(ctx.provider, err);
      if (kind === "transient" && n === 0) {
        jobLog(ctx.job, `临时失败（${messageOf(err)}），${deps.retryDelayMs / 1000} 秒后重试`);
        await sleep(deps.retryDelayMs, undefined, { signal });
        continue;
      }
      throw new OrganizeFailure(kind, err);
    }
  }
}

/**
 * 收藏夹里的作品「已经有了」：本地 strm 目录里认得出是这一部的（整理过的目录名带 [tmdbid=…]、作品 nfo、整理记录），
 * 和从收藏夹转存过的（library_saves，见 saves.ts）。没整理过、目录名里也没有 id 的认不出：没标的不等于没有。
 *
 * 本地那份要扫盘：算好了留 TTL_MS，过期了先给旧的、后台重算；任务表变了就重算。
 * 第一次还没算好时界面不等（先不显示「已有」，下一次轮询就有了），智能体最多等几秒
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { LibraryOwned, TaskDefinition } from "@openstrm/shared";
import { savedWorkKeys, savesOfUnit, savesOfWork } from "../../db/repositories/library-units.js";
import { listTasks } from "../../db/repositories/tasks.js";
import { moduleLogger } from "../../lib/logger.js";
import { scanLocalWorks } from "../strm/poster.js";

const log = moduleLogger("library-owned");

const TTL_MS = 10 * 60_000;

/** `movie:1` / `tv:2` → 本地哪些任务的哪个目录里有 */
export type LocalOwned = Map<string, LibraryOwned[]>;

let cache: { key: string; at: number; value: LocalOwned } | null = null;
let running: { key: string; promise: Promise<LocalOwned> } | null = null;

const tasksKey = (tasks: TaskDefinition[]) => JSON.stringify(tasks.map((t) => [t.id, t.account, t.originPath, t.targetPath]));
const taskLabelOf = (task: TaskDefinition | undefined, id: string) => (task ? `${task.account} · ${task.originPath}` : id);

async function build(tasks: TaskDefinition[]): Promise<LocalOwned> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: LocalOwned = new Map();
  for (const w of await scanLocalWorks(tasks)) {
    const key = `${w.mediaType}:${w.tmdbId}`;
    const list = out.get(key) ?? [];
    list.push({ via: "local", taskId: w.taskId, taskLabel: taskLabelOf(byId.get(w.taskId), w.taskId), path: w.rel, seasons: w.seasons });
    out.set(key, list);
  }
  return out;
}

function refresh(tasks: TaskDefinition[], key: string): Promise<LocalOwned> {
  if (running?.key === key) return running.promise;
  const started = Date.now();
  const promise = build(tasks)
    .then((value) => {
      cache = { key, at: Date.now(), value };
      log.debug({ works: value.size, ms: Date.now() - started }, "扫完本地作品目录");
      return value;
    })
    .finally(() => {
      if (running?.promise === promise) running = null;
    });
  running = { key, promise };
  promise.catch((err: unknown) => log.warn({ err }, "扫本地作品目录出错"));
  return promise;
}

/**
 * 本地已有的作品索引。还没算过时最多等 waitMs，等不到给 null（界面传 0）；
 * 算过但过期了先给旧的、后台重算
 */
export async function localOwned(waitMs: number): Promise<LocalOwned | null> {
  const tasks = listTasks();
  const key = tasksKey(tasks);
  if (cache?.key === key) {
    if (Date.now() - cache.at >= TTL_MS) refresh(tasks, key).catch(() => undefined);
    return cache.value;
  }
  const pending = refresh(tasks, key);
  if (waitMs <= 0) {
    pending.catch(() => undefined);
    return null;
  }
  return Promise.race([pending.catch(() => null), sleep(waitMs).then(() => null)]);
}

function savedEntries(rows: Array<{ taskId: string; subPath: string; savedAt: number; rawName: string; seasons: number[] }>): LibraryOwned[] {
  const byId = new Map(listTasks().map((t) => [t.id, t]));
  return rows.map((r) => ({
    via: "saved",
    taskId: r.taskId,
    taskLabel: taskLabelOf(byId.get(r.taskId), r.taskId),
    path: r.subPath ? `${r.subPath}/${r.rawName}` : r.rawName,
    seasons: r.seasons,
    savedAt: r.savedAt,
  }));
}

/** 一部认出来的作品已经有了的地方：本地的在前，再是从收藏夹存过的 */
export function ownedOfWork(mediaType: "movie" | "tv", tmdbId: number, local: LocalOwned | null): LibraryOwned[] {
  return [...(local?.get(`${mediaType}:${tmdbId}`) ?? []), ...savedEntries(savesOfWork(mediaType, tmdbId))];
}

/** 没认出的单元（作品就是它自己）：只看从收藏夹存过的 */
export function ownedOfUnit(unit: { sourceId: string; unitKey: string; rawName: string; seasons: number[] }): LibraryOwned[] {
  return savedEntries(savesOfUnit(unit.sourceId, unit.unitKey).map((s) => ({ ...s, rawName: unit.rawName, seasons: unit.seasons })));
}

/** 已经有了的作品键（海报墙的「已有」角标）：本地的 + 存过的 */
export function ownedWorkKeys(local: LocalOwned | null): Set<string> {
  const keys = savedWorkKeys();
  for (const k of local?.keys() ?? []) keys.add(k);
  return keys;
}

/** 仅供测试：清掉缓存 */
export function __test_resetOwned(): void {
  cache = null;
  running = null;
}

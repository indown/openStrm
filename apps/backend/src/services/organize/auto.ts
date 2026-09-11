/**
 * 自动整理的入口：转存 / 追更 / 云下载 / 网盘监控把「新落到任务目录的路径」交到这里，
 * 按任务的 organize.mode（off / review / auto）决定要不要建一个 auto 模式的 run。
 *
 *   - 监控的新增事件一条一条来（一部剧转存进来是几十条），按任务攒 30 秒再建 run；其它入口立刻建。
 *   - 任务已有一次整理在进行中（409）就过一分钟再试，路径合并进去。
 *   - 任何失败只记日志：自动整理是锦上添花，不能把转存 / 追更本身搞失败。
 */
import type { OrganizeTrigger, TaskDefinition } from "@openstrm/shared";
import { readAppSettings } from "../../db/repositories/settings.js";
import { getTask } from "../../db/repositories/tasks.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { createRun } from "./run.js";
import { taskAutoMode } from "./settings.js";

const log = moduleLogger("organize-auto");

const DEBOUNCE_MS = 30_000;
const RETRY_MS = 60_000;

interface Pending {
  paths: Set<string>;
  trigger: OrganizeTrigger;
  /** 合并进来的请求里只要有一个要 review，整个 run 就 review */
  mode: "review" | "auto";
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

interface Deps {
  createRun: typeof createRun;
  debounceMs: number;
  retryMs: number;
}

const realDeps: Deps = { createRun, debounceMs: DEBOUNCE_MS, retryMs: RETRY_MS };
let deps: Deps = { ...realDeps };

/** 仅供测试 */
export function setAutoOrganizeDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

export interface AutoOrganizeInput {
  task: TaskDefinition;
  /** 相对任务 originPath 的新增路径（文件或目录） */
  paths: string[];
  trigger: OrganizeTrigger;
  /** 攒一会再建 run（监控事件用） */
  debounce?: boolean;
  /** 这一次强制按这个策略来（转存弹框勾了「转存后整理」）；不给就按任务的设置 */
  mode?: "review" | "auto";
}

export function maybeAutoOrganize(input: AutoOrganizeInput): void {
  const paths = input.paths.map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean);
  if (paths.length === 0) return;
  const settings = readAppSettings();
  const mode = input.mode ?? taskAutoMode(input.task, settings);
  if (mode === "off") return;
  if (!settings.tmdb?.apiKey?.trim()) {
    log.debug({ taskId: input.task.id }, "任务开了自动整理但没配 TMDB，跳过");
    return;
  }
  schedule(input.task.id, paths, input.trigger, mode, input.debounce ? deps.debounceMs : 0);
}

function schedule(taskId: string, paths: string[], trigger: OrganizeTrigger, mode: "review" | "auto", delayMs: number): void {
  const existing = pending.get(taskId);
  if (existing) {
    for (const p of paths) existing.paths.add(p);
    if (mode === "review") existing.mode = "review";
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => fire(taskId), Math.max(delayMs, 0));
    existing.timer.unref?.();
    return;
  }
  const entry: Pending = { paths: new Set(paths), trigger, mode, timer: setTimeout(() => fire(taskId), delayMs) };
  entry.timer.unref?.();
  pending.set(taskId, entry);
}

async function fire(taskId: string): Promise<void> {
  const entry = pending.get(taskId);
  if (!entry) return;
  pending.delete(taskId);
  const task = getTask(taskId);
  if (!task) return;
  const paths = [...entry.paths];
  try {
    const run = await deps.createRun({ taskId, paths, mode: entry.mode, trigger: entry.trigger });
    log.info({ taskId, runId: run.id, paths: paths.length, trigger: entry.trigger, mode: entry.mode }, "自动整理已建 run");
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      log.debug({ taskId }, "任务有整理在进行中，一分钟后再试");
      schedule(taskId, paths, entry.trigger, entry.mode, deps.retryMs);
      return;
    }
    log.warn({ err, taskId }, "自动整理建 run 失败");
  }
}

/** 仅供测试：立刻把攒着的都发出去 */
export async function __test_flushAutoOrganize(): Promise<void> {
  for (const [taskId, entry] of pending) {
    clearTimeout(entry.timer);
    await fire(taskId);
  }
}

export function __test_resetAutoOrganize(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
}

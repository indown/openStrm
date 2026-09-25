/**
 * 把分享里选中的条目转存到某个同步任务的目录，然后生成 strm。
 * 分享详情弹框、影库、Telegram、追更四个入口都走这里；网盘的差异全在 Provider 里。
 *
 *   sync  → 转存完立刻按条目生成 strm（目录按子树列，夸克能拿到转存后的顶层 id 就直接按 id 列）
 *   async → 转存完交给全量任务引擎在后台跑
 */
import type { AppSettings, TaskDefinition } from "@openstrm/shared";
import { HttpError } from "../../lib/http-error.js";
import { driveErrorToHttp } from "../drive/errors.js";
import { assertSameKind, providerForTask } from "../drive/registry.js";
import type { DriveProvider, ShareRef } from "../drive/types.js";
import { COPY_TRIGGER_LABEL, enqueueCopyFor, type CopyOutcome } from "../copy/service.js";
import { copyBlockerFor, copyOptionsFor } from "../copy/paths.js";
import { releaseCopyHoldsById, type CopyTrigger } from "../copy/queue.js";
import { effectiveAutoMode, maybeAutoOrganize } from "../organize/auto.js";
import { generateStrmForSelected, type SelectedItem } from "../strm/share-strm.js";
import { setTimeout as sleep } from "node:timers/promises";
import { moduleLogger } from "../../lib/logger.js";
import { startTask } from "../task/runner.js";

const log = moduleLogger("share");

export interface SaveItem {
  id: string;
  name: string;
  isDir: boolean;
  /** 夸克转存要的 share_fid_token；115 没有 */
  token?: string;
}

export interface SaveSelectionOpts {
  task: TaskDefinition;
  /** 不给就按任务的账号取 */
  provider?: DriveProvider;
  ref: ShareRef;
  items: SaveItem[];
  /** 调用方负责已经 split/trim/filter/join 过 */
  subPath: string;
  mode: "sync" | "async";
  settings: AppSettings;
  signal?: AbortSignal;
  /**
   * 转存完顺手整理：不给就按任务的自动整理设置；true = 至少生成待确认清单（任务设了 auto 就直接执行）；
   * false = 这次不整理，任务设了自动整理也不管（智能体里用户说「只转存，别整理」时用）
   */
  organize?: boolean;
  /** 这次强制复制到 OpenList / 强制不复制；不给就按任务上的开关 */
  copy?: boolean;
  /** 复制队列里记的来源，不给就是「分享转存」；追更复用这条路时写成「追更」 */
  copyTrigger?: CopyTrigger;
}

/**
 * copy：这次交没交给复制队列（没开复制就不带），智能体的结果里照实回显。
 * receivedIds：转存进网盘后的顶层节点 id，和 items 一一对应（网盘给了才有：夸克有、115 没有），之后要核对「还是不是这一份」时用
 */
export type SaveSelectionResult =
  | { mode: "sync"; generatedCount: number; skippedCount: number; invalidNames: string[]; copy?: CopyOutcome; receivedIds?: string[] }
  | { mode: "async"; taskId?: string; message?: string; copy?: CopyOutcome; receivedIds?: string[] }
  | { mode: "async"; error: unknown; copy?: CopyOutcome; receivedIds?: string[] };

/** 同一个 id 只转存一次：弹框里重复勾选、API 调用方重复传，网盘都会照单再复制一份 */
export function uniqueItems<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = String(item.id).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 「转存后整理」勾上时这次按哪种来：任务设了 auto 就直接执行，否则至少出一份待确认的清单；没勾就按任务设置（undefined） */
export function forcedOrganizeMode(task: TaskDefinition, organize: boolean | undefined): "review" | "auto" | undefined {
  return organize ? (task.organize?.mode === "auto" ? "auto" : "review") : undefined;
}

export async function saveSelectionToTask(opts: SaveSelectionOpts): Promise<SaveSelectionResult> {
  const { task, ref, subPath, mode, settings, signal } = opts;
  const provider = opts.provider ?? providerForTask(task, "share");
  const share = provider.share;
  if (!share) throw new HttpError(400, `任务 ${task.id} 的账号不支持分享转存`);
  assertSameKind(ref, provider);
  if (!task.targetPath || !task.strmPrefix) throw new HttpError(400, "所选任务缺少 targetPath 或 strmPrefix 配置");
  const items = uniqueItems(opts.items);
  if (items.length === 0) throw new HttpError(400, "没有要转存的条目");
  // 这次明确勾了复制却复制不了：转存前就说清楚（同云下载），别转存完了才悄悄不复制
  if (opts.copy === true) {
    const why = copyBlockerFor(settings)(task);
    if (why) throw new HttpError(400, `没法复制到 OpenList：${why}。先到设置页的「复制到 OpenList」里配好，或者这次不勾复制`);
  }

  const fullOriginPath = subPath ? `${task.originPath}/${subPath}` : task.originPath;
  let targetId: string;
  try {
    const node = await provider.resolvePath(fullOriginPath, signal);
    // 找不到时不能退回根目录：那会把东西转存进网盘根目录里
    if (!node || !node.isDir || node.id === provider.rootId) {
      throw new HttpError(400, `无法在网盘上找到保存目录：${fullOriginPath}`);
    }
    targetId = node.id;
  } catch (err) {
    throw driveErrorToHttp(err, `解析保存目录失败：${fullOriginPath}`);
  }

  let topIds: string[] | undefined;
  try {
    const session = await share.open(ref, signal);
    const result = await share.receive(session, items.map((i) => ({ id: i.id, token: i.token })), targetId, signal);
    topIds = result.topIds;
  } catch (err) {
    throw driveErrorToHttp(err, "转存失败");
  }
  // 网盘给了转存后的顶层 id 且一一对应时，目录直接按 id 列，省掉按路径解析那一步；删源时也靠它核对
  const ids = topIds && topIds.length === items.length ? topIds : [];
  // 任务开了自动整理（或这次勾了「转存后整理」）就交给整理；明确给了 false 就这次不整理。
  // 后台模式不整理（整理和全量同步同时动一个目录会互相踩）
  const organizeMode = mode === "sync" && opts.organize !== false ? forcedOrganizeMode(task, opts.organize) : undefined;
  const organizing = mode === "sync" && opts.organize !== false && effectiveAutoMode(task, organizeMode, settings) === "auto";
  // 任务开了「复制到 OpenList」（或这次勾了）：转存完马上登记，在生成 strm、交给整理之前。网盘监控随后按文件报上来的，
  // 被这一条整条目包着就不再单独登记；登记晚了，它们会先按文件复制走，轮到这一条时目标里已经有了只能跳过，
  // 任务的「复制后删源」就落空了。要直接执行的整理先压着，等它在网盘上改完名再复制
  let copyIds: string[] = [];
  const copy = enqueueReceivedCopy({
    task,
    account: provider.account.name,
    items: items.map((i, idx) => ({ name: i.name, isDir: i.isDir, nodeId: ids[idx] })),
    subPath,
    copy: opts.copy,
    settings,
    organizing,
    trigger: opts.copyTrigger,
    onQueued: (queued) => (copyIds = queued),
  });
  const withCopy = { ...(copy ? { copy } : {}), ...(ids.length ? { receivedIds: ids } : {}) };

  if (mode === "sync") {
    const selectedItems: SelectedItem[] = items.map((i, idx) => ({ name: i.name, isDir: i.isDir, id: ids[idx] }));
    try {
      const { generatedCount, skippedCount, invalidNames } = await generateStrmForSelected({ task, provider, selectedItems, settings, subPath });
      // 刚转存进来的这些条目交给整理，识别失败或没开都不影响这次转存
      if (opts.organize !== false) {
        maybeAutoOrganize({ task, paths: items.map((i) => (subPath ? `${subPath}/${i.name}` : i.name)), trigger: "share", mode: organizeMode });
      }
      return { mode: "sync", generatedCount, skippedCount, invalidNames, ...withCopy };
    } catch (err) {
      // 走到这里时转存已经成功了，只是本地 strm 没生成好：标出来，调用方才知道别再转存一遍（网盘会再复制一份）。
      // 复制只读网盘、不靠 strm，前面已经排上了，排没排上一起带回去；这次没交给整理，为等它压着的那几条放行
      if (organizing) releaseCopyHoldsById(copyIds);
      const http = driveErrorToHttp(err, "生成 strm 失败");
      throw new HttpError(http.status, http.message, { ...http.extra, received: true, ...(copy ? { copy } : {}) }, { cause: http.cause ?? err });
    }
  }

  /**
   * 「后台」就是不等同步：startTask 要先把远端目录树拉完才返回，115 的大目录导出要好几分钟，
   * 一直等着的话前端的请求会先超时、报「保存失败」，其实转存早就成了（真机撞到过）。
   * 所以只等一小会儿：起得快就照常回结果；没回来就先说「已触发后台同步」，同步接着跑，
   * 起不来的原因 startTask 自己会记进任务历史并发通知
   */
  const started = startTask(task.id, { trigger: "share" });
  const quick = await Promise.race([started.then((r) => ({ r })), sleep(asyncStartGraceMs).then(() => null)]);
  if (!quick) {
    started.catch((err) => log.warn({ err, taskId: task.id }, "后台同步没起来"));
    return { mode: "async", taskId: task.id, message: "已触发后台同步，远端目录较大，还在读取", ...withCopy };
  }
  const result = quick.r;
  if (result.status !== 200) return { mode: "async", error: result.body, ...withCopy };
  const body = result.body as { taskId?: string; message?: string };
  return { mode: "async", taskId: body.taskId, message: body.message, ...withCopy };
}

/**
 * 把已经转存进任务目录的条目交给复制队列（任务开了「复制到 OpenList」，或者这次明说要复制）。
 * 转存完顺手做；智能体「上次转存没复制、这次补上」也走这里。
 * copy 同 SaveSelectionOpts.copy；organizing = 刚排了会直接执行的自动整理：先压着，等它在网盘上改完名再复制
 */
export function enqueueReceivedCopy(input: {
  task: TaskDefinition;
  /** 网盘账号名 */
  account: string;
  /** nodeId：转存后的网盘节点 id，删源时核对；不知道就不填，要删源时提交那一刻再钉 */
  items: Array<{ name: string; isDir: boolean; nodeId?: string }>;
  subPath: string;
  copy: boolean | undefined;
  settings: AppSettings;
  organizing: boolean;
  /** 复制队列里记的来源，默认「分享转存」 */
  trigger?: CopyTrigger;
  /** 拿到这次新排上的记录 id */
  onQueued?: (ids: string[]) => void;
}): CopyOutcome | undefined {
  const { task } = input;
  const trigger = input.trigger ?? "share";
  const dir = input.subPath ? `${task.originPath}/${input.subPath}` : task.originPath;
  return enqueueCopyFor(
    copyOptionsFor(task, input.copy, input.settings),
    {
      account: input.account,
      sources: input.items.map((i) => ({ path: `${dir}/${i.name}`, isDir: i.isDir, nodeId: i.nodeId })),
      rootPath: task.originPath,
      taskId: task.id,
      trigger,
      holdForOrganize: input.organizing,
    },
    (why) => log.info(`任务 ${task.originPath} 开着复制到 OpenList，但${why}，这次${COPY_TRIGGER_LABEL[trigger]}来的不复制`),
    input.onQueued,
  );
}

/** 后台模式转存最多等同步起来这么久，再长就先回话（前端的请求有超时） */
export const ASYNC_START_GRACE_MS = 8_000;
let asyncStartGraceMs = ASYNC_START_GRACE_MS;

/** 仅供测试：把等同步起来的时间调短；传 null 恢复 */
export function __test_setAsyncStartGrace(ms: number | null): void {
  asyncStartGraceMs = ms ?? ASYNC_START_GRACE_MS;
}

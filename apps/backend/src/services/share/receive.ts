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
import { generateStrmForSelected, type SelectedItem } from "../strm/share-strm.js";
import { startTask } from "../task/runner.js";

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
}

export type SaveSelectionResult =
  | { mode: "sync"; generatedCount: number; skippedCount: number; invalidNames: string[] }
  | { mode: "async"; taskId?: string; message?: string }
  | { mode: "async"; error: unknown };

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

export async function saveSelectionToTask(opts: SaveSelectionOpts): Promise<SaveSelectionResult> {
  const { task, ref, subPath, mode, settings, signal } = opts;
  const provider = opts.provider ?? providerForTask(task, "share");
  const share = provider.share;
  if (!share) throw new HttpError(400, `任务 ${task.id} 的账号不支持分享转存`);
  assertSameKind(ref, provider);
  if (!task.targetPath || !task.strmPrefix) throw new HttpError(400, "所选任务缺少 targetPath 或 strmPrefix 配置");
  const items = uniqueItems(opts.items);
  if (items.length === 0) throw new HttpError(400, "没有要转存的条目");

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

  if (mode === "sync") {
    // 网盘给了转存后的顶层 id 且一一对应时，目录直接按 id 列，省掉按路径解析那一步
    const ids = topIds && topIds.length === items.length ? topIds : [];
    const selectedItems: SelectedItem[] = items.map((i, idx) => ({ name: i.name, isDir: i.isDir, id: ids[idx] }));
    try {
      const { generatedCount, skippedCount, invalidNames } = await generateStrmForSelected({ task, provider, selectedItems, settings, subPath });
      return { mode: "sync", generatedCount, skippedCount, invalidNames };
    } catch (err) {
      throw driveErrorToHttp(err, "生成 strm 失败");
    }
  }

  const result = await startTask(task.id, { trigger: "share" });
  if (result.status !== 200) return { mode: "async", error: result.body };
  const body = result.body as { taskId?: string; message?: string };
  return { mode: "async", taskId: body.taskId, message: body.message };
}

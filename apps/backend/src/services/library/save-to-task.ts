import type {
  Account115,
  AccountInfo as SharedAccountInfo,
  AppSettings,
  TaskDefinition,
} from "@openstrm/shared";
import type { AccountInfo } from "../cloud-115/client.js";
import { fsDirGetId } from "../cloud-115/client.js";
import { receiveToMyDrive } from "../cloud-115/share.js";
import { generateStrmForSelected, type SelectedItem } from "../strm/share-strm.js";
import { startTask } from "../task/runner.js";
import { HttpError } from "../../lib/http-error.js";

export interface SaveSelectionOpts {
  task: TaskDefinition;
  accountInfo: AccountInfo;
  shareCode: string;
  receiveCode: string;
  fileIds: Array<number | string>;
  selectedItems: SelectedItem[];
  /** 调用方负责已经 split/trim/filter/join 过 */
  subPath: string;
  mode: "sync" | "async";
  settings: AppSettings;
}

export type SaveSelectionResult =
  | { mode: "sync"; generatedCount: number; skippedCount: number }
  | { mode: "async"; taskId?: string; message?: string }
  | { mode: "async"; error: unknown };

/**
 * 按 task 指定的 account 把 (shareCode, fileIds) 转存到 115，然后:
 *   sync  → 立即生成 strm
 *   async → 交给全量任务引擎在后台下载
 */
export async function saveSelectionToTask(opts: SaveSelectionOpts): Promise<SaveSelectionResult> {
  const {
    task,
    accountInfo,
    shareCode,
    receiveCode,
    fileIds,
    selectedItems,
    subPath,
    mode,
    settings,
  } = opts;

  if (!task.targetPath || !task.strmPrefix) {
    throw new HttpError(400, "所选任务缺少 targetPath 或 strmPrefix 配置");
  }

  const fullOriginPath = subPath ? `${task.originPath}/${subPath}` : task.originPath;
  const idRes = (await fsDirGetId(fullOriginPath, { accountInfo })) as { id?: number | string };
  // getid 对不存在的路径回 id=0，而 0 是网盘根目录：不拦住就把东西转存进根目录里了
  if (idRes?.id == null || String(idRes.id) === "" || String(idRes.id) === "0") {
    throw new HttpError(400, `无法在 115 上找到保存目录：${fullOriginPath}`);
  }

  try {
    await receiveToMyDrive(accountInfo, shareCode, receiveCode, fileIds, idRes.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "转存到 115 失败";
    throw new HttpError(502, msg);
  }

  if (mode === "sync") {
    if (selectedItems.length === 0) {
      throw new HttpError(400, "selectedItems is required for sync mode");
    }
    try {
      const { generatedCount, skippedCount } = await generateStrmForSelected({
        task,
        selectedItems,
        accountInfo,
        settings,
        subPath,
      });
      return { mode: "sync", generatedCount, skippedCount };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "生成 strm 失败";
      throw new HttpError(502, msg);
    }
  }

  const result = await startTask(task.id, { trigger: "share" });
  if (result.status !== 200) return { mode: "async", error: result.body };
  const body = result.body as { taskId?: string; message?: string };
  return { mode: "async", taskId: body.taskId, message: body.message };
}

/**
 * 按 task.account 从已读取的 accounts 里挑对应 115 账号。
 * 调用方负责把错误转成 HTTP。
 */
export function resolveTaskAccount115(
  accounts: SharedAccountInfo[],
  task: TaskDefinition,
): Account115 {
  const accountInfo = accounts.find((a) => a.name === task.account);
  if (!accountInfo) {
    throw new HttpError(400, `Task ${task.id} 绑定的账号 ${task.account} 不存在`);
  }
  if (accountInfo.accountType !== "115") {
    throw new HttpError(400, `Task ${task.id} 绑定的账号 ${task.account} 不是 115 账号`);
  }
  return accountInfo;
}

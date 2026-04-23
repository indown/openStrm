import type { FastifyInstance } from "fastify";
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
  fastify: FastifyInstance;
  authHeader: string;
}

export type SaveSelectionResult =
  | { mode: "sync"; generatedCount: number; skippedCount: number }
  | { mode: "async"; taskId?: string; message?: string }
  | { mode: "async"; error: unknown };

/** 表示"可映射到 4xx 的业务失败"，供 handler 转成具体 HTTP code */
export class SaveToTaskError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.name = "SaveToTaskError";
  }
}

/**
 * 按 task 指定的 account 把 (shareCode, fileIds) 转存到 115，然后:
 *   sync  → 立即生成 strm
 *   async → 注入 /api/startTask 交给后台下载
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
    fastify,
    authHeader,
  } = opts;

  if (!task.targetPath || !task.strmPrefix) {
    throw new SaveToTaskError("所选任务缺少 targetPath 或 strmPrefix 配置", 400);
  }

  const fullOriginPath = subPath ? `${task.originPath}/${subPath}` : task.originPath;
  const idRes = (await fsDirGetId(fullOriginPath, { accountInfo })) as { id?: number | string };
  if (idRes?.id == null) {
    throw new SaveToTaskError(`无法在 115 上找到保存目录：${fullOriginPath}`, 400);
  }

  try {
    await receiveToMyDrive(accountInfo, shareCode, receiveCode, fileIds, idRes.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "转存到 115 失败";
    throw new SaveToTaskError(msg, 502);
  }

  if (mode === "sync") {
    if (selectedItems.length === 0) {
      throw new SaveToTaskError("selectedItems is required for sync mode", 400);
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
      throw new SaveToTaskError(msg, 502);
    }
  }

  const injectRes = await fastify.inject({
    method: "POST",
    url: "/api/startTask",
    payload: { id: task.id },
    headers: { authorization: authHeader },
  });
  const injectBody = injectRes.json() as { taskId?: string; message?: string };
  if (injectRes.statusCode !== 200) {
    return { mode: "async", error: injectBody };
  }
  return { mode: "async", taskId: injectBody.taskId, message: injectBody.message };
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
    throw new SaveToTaskError(`Task ${task.id} 绑定的账号 ${task.account} 不存在`, 400);
  }
  if (accountInfo.accountType !== "115") {
    throw new SaveToTaskError(
      `Task ${task.id} 绑定的账号 ${task.account} 不是 115 账号`,
      400,
    );
  }
  return accountInfo;
}

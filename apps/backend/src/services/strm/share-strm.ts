import fs from "node:fs";
import path from "node:path";
import type { TaskDefinition, AppSettings } from "@openstrm/shared";
import type { AccountInfo } from "../cloud-115/client.js";
import { exportDirParse, fsDirGetId } from "../cloud-115/client.js";
import { writeStrm } from "../download/rate-limited.js";
import { buildTree, collectFilesAndTopEmptyDirs, findExportedDir } from "../task/tree.js";
import { resolveInDataDir } from "../../paths.js";
import { RemoteDirNotFoundError } from "../drive/types.js";
import { toStrmPath } from "./naming.js";

export { RemoteDirNotFoundError };

export interface SelectedItem {
  name: string;
  isDir: boolean;
  /** 目录已知 id 时直接用，省掉按路径解析那一步（云下载完成时 115 已经把产物 id 给了） */
  cid?: string | number;
}

export interface GenerateResult {
  generatedCount: number;
  skippedCount: number;
}

async function writeOneStrm(
  remotePath: string,
  localPath: string,
  task: TaskDefinition,
): Promise<"generated" | "skipped"> {
  if (fs.existsSync(toStrmPath(localPath))) return "skipped";
  await writeStrm(remotePath, localPath, {
    displayPath: remotePath,
    strmPrefix: task.strmPrefix,
    enablePathEncoding: task.enablePathEncoding,
  });
  return "generated";
}

function normalizeSubPath(sub?: string): string {
  return (sub || "").split("/").map((s) => s.trim()).filter(Boolean).join("/");
}

/**
 * 导出网盘目录 dirPath 的目录树，返回其中文件（和整棵没有文件的顶层空目录）相对 dirPath 的路径；
 * 调用方自己按扩展名过滤。目录已知 id 时传 cid，省掉按路径解析那一步。
 */
export async function exportDirFiles(params: {
  accountInfo: AccountInfo;
  dirPath: string;
  cid?: string | number;
}): Promise<string[]> {
  const { accountInfo, dirPath } = params;
  let folderId: number | string;
  if (params.cid != null && String(params.cid) !== "" && String(params.cid) !== "0") {
    folderId = params.cid;
  } else {
    const folderIdRes = (await fsDirGetId(dirPath, { accountInfo })) as { id?: number | string };
    // getid 对不存在的路径回 id=0；拿 0 去导出等于把整个网盘的目录树拉下来
    if (folderIdRes?.id == null || String(folderIdRes.id) === "0") throw new RemoteDirNotFoundError(dirPath);
    folderId = folderIdRes.id;
  }

  const raw = await exportDirParse({
    exportFileIds: folderId,
    targetPid: 0,
    layerLimit: 0,
    deleteAfter: true,
    timeoutMs: 300000,
    checkIntervalMs: 1000,
    accountInfo,
  });
  const tree = buildTree(raw);
  // 115 导出的树从上一级开始（导出 tv/Show 得到 tv → Show → …），把顶层当成目录本身会多套一层 Show/Show/…
  const dir = findExportedDir(tree, dirPath);
  if (!dir) {
    const tops = tree.filter((n) => n.name).map((n) => n.name).join("、");
    throw new Error(`导出的目录树里找不到 ${dirPath}（顶层：${tops || "空"}）`);
  }
  return collectFilesAndTopEmptyDirs(dir.children ?? []);
}

export async function generateStrmForSelected(params: {
  task: TaskDefinition;
  selectedItems: SelectedItem[];
  accountInfo: AccountInfo;
  settings: AppSettings;
  subPath?: string;
}): Promise<GenerateResult> {
  const { task, selectedItems, accountInfo, settings } = params;
  if (!task.targetPath) throw new Error("task.targetPath is not configured");

  const subPath = normalizeSubPath(params.subPath);
  const originRoot = subPath ? `${task.originPath}/${subPath}` : task.originPath;
  const strmExts = (settings.strmExtensions || []).map((e) => e.toLowerCase());
  const saveDir = resolveInDataDir(subPath ? path.join(task.targetPath, subPath) : task.targetPath);
  if (!saveDir) throw new Error(`targetPath 越出了数据目录: ${task.targetPath}`);
  fs.mkdirSync(saveDir, { recursive: true });

  let generatedCount = 0;
  let skippedCount = 0;

  for (const item of selectedItems) {
    if (!item.isDir) {
      const ext = path.extname(item.name).toLowerCase();
      if (strmExts.length > 0 && !strmExts.includes(ext)) continue;
      const remote = `${originRoot}/${item.name}`;
      const local = path.join(saveDir, item.name);
      const r = await writeOneStrm(remote, local, task);
      if (r === "generated") generatedCount++;
      else skippedCount++;
      continue;
    }

    let files: string[];
    try {
      files = await exportDirFiles({ accountInfo, dirPath: `${originRoot}/${item.name}`, cid: item.cid });
    } catch (err) {
      // 转存 / 云下载本身已经成功，只是这一步没成：让调用方的提示说清楚
      if (err instanceof Error) err.message = `${err.message}（115 上的文件不受影响，只是没有生成 strm）`;
      throw err;
    }

    for (const rel of files) {
      const ext = path.extname(rel).toLowerCase();
      if (strmExts.length > 0 && !strmExts.includes(ext)) continue;
      const remote = `${originRoot}/${item.name}/${rel}`;
      const local = path.join(saveDir, item.name, rel);
      const r = await writeOneStrm(remote, local, task);
      if (r === "generated") generatedCount++;
      else skippedCount++;
    }
  }

  return { generatedCount, skippedCount };
}

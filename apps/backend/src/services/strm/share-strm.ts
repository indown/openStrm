/**
 * 转存 / 云下载完成后，为选中的条目生成 strm：文件直接写，目录按网盘子树列出文件逐个写。
 * 已存在的 strm 跳过（转存是追加，不该覆盖用户改过的 strm）。
 */
import fs from "node:fs";
import path from "node:path";
import type { TaskDefinition, AppSettings } from "@openstrm/shared";
import type { DriveProvider } from "../drive/types.js";
import { writeStrm } from "../download/rate-limited.js";
import { resolveInDataDir } from "../../paths.js";
import { toStrmPath } from "./naming.js";

export interface SelectedItem {
  name: string;
  isDir: boolean;
  /** 目录已知网盘 id 时直接用，省掉按路径解析那一步（转存回执 / 云下载完成时网盘已经把产物 id 给了） */
  id?: string;
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

export async function generateStrmForSelected(params: {
  task: TaskDefinition;
  provider: DriveProvider;
  selectedItems: SelectedItem[];
  settings: AppSettings;
  subPath?: string;
}): Promise<GenerateResult> {
  const { task, provider, selectedItems, settings } = params;
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
      files = await provider.listSubtree(`${originRoot}/${item.name}`, { id: item.id });
    } catch (err) {
      // 转存 / 云下载本身已经成功，只是这一步没成：让调用方的提示说清楚
      if (err instanceof Error) err.message = `${err.message}（网盘上的文件不受影响，只是没有生成 strm）`;
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

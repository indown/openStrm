import fs from "node:fs";
import path from "node:path";
import type { TaskDefinition, AppSettings } from "@openstrm/shared";
import type { AccountInfo } from "../cloud-115/client.js";
import { exportDirParse, fsDirGetId } from "../cloud-115/client.js";
import { writeStrm } from "../download/rate-limited.js";
import { buildTree, collectFilesAndTopEmptyDirs } from "../task/tree.js";
import { resolveInDataDir } from "../../paths.js";
import { toStrmPath } from "./naming.js";

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

    let folderId: number | string;
    if (item.cid != null && String(item.cid) !== "" && String(item.cid) !== "0") {
      folderId = item.cid;
    } else {
      const folderIdRes = (await fsDirGetId(`${originRoot}/${item.name}`, { accountInfo })) as { id?: number | string };
      // getid 对不存在的路径回 id=0；拿 0 去导出等于把整个网盘的目录树拉下来
      if (folderIdRes?.id == null || String(folderIdRes.id) === "0") {
        throw new Error(`Cannot resolve folder on drive: ${originRoot}/${item.name}`);
      }
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
    const files: string[] = [];
    for (const node of tree) {
      if (node.children?.length) files.push(...collectFilesAndTopEmptyDirs(node.children));
      else if (/\.[a-z0-9]+$/i.test(node.name)) files.push(node.name);
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

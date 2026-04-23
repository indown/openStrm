import fs from "node:fs";
import path from "node:path";
import { firstValueFrom } from "rxjs";
import type { TaskDefinition, AppSettings } from "@openstrm/shared";
import type { AccountInfo } from "../cloud-115/client.js";
import { exportDirParse, fsDirGetId } from "../cloud-115/client.js";
import { downloadOrCreateStrm } from "../download/rate-limited.js";
import { buildTree, collectFilesAndTopEmptyDirs } from "../task/tree.js";
import { DATA_DIR } from "../../paths.js";

export interface SelectedItem {
  name: string;
  isDir: boolean;
}

export interface GenerateResult {
  generatedCount: number;
  skippedCount: number;
}

function strmLocalPath(savePath: string): string {
  const ext = path.extname(savePath);
  return ext ? savePath.replace(new RegExp(`${ext.replace(/\./g, "\\.")}$`), ".strm") : `${savePath}.strm`;
}

async function writeOneStrm(
  remotePath: string,
  localPath: string,
  task: TaskDefinition,
): Promise<"generated" | "skipped"> {
  if (fs.existsSync(strmLocalPath(localPath))) return "skipped";
  await firstValueFrom(
    downloadOrCreateStrm(remotePath, localPath, {
      asStrm: true,
      displayPath: remotePath,
      strmPrefix: task.strmPrefix,
      enablePathEncoding: task.enablePathEncoding,
    }),
  );
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
  const saveDir = subPath
    ? path.resolve(DATA_DIR, task.targetPath, subPath)
    : path.resolve(DATA_DIR, task.targetPath);
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

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

    const folderIdRes = (await fsDirGetId(`${originRoot}/${item.name}`, { accountInfo })) as { id?: number | string };
    if (folderIdRes?.id == null) throw new Error(`Cannot resolve folder on drive: ${originRoot}/${item.name}`);

    const raw = await exportDirParse({
      exportFileIds: folderIdRes.id,
      targetPid: 0,
      layerLimit: 0,
      deleteAfter: true,
      timeoutMs: 300000,
      checkIntervalMs: 1000,
      accountInfo,
    });
    const tree = buildTree(raw as any);
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

/**
 * 网盘上改名 / 移动之后，本地 strm 目录跟着动：和网盘监控的 relocate 是同一套规则，
 * 但不等监控来（监控可能没开、夸克快照最短 5 分钟）。
 *
 *   - 本地有旧文件：改名 / 移动过去，strm 重写成新网盘路径；目录整棵挪，其下 strm 的前缀重写
 *   - 本地没有旧文件、新路径是 strm 类扩展名：直接按新路径写一个 strm
 *   - 其余（字幕没下载过之类）：不动
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { AppSettings, TaskDefinition } from "@openstrm/shared";
import { pathExists, removeEmptyParents } from "../../lib/fs.js";
import { writeStrm } from "../download/rate-limited.js";
import { localPathFor, matchTask, rewriteStrmPrefixUnder, strmUrlFor } from "../life/handlers.js";

export interface MirrorDeps {
  tasks: TaskDefinition[];
  settings: AppSettings;
}

export type MirrorOutcome = "moved" | "created" | "removed" | "none";

/**
 * 网盘上 oldPath → newPath（绝对路径）之后同步本地。
 * oldPathAlt：文件在网盘上经过的中间位置（整理先原地改名再挪走时的 `源目录/新名字`）——网盘监控可能抢在镜像前面
 * 把本地文件按中间名字改过了，按原名找不到时就按它找，别在新位置另写一份、把改了名的旧文件留在原地
 */
export async function mirrorRelocate(op: { oldPath: string; newPath: string; isDir: boolean; oldPathAlt?: string }, deps: MirrorDeps): Promise<MirrorOutcome> {
  const ctx = { tasks: deps.tasks, settings: deps.settings };
  let oldMatch = matchTask(ctx, op.oldPath);
  const newMatch = matchTask(ctx, op.newPath);
  const localOf = (m: NonNullable<typeof oldMatch>) => (op.isDir ? path.join(m.saveDir, m.relPath) : localPathFor(m, ctx, m.relPath));
  let from = oldMatch ? localOf(oldMatch) : null;
  if (op.oldPathAlt && !(from && (await pathExists(from)))) {
    const altMatch = matchTask(ctx, op.oldPathAlt);
    const alt = altMatch ? localOf(altMatch) : null;
    if (alt && (await pathExists(alt))) {
      from = alt;
      oldMatch = altMatch;
    }
  }
  const to = newMatch ? localOf(newMatch) : null;

  if (from && (await pathExists(from))) {
    if (!to || !newMatch) {
      await fsp.rm(from, { recursive: op.isDir, force: true });
      if (oldMatch) await removeEmptyParents(path.dirname(from), oldMatch.saveDir);
      return "removed";
    }
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    if (oldMatch) await removeEmptyParents(path.dirname(from), oldMatch.saveDir);
    if (!op.isDir && to.endsWith(".strm")) {
      await writeStrm(strmUrlFor(newMatch.task, newMatch.relPath), path.join(newMatch.saveDir, newMatch.relPath), {
        displayPath: newMatch.relPath,
        strmPrefix: newMatch.task.strmPrefix,
        enablePathEncoding: newMatch.task.enablePathEncoding,
      });
    } else if (op.isDir && oldMatch) {
      await rewriteStrmPrefixUnder(to, oldMatch.task, oldMatch.relPath, newMatch.task, newMatch.relPath);
    }
    return "moved";
  }
  if (!op.isDir && to && newMatch && to.endsWith(".strm")) {
    await writeStrm(strmUrlFor(newMatch.task, newMatch.relPath), path.join(newMatch.saveDir, newMatch.relPath), {
      displayPath: newMatch.relPath,
      strmPrefix: newMatch.task.strmPrefix,
      enablePathEncoding: newMatch.task.enablePathEncoding,
    });
    return "created";
  }
  return "none";
}

/** 网盘上删掉了空目录：本地同名目录空的话也删掉 */
export async function mirrorRmdir(dirPath: string, deps: MirrorDeps): Promise<boolean> {
  const match = matchTask({ tasks: deps.tasks }, dirPath);
  if (!match || !match.relPath) return false;
  const local = path.join(match.saveDir, match.relPath);
  try {
    const entries = await fsp.readdir(local);
    if (entries.length > 0) return false;
    await fsp.rmdir(local);
    await removeEmptyParents(path.dirname(local), match.saveDir);
    return true;
  } catch {
    return false;
  }
}

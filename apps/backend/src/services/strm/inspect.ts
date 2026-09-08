/**
 * 一个 strm 该长什么样、现在长什么样、能不能按任务配置重写。纯函数，不碰 fs 和网络；规则改动先过 inspect.test.ts。
 *
 * 期望内容从本地路径推算：三个写入方（全量任务、生活事件、分享转存）落盘时本地文件名都是网盘文件名换成 .strm，
 * 唯一丢掉的信息是原扩展名，从现有内容的最后一段取回来。内容本身只用来取扩展名和做校验，
 * 所以重写永远不会把已经编码过的尾巴再编码一次（`%20` → `%2520`）。
 */
import path from "node:path";
import type { StrmParseReason, TaskDefinition } from "@openstrm/shared";
import { decodeSegments, safeDecode, stripStrmExt, strmContent } from "./naming.js";

export interface StrmInspection {
  /** 网盘文件的扩展名（带点）；取不到为 null */
  ext: string | null;
  /** 应有的网盘路径（不带前缀、未编码）；算不出为空串 */
  expectedRemote: string;
  /** 应有的内容；算不出为空串 */
  expectedContent: string;
  /** 从现有内容解析出的网盘路径；解析不出为 null */
  actualRemote: string | null;
  matches: boolean;
  reason?: StrmParseReason;
  /** 能按任务当前配置重写：没有问题，或只是前缀对不上 */
  rewritable: boolean;
}

const EXT_RE = /^\.[a-z0-9]{1,10}$/i;

const lastSegment = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

function stemOf(name: string): string {
  const ext = path.posix.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

/** 去掉前缀（原样或 encodeURI 过的）和紧跟的 `/`；对不上返回 null */
function stripPrefix(content: string, prefix: string): string | null {
  for (const p of new Set([prefix, encodeURI(prefix)])) {
    const head = `${p}/`;
    if (content.startsWith(head)) return content.slice(head.length);
  }
  return null;
}

export function inspectStrm(task: TaskDefinition, localRel: string, content: string): StrmInspection {
  const prefix = task.strmPrefix ?? "";
  const encode = !!task.enablePathEncoding;
  const localStem = stripStrmExt(lastSegment(localRel));
  const bad = (reason: StrmParseReason, ext: string | null = null): StrmInspection => ({
    ext,
    expectedRemote: "",
    expectedContent: "",
    actualRemote: null,
    matches: false,
    reason,
    rewritable: false,
  });

  const trimmed = content.trim();
  if (!trimmed) return bad("empty");

  const last = lastSegment(trimmed);
  const lastDecoded = safeDecode(last);
  const ext = path.posix.extname(lastDecoded);
  if (!EXT_RE.test(ext) || ext.toLowerCase() === ".strm") return bad("no-ext");

  const expectedRemote = `${task.originPath}/${stripStrmExt(localRel)}${ext}`;
  const expectedContent = strmContent(prefix, expectedRemote, encode);
  const matches = content === expectedContent;

  // 内容里的文件名（原样或解码后）必须就是本地文件名：对不上说明是手改过或指错了文件，不能替用户做主
  const rawMatch = stemOf(last) === localStem;
  if (!rawMatch && stemOf(lastDecoded) !== localStem) {
    return { ext, expectedRemote, expectedContent, actualRemote: null, matches, reason: "name-mismatch", rewritable: false };
  }

  const rest = stripPrefix(trimmed, prefix);
  if (rest === null) {
    return { ext, expectedRemote, expectedContent, actualRemote: null, matches, reason: "prefix-mismatch", rewritable: true };
  }
  // 原样就对得上文件名的（没开编码，或文件名里本来就带 `%`）不解码，免得把字面的 `%25` 还原掉
  const actualRemote = rawMatch ? rest : decodeSegments(rest);
  return { ext, expectedRemote, expectedContent, actualRemote, matches, rewritable: true };
}

/** 内容命中某个任务的 `${strmPrefix}/${originPath}/`（原样或解码后） */
function belongsTo(content: string, task: TaskDefinition): boolean {
  const head = `${task.strmPrefix ?? ""}/${task.originPath}/`;
  return content.startsWith(head) || decodeSegments(content).startsWith(head);
}

/**
 * 同一个输出目录被几个任务共用时，一个 strm 归谁：命中兄弟任务的前缀 + originPath 且不命中本任务的，是别人的。
 * 只做排除不做认领：本任务改了 originPath 之后，旧内容谁也不命中，仍归本任务（要重写的正是它们）。
 */
export function isForeignStrm(content: string, task: TaskDefinition, siblings: TaskDefinition[]): boolean {
  const c = content.trim();
  if (belongsTo(c, task)) return false;
  return siblings.some((s) => s.id !== task.id && belongsTo(c, s));
}

/** 文件名里第一个 SxxEyy；`S01E01E02` 只取第一集 */
export function episodeKey(name: string): { season: number; episode: number } | null {
  const m = /S(\d{1,3})E(\d{1,4})/i.exec(name);
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
}

const SEASON_DIR_RE = /^(?:(?:season|s)\s*\d+|specials?|第.+季)$/i;

/** 一集所属的"剧"目录：父目录；父目录是 Season 1 / S01 / 第2季 / Specials 这种季目录就再往上一层 */
export function showDirOf(rel: string): string {
  const parent = path.posix.dirname(rel);
  if (parent === "." || parent === "") return "";
  if (SEASON_DIR_RE.test(path.posix.basename(parent))) {
    const grand = path.posix.dirname(parent);
    return grand === "." ? "" : grand;
  }
  return parent;
}

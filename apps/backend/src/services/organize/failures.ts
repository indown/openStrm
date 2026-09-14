/**
 * 整理执行 / 撤销时的失败分类：一个失败落到哪一类，决定用户下一步该做什么——重试、重新预览、放弃、还是只补本地。
 * 三家网盘的错误类只在这里 instanceof，run.ts 不认具体网盘。
 *
 *   transient  网络 / 超时 / 网盘 5xx / 认不出的 → 执行中自动重试一次，仍失败留给「重试」（未知错误归这里最安全：改名 / 移动多试一次最多再失败一次）
 *   blocked    风控 / 登录失效（provider.classifyError）→ 整轮停，修好账号后「重试」
 *   stale      预览之后网盘变了：源文件不在了、目录没了、目标位置被占 → 「重新预览」或「放弃」，默认不重试
 *   rejected   网盘明确不接受这个名字 / 目标：同名、非法字符、过长 → 「放弃」，改模板 / 识别词后重新预览
 *   mirror     网盘那步成功、本地 strm 没跟上（不在这里分类，run.ts 直接记）→ 「重试」只补本地
 */
import type { OrganizeItem } from "@openstrm/shared";
import { PermanentError } from "../../lib/errors.js";
import { Cloud115Error } from "../cloud-115/client.js";
import { RemoteDirNotFoundError, type DriveProvider } from "../drive/types.js";
import { OpenlistError } from "../openlist/client.js";
import { QuarkError } from "../quark/client.js";
import { QuarkTaskError } from "../quark/share.js";

import { FAILURE_LABEL, type FailureKind } from "./failure-kinds.js";

export { FAILURE_LABEL, type FailureKind };

/** 预览之后网盘变了：源文件不在了、目录没了、目标位置被占。重试没用，要重新预览或放弃 */
export class StaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleError";
  }
}

/** 已经分好类的失败：attempt() 抛给调用方的就是它，cause 是原始错误 */
export class OrganizeFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly cause: unknown,
  ) {
    super(messageOf(cause));
    this.name = "OrganizeFailure";
  }
}

export const messageOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : String(err));

const STALE_RE = /不存在|已删除|已被删除|找不到|not exist|not found|no such|missing/i;
const REJECTED_RE = /已存在|同名|重名|重复|\bexists\b|非法|不合法|不能包含|过长|太长|超过.*字符|invalid|illegal|too long/i;

export function classifyFailure(provider: Pick<DriveProvider, "classifyError">, err: unknown): FailureKind {
  if (err instanceof OrganizeFailure) return err.kind;
  const issue = provider.classifyError(err);
  if (issue === "blocked" || issue === "auth") return "blocked";
  if (err instanceof StaleError || err instanceof RemoteDirNotFoundError) return "stale";
  const msg = messageOf(err);
  if (err instanceof OpenlistError) {
    // transport = 连不上 / HTTP 层失败；其余是 OpenList 明确答复的失败，按文案分
    if (err.transport) return "transient";
    if (STALE_RE.test(msg)) return "stale";
    if (REJECTED_RE.test(msg)) return "rejected";
    return "transient";
  }
  if (err instanceof Cloud115Error) {
    if (err.status === 404) return "stale";
    if (err.status >= 500) return "transient";
  }
  if (err instanceof QuarkTaskError) return "transient";
  if (err instanceof QuarkError && (err.status ?? 0) >= 500) return "transient";
  // 其余 PermanentError 是「网盘明确说没有」
  if (err instanceof PermanentError) return "stale";
  if (STALE_RE.test(msg)) return "stale";
  if (REJECTED_RE.test(msg)) return "rejected";
  return "transient";
}

/**
 * 再执行时这一项要不要做：
 *   - 没做的（pending）做；失败的只重试 transient / blocked / 没分类的，stale / rejected 要用户点名（explicit）才重试
 *   - done 但本地镜像失败的重做镜像（不碰网盘）
 *   - 删空目录便宜又幂等：pending / failed / 「目录不是空的」跳过的都再来一遍；目录已经不在了（stale）的不用
 */
export function retryableItem(it: OrganizeItem, explicit = false): boolean {
  switch (it.action) {
    case "mkdir":
    case "rename":
    case "move":
      if (it.status === "pending") return true;
      if (it.status === "failed") return explicit || it.errorKind === "" || it.errorKind === "transient" || it.errorKind === "blocked";
      if (it.status === "done") return it.errorKind === "mirror";
      return false;
    case "rmdir":
      if (it.status === "pending" || it.status === "failed") return true;
      return it.status === "skipped" && it.errorKind !== "stale";
    default:
      return false;
  }
}

/**
 * 这一项有没有改动过文件、撤销才有意义：
 *   - done 的改名 / 移动项（含上次撤销在网盘那步失败的、挪回来了还没改回原名的）
 *   - 执行时原地改了名还没挪走的（pending / failed 带 curPath）
 *   - 已退回但本地镜像失败的（只差补本地）
 * 只建了目录 / 删了空目录不算改动文件
 */
export function revertPendingItem(it: OrganizeItem): boolean {
  if (it.status === "done") return it.action === "rename" || it.action === "move";
  if (it.status === "reverted") return it.errorKind === "mirror";
  return it.curPath !== "";
}

/**
 * 撤销时还有事要做的项：改动过文件的，加上做过的建目录 / 删空目录（建的目录空了要删掉）。
 * includeSkippedDirs：撤销循环把上一轮「目录不是空的」留下的自建目录也再看一眼（文件退回后可能空了）；
 * 判断「还有没有事」时不算它们，不然永远退不完
 */
export function revertWorkItem(it: OrganizeItem, includeSkippedDirs = false): boolean {
  if (it.status === "done") return it.action === "rename" || it.action === "move" || it.action === "mkdir" || it.action === "rmdir";
  if (it.status === "skipped") return includeSkippedDirs && it.action === "mkdir";
  return revertPendingItem(it);
}

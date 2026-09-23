/**
 * 工具结果的公共部分：错误 → 给模型看的失败结果、参数摘要（审计用）、时间、「在 OpenStrm 里打开」的链接。
 */
import { readAppSetting } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { messageOf } from "../../lib/errors.js";
import { accountIssueOf, driveErrorToHttp } from "../drive/errors.js";
import { findShareLink, parseShareRef } from "../drive/registry.js";
import { ShareGoneError } from "../drive/types.js";
import { ToolError } from "./define.js";

export interface ToolFailure {
  error: string;
  code: string;
  hint?: string;
  [key: string]: unknown;
}

const ACCOUNT_HINT = "网盘账号登录失效或被风控了，只能由用户在 OpenStrm 管理界面的「账户」页处理，不要反复重试。";
const RECEIVED_HINT = "条目已经转存进网盘了，只是本地 strm 没生成好。别再调 share_save（网盘里会再多一份）；排除问题后用 sync_start 同步这个任务补上 strm。";

/** 账号问题（登录失效 / 风控）的提示：只能用户去处理，别让模型反复重试 */
export function accountHint(issue: unknown): string | undefined {
  return issue === "auth" || issue === "blocked" ? ACCOUNT_HINT : undefined;
}

/**
 * 错误 → 给模型看的失败结果。人话 message + 机器可读 code + 下一步 hint。
 * 路由和服务会把网盘错误包成 HttpError，原始错误挂在 cause 上：账号问题、分享失效按它认
 */
export function toFailure(err: unknown): ToolFailure {
  if (err instanceof ToolError) {
    return { error: err.message, code: err.code, ...(err.hint ? { hint: err.hint } : {}), ...err.extra };
  }
  const http = err instanceof HttpError ? err : driveErrorToHttp(err, messageOf(err) || "操作失败");
  const cause = http.cause;
  if (cause instanceof ShareGoneError) {
    return { error: `分享不可用：${cause.message}`, code: "SHARE_GONE", hint: "分享已失效、被取消或提取码不对，换一个链接。" };
  }
  const code = typeof http.extra.code === "string" ? http.extra.code : `HTTP_${http.status}`;
  const account = cause === undefined ? undefined : accountHint(accountIssueOf(undefined, cause));
  // 转存成功、后面生成 strm 失败：最要紧的是别再转存一遍
  const received = http.extra.received === true;
  const hint = received ? [RECEIVED_HINT, account].filter(Boolean).join("") : (account ?? hintForStatus(http.status));
  return { error: http.message, code, ...(hint ? { hint } : {}), ...(received ? { received: true } : {}) };
}

function hintForStatus(status: number): string | undefined {
  if (status === 404) return "名字或路径可能不对：用 tasks_list 看任务，用 drive_browse 看网盘目录。";
  if (status === 429) return "请求太频繁，等一会儿再试。";
  if (status === 499) return "已取消。";
  return undefined;
}

const MAX_ARGS_SUMMARY = 300;

/**
 * 审计里的参数摘要：提取码、令牌抹掉，太长截断。
 * 提取码按解析出来的值抹：分享链接的写法很多（code-提取码、?password=、「提取码：」换行再写），认得出链接的地方就认得出提取码
 */
export function summarizeArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(redactValue(args ?? {}));
  } catch {
    text = redactText(String(args), false);
  }
  return text.length > MAX_ARGS_SUMMARY ? `${text.slice(0, MAX_ARGS_SUMMARY)}…` : text;
}

/** 装着分享链接的参数：工具的 link、REST /api/share 的 url、追更的 shareUrl */
const SHARE_LINK_KEYS = new Set(["link", "url", "shareUrl"]);
/** 整个值就是密码 / 提取码的参数：直接抹掉 */
const SECRET_KEYS = new Set(["receiveCode", "password", "pwd", "passcode", "currentPassword"]);

function redactValue(v: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEYS.has(key) && v !== undefined && v !== null && v !== "") return "***";
  if (typeof v === "string") return redactText(v, key !== undefined && SHARE_LINK_KEYS.has(key));
  if (Array.isArray(v)) return v.map((x) => redactValue(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x, k)]));
  return v;
}

/**
 * 分享链接只按参数名认：115 的短写法「码-提取码」很宽，别的参数（任务名「tv-show」）也按它解析会被误抹。
 * 其它参数只抹固定写法：?password= 这类查询参数、「提取码」后面跟的、URL 里的账号密码、令牌
 */
function redactText(text: string, isShareLink: boolean): string {
  if (isShareLink) {
    const password = (findShareLink(text) ?? parseShareRef(text.trim()))?.password;
    if (password) text = text.split(password).join("***");
  }
  return text
    .replace(/([?&](?:password|pwd|passcode)=)[^&"\s]*/gi, "$1***")
    .replace(/(提取码[:：]?\s*)[a-z0-9]{4,8}/gi, "$1***")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@"]+:[^/\s@"]+@/gi, "$1***@")
    .replace(/ost[a-z]_[A-Za-z0-9_-]{8,}/g, "***");
}

/**
 * 分享链接去掉提取码，给模型看的时候用：它用不着，也不该到处传。认出是哪家的分享就按分享码重拼一个干净的链接
 * （库里存的可能是「链接：… 提取码：…」整段文字、115 的「码-提取码」写法）；认不出就按固定写法抹
 */
export function shareLinkWithoutPassword(text: string): string {
  const ref = findShareLink(text) ?? parseShareRef(text.trim());
  if (ref?.kind === "quark") return `https://pan.quark.cn/s/${ref.code}`;
  if (ref?.kind === "115") return `https://115.com/s/${ref.code}`;
  return redactText(text, true);
}

/** 本机时区的「年-月-日 时:分:秒」：给人看、给模型复述都比毫秒数合适 */
export function fmtTime(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 管理界面从哪打开：填了管理界面地址用它；没填、但公网地址这个域名也用来打开管理界面（共用域名）就用公网地址 */
export function uiBase(): string | undefined {
  const agent = readAppSetting("agent");
  const explicit = agent?.uiBaseUrl?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  if (agent?.publicServesUi === true && agent.publicBaseUrl) {
    try {
      return new URL(agent.publicBaseUrl).origin;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * 「在 OpenStrm 里打开」：知道管理界面地址才给（见 uiBase）。
 * 写操作最后一步交给人时用：只读的客户端做不了，点链接就是预填好的转存框、日志页这些。
 */
export function uiLink(pathAndQuery: string): string | undefined {
  const base = uiBase();
  if (!base) return undefined;
  return `${base}${pathAndQuery.startsWith("/") ? "" : "/"}${pathAndQuery}`;
}

/** 结果里的 openInUi 字段：没填管理界面地址就是空对象，直接展开进结果 */
export function openInUi(pathAndQuery: string): { openInUi?: string } {
  const link = uiLink(pathAndQuery);
  return link ? { openInUi: link } : {};
}

/** 截断长列表：给 total，截断时告诉模型怎么缩小范围 */
export function page<T>(items: T[], limit: number, narrowHint: string): { items: T[]; total: number; truncated?: string } {
  if (items.length <= limit) return { items, total: items.length };
  return { items: items.slice(0, limit), total: items.length, truncated: `只列了前 ${limit} 条。${narrowHint}` };
}

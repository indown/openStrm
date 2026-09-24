/**
 * PanSou 的分组结果 → OpenStrm 的 ResourceHit：认链接、去重、清标题、按账号标出能做什么。
 *
 * 除了 accountCaps（读账号），这里都是纯函数。实测到的几件事都在这里处理：
 *   - 同一个 115 分享会以 115.com / anxia.com / 115cdn.com 三个域名各出现一次 → 按分享码去重，链接统一成 115.com；
 *   - 115 的提取码已经在链接里、password 字段又给一遍；夸克的提取码只在 password 字段 → 统一拼进链接；
 *   - 没日期的给 0001-01-01 → 当没有；
 *   - 标题常带 TG 消息里的「名称：」前缀。
 */
import type { AccountInfo, ResourceAction, ResourceHit, ResourceKind, ResourceSearchResult, ResourceSource } from "@openstrm/shared";
import { listAccounts } from "../../db/repositories/accounts.js";
import { parseShareRef, providerFor, withPassword } from "../drive/registry.js";
import type { DriveKind } from "../drive/types.js";
import type { PansouLink } from "./client.js";
import { titleTags } from "./tags.js";

/** 结果里各类的先后：能转存的两家在前，能云下载的其次，只能复制的最后 */
export const KIND_ORDER: readonly ResourceKind[] = ["115", "quark", "magnet", "ed2k", "other"];

/** PanSou 的网盘类型 → 中文名。网页、智能体、Telegram 都用 ResourceHit.panLabel，名字表只在这一份 */
const PAN_TYPE_LABEL: Record<string, string> = {
  "115": "115",
  quark: "夸克",
  magnet: "磁力",
  ed2k: "电驴",
  baidu: "百度",
  aliyun: "阿里",
  uc: "UC",
  tianyi: "天翼",
  xunlei: "迅雷",
  "123": "123",
  pikpak: "PikPak",
  mobile: "移动",
  guangya: "光鸭",
  others: "其他",
};

export function panTypeLabel(panType: string): string {
  return PAN_TYPE_LABEL[panType.toLowerCase()] ?? panType;
}

/** 这个实例的账号能接住哪些：有分享能力的网盘、有没有 115（云下载） */
export interface AccountCaps {
  share: ReadonlySet<DriveKind>;
  offline: boolean;
}

export function accountCaps(accounts: AccountInfo[] = listAccounts()): AccountCaps {
  const share = new Set<DriveKind>();
  for (const a of accounts) {
    const p = providerFor(a);
    if (p.share) share.add(p.kind);
  }
  return { share, offline: accounts.some((a) => a.accountType === "115") };
}

function actionFor(kind: ResourceKind, caps: AccountCaps): ResourceAction {
  if (kind === "115" || kind === "quark") return caps.share.has(kind) ? "share" : null;
  if (kind === "magnet" || kind === "ed2k") return caps.offline ? "offline" : null;
  return null;
}

const TITLE_MAX = 300;

/**
 * 标题：去掉零宽 / 控制字符和「名称：」「片名：」这类前缀（前面常带个表情，「📚名称：」），压空白；过长的截断。
 * 只在后面跟着冒号时才去，「🎬《沙丘2》」这种原样留着
 */
export function cleanTitle(raw: string): string {
  const t = raw
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/^[\s\p{Extended_Pictographic}\p{Mn}]*(?:资源|影片|电影|剧集|影视)?(?:名称|标题|片名|剧名)\s*[:：]\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** PanSou 的时间 → ISO；解析不了的、0001 年这类占位的当没有 */
export function cleanDate(raw: string): string | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return d.getUTCFullYear() < 2000 ? undefined : d.toISOString();
}

/** `tg:频道名` / `plugin:插件名` / `unknown` */
export function parseSource(raw: string): ResourceSource {
  const s = raw.trim();
  const m = /^(tg|plugin):(.*)$/i.exec(s);
  if (!m) return { type: "unknown", name: s.toLowerCase() === "unknown" ? "" : s };
  return { type: m[1].toLowerCase() as "tg" | "plugin", name: m[2].trim() };
}

export interface NormalLink {
  kind: ResourceKind;
  key: string;
  url: string;
  password?: string;
}

const BTIH = /[?&]xt=urn:btih:([a-z0-9]{32,40})/i;
const ED2K_HASH = /^ed2k:\/\/\|file\|[^|]*\|\d+\|([a-f0-9]{32})\|/i;

/**
 * 一条链接认成哪类、去重键是什么、给出去的链接长什么样。
 * 115 / 夸克要过 OpenStrm 自己的分享链接解析：认不出的（PanSou 说是 115、格式却对不上）降成 other，
 * 宁可少一个按钮，也别点了才报「不认识这个分享链接」
 */
export function normalizeLink(panType: string, url: string, password: string): NormalLink {
  const type = panType.toLowerCase();
  const raw = url.trim();
  if ((type === "115" || type === "quark") && /^https?:\/\//i.test(raw)) {
    const parsed = parseShareRef(raw);
    if (parsed && parsed.kind === type) {
      const kind = type as "115" | "quark";
      const ref = withPassword(parsed, password.trim());
      // 115 的链接统一成 115.com：三个域名是同一个分享
      const link = kind === "115" ? `https://115.com/s/${ref.code}${ref.password ? `?password=${ref.password}` : ""}` : ref.url;
      return { kind, key: `${kind}:${ref.code}`, url: link, ...(ref.password ? { password: ref.password } : {}) };
    }
  }
  if (type === "magnet") {
    const m = BTIH.exec(raw);
    if (m) {
      // tracker 和文件名都去掉：115 按 info hash 下载用不上它们，还动辄上千字。十六进制的统一小写，base32 的原样
      const hash = m[1].length === 40 ? m[1].toLowerCase() : m[1];
      return { kind: "magnet", key: `magnet:${hash.toLowerCase()}`, url: `magnet:?xt=urn:btih:${hash}` };
    }
  }
  if (type === "ed2k" && /^ed2k:\/\//i.test(raw)) {
    const m = ED2K_HASH.exec(raw);
    return { kind: "ed2k", key: `ed2k:${(m?.[1] ?? raw).toLowerCase()}`, url: raw };
  }
  return { kind: "other", key: `other:${raw}`, url: raw, ...(password.trim() ? { password: password.trim() } : {}) };
}

/**
 * 从作品名、目录名、追更名里拿搜索关键词：追更名「标题 / 子目录」只要标题；去掉【】[]{} 里的标签
 * （【完结】、[4K]、{tmdb-123}）和括号里的年份，这些塞进关键词只会让 PanSou 搜得更少。去完是空的就用原样。
 * 前端 lib/resource.ts 的 keywordFromName 同一个口径
 */
export function keywordFromName(name: string): string {
  const head = name.split(" / ")[0].trim();
  const cleaned = head
    .replace(/【[^】]*】|\[[^\]]*\]|\{[^}]*\}/g, " ")
    .replace(/[(（]\s*(?:19|20)\d{2}\s*[)）]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || head).slice(0, 100);
}

/**
 * 分组结果 → 去重后的列表：按 KIND_ORDER 排，同一类里保持 PanSou 的顺序。
 * 重复的留排在前面的那条，时间取两条里较新的
 */
export function normalizeResults(keyword: string, byType: Record<string, PansouLink[]>, caps: AccountCaps): ResourceSearchResult {
  const hits = new Map<string, ResourceHit>();
  for (const [panType, links] of Object.entries(byType)) {
    for (const link of links) {
      const n = normalizeLink(panType, link.url, link.password);
      const publishedAt = cleanDate(link.datetime);
      const prev = hits.get(n.key);
      if (prev) {
        if (publishedAt && (!prev.publishedAt || publishedAt > prev.publishedAt)) prev.publishedAt = publishedAt;
        continue;
      }
      const title = cleanTitle(link.note);
      const tags = titleTags(title);
      hits.set(n.key, {
        key: n.key,
        kind: n.kind,
        panType: panType.toLowerCase(),
        panLabel: panTypeLabel(panType),
        url: n.url,
        ...(n.password ? { password: n.password } : {}),
        title,
        ...(publishedAt ? { publishedAt } : {}),
        source: parseSource(link.source),
        action: actionFor(n.kind, caps),
        ...(tags.length ? { tags } : {}),
      });
    }
  }
  // 稳定排序：同一类里的先后就是插进 Map 的先后，也就是 PanSou 的顺序
  const items = [...hits.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const counts: ResourceSearchResult["counts"] = {};
  for (const h of items) counts[h.kind] = (counts[h.kind] ?? 0) + 1;
  return { keyword, items, counts };
}

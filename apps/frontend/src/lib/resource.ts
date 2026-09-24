/**
 * 资源搜索页用的小工具：类型标签、来源和时间的写法、最近搜索（只存在这个浏览器里）。
 */
import type { ResourceKind, ResourceLinkState, ResourceSource } from "@openstrm/shared";

/** tab 的顺序：能转存的在前，能云下载的其次，只能复制的最后 */
export const KIND_TABS: ResourceKind[] = ["115", "quark", "magnet", "ed2k", "other"];

export const KIND_LABEL: Record<ResourceKind, string> = {
  "115": "115",
  quark: "夸克",
  magnet: "磁力",
  ed2k: "电驴",
  other: "其他网盘",
};

export function sourceLabel(source: ResourceSource): string {
  if (source.type === "tg") return source.name ? `TG · ${source.name}` : "TG";
  if (source.type === "plugin") return source.name ? `插件 · ${source.name}` : "插件";
  return source.name;
}

/** 近的写「3 天前」，一个月以上写日期；没有时间就是空串 */
export function fmtAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diff = now - ms;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 资源搜索页的地址：别处的「找资源」「搜替代资源」都链到这里，关键词预填好 */
export function searchHref(keyword: string): string {
  return `/search?${new URLSearchParams({ q: keyword })}`;
}

/** 季目录：拿作品名搜的时候跳过它，用上一级 */
const SEASON_DIR = /^(?:season\s*\d+|s\d{1,2}|specials?|第[一二三四五六七八九十百零\d]+季)$/i;

/**
 * 从作品名、目录名、追更名里拿搜索关键词：追更名「标题 / 子目录」只要标题；去掉【】[]{} 里的标签
 * （【完结】、[4K]、{tmdb-123}）和括号里的年份。去完是空的就用原样。
 * 和后端 services/pansou/normalize.ts 的 keywordFromName 同一个口径（Telegram 的「搜替代资源」用那份）
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

/** 目录路径拿关键词：末尾的季目录（Season 1、S01、第二季）跳过，用作品那一级 */
export function keywordFromPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  let i = parts.length - 1;
  while (i > 0 && SEASON_DIR.test(parts[i].trim())) i--;
  return i >= 0 ? keywordFromName(parts[i]) : "";
}

/* ------------------------------- 标签和筛选 ------------------------------- */

/**
 * 筛选按钮能挑的标签（后端 services/pansou/tags.ts 认出来的那些里，拿来筛最有用的几个），按这个顺序摆。
 * 分辨率之间是「或」（一个标题一般只写一种），其余之间是「且」
 */
export const TAG_FILTERS = ["4K", "1080p", "720p", "HDR", "杜比视界", "原盘", "REMUX", "WEB", "中字", "国语", "完结", "合集"] as const;
const RESOLUTIONS: ReadonlySet<string> = new Set(["4K", "1080p", "720p"]);
/** 选了 TMDB 候选时多出来的那个按钮：只看标题里带这个年份的 */
export const YEAR_FILTER = "year";

/** 这一条过不过得了筛选；year 是选了 TMDB 候选时的年份 */
export function passesTagFilters(hit: { title: string; tags?: string[] }, selected: ReadonlySet<string>, year: string | null): boolean {
  if (selected.size === 0) return true;
  const tags = new Set(hit.tags ?? []);
  const resolutions = [...selected].filter((t) => RESOLUTIONS.has(t));
  if (resolutions.length > 0 && !resolutions.some((t) => tags.has(t))) return false;
  for (const t of selected) {
    if (RESOLUTIONS.has(t)) continue;
    // 没有年份（取消了 TMDB 候选）时这个按钮不生效
    if (t === YEAR_FILTER) {
      if (year && !hit.title.includes(year)) return false;
    } else if (!tags.has(t)) return false;
  }
  return true;
}

/**
 * 结果行上显示的标签，按这个先后：正在筛的、分辨率、HDR / 杜比视界、片源、季集和合集、体积，最后才是音轨、字幕这些。
 * 行上位置有限（只摆前几个），挑片最看的放前面；正在筛的放最前，一眼看得出它为什么留下。
 * 有「全 N 集」时不再重复「完结」，除非正在按「完结」筛
 */
export function displayTags(tags: readonly string[] | undefined, active: ReadonlySet<string> = new Set()): string[] {
  const list = (tags ?? []).filter((t) => t !== "完结" || active.has("完结") || !(tags ?? []).some((x) => x.startsWith("全 ")));
  const rank = (t: string): number => {
    if (active.has(t)) return 0;
    if (RESOLUTIONS.has(t)) return 1;
    if (t === "HDR" || t === "杜比视界") return 2;
    if (["原盘", "REMUX", "WEB", "蓝光", "枪版"].includes(t)) return 3;
    if (/季$|集$|^合集$|^完结$/.test(t)) return 4;
    if (/^\d+(?:\.\d+)?[MGT]$/.test(t)) return 5;
    return 6;
  };
  // 排序是稳定的：同一档里保持后端给的先后
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/** 有效性圆点的颜色和说明。unsupported 当没查（这家不支持检测，不画点） */
export const LINK_STATE: Record<ResourceLinkState | "checking", { dot: string; label: string }> = {
  checking: { dot: "bg-info animate-pulse", label: "正在检测" },
  ok: { dot: "bg-success", label: "链接有效" },
  bad: { dot: "bg-destructive", label: "链接已失效" },
  locked: { dot: "bg-warning", label: "要提取码，或者提取码不对" },
  uncertain: { dot: "bg-warning", label: "检测不出来" },
  unsupported: { dot: "bg-muted-foreground/40", label: "这家网盘不支持检测" },
};

/* ------------------------------- 最近搜索 ------------------------------- */

const RECENT_KEY = "openstrm.resource.recent";
const RECENT_MAX = 10;

/** 读不到（隐私模式、存储被禁）就当没有：只是个人便利，不能挡住页面 */
export function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** 放到最前面；同一个词（不分大小写）只留一个 */
export function rememberRecent(keyword: string): string[] {
  const k = keyword.trim();
  const next = [k, ...loadRecent().filter((x) => x.toLowerCase() !== k.toLowerCase())].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // 存不下就算了
  }
  return next;
}

export function clearRecent(): void {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // 同上
  }
}

/**
 * 资源搜索页用的小工具：类型标签、来源和时间的写法、最近搜索（只存在这个浏览器里）。
 */
import type { ResourceKind, ResourceLinkState, ResourceSource } from "@openstrm/shared";
import { inputKindOf } from "./share";

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

/**
 * 在资源搜索页上从 ⌘K 搜的词交给页面自己处理，和在它的搜索框里按回车一样：同一个词重搜（地址不变，页面跟着地址搜的那一步不会跑）、
 * 选着的 TMDB 候选和外文原名都留着。页面接了返回 true；没接（还没加载出来）返回 false，由调用方自己换地址
 */
export const RESOURCE_SEARCH_EVENT = "openstrm:resource-search";
export function requestResourceSearch(keyword: string): boolean {
  if (typeof window === "undefined") return false;
  return !window.dispatchEvent(new CustomEvent<string>(RESOURCE_SEARCH_EVENT, { detail: keyword, cancelable: true }));
}

/**
 * 季目录、特别篇目录：Season 1、Season.01、S01、S.01、Series 2、第二季、第两季、第二部、Specials、SP、OVA、番外、特别篇。
 * 拿作品名搜的时候跳过它们，用上一级。和后端 services/organize/parse-name.ts 的 seasonDirNumber 认的一样（Extras 不算）
 */
const SEASON_DIR =
  /^(?:(?:season|s|series)[\s._-]*\d{1,2}|第(?:\d{1,2}|[一二两三四五六七八九十]+)[季部]|specials?|sp|ova|oad|特别篇|特別篇|番外篇?|season[\s._-]*0+|s0+)$/i;
/**
 * 看不见的字符（零宽空格、BOM、软连字符、方向控制符这类）：网盘上的名字里常夹着，判断季目录前去掉。
 * 后端 lib/text.ts 的 stripInvisible 按 Unicode 的 Default_Ignorable_Code_Point 去，这里写成它在基本平面里的那些，
 * 不用 \p{…}：老一点的浏览器不认这种写法，整个脚本会加载失败
 */
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8]/g;

function isSeasonDir(name: string): boolean {
  return SEASON_DIR.test(name.replace(INVISIBLE, "").trim());
}

/** 路径拆成段、去掉末尾的季目录；全是季目录就是空的 */
function withoutSeasonDirs(path: string): { parts: string[]; popped: boolean } {
  const parts = path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  let popped = false;
  while (parts.length > 0 && isSeasonDir(parts[parts.length - 1])) {
    parts.pop();
    popped = true;
  }
  return { parts, popped };
}

/**
 * 从作品名、目录名、追更名里拿搜索关键词，拿不出片名是空串（调用方据此不给「找资源」）：
 *   - 链接、分享码不是片名：没起名字的追更，名字就是分享码；
 *   - 追更名「标题 / 子目录」只要标题；
 *   - 网盘路径（没起名字的追更拿盯着的目录当名字）去掉末尾的季目录、用作品那一级。目录名里不会有 /，
 *     所以既没有季目录可去、又不是 / 开头的原样留着：「Fate/Zero」这种片名不能拆；
 *   - 去掉【】[]{} 里的标签（【完结】、[4K]、{tmdb-123}）和括号里的年份，去完是空的就用原样。
 * 和后端 services/pansou/normalize.ts 的 keywordFromName 同一个口径（Telegram 的「搜替代资源」用那份）
 */
export function keywordFromName(name: string): string {
  const t = name.trim();
  if (!t || t.includes("://") || inputKindOf(t) !== "search") return "";
  const head = t.split(" / ")[0].trim();
  const { parts, popped } = withoutSeasonDirs(head);
  if (parts.length === 0) return "";
  const title = popped || head.startsWith("/") ? parts[parts.length - 1] : head;
  const cleaned = title
    .replace(/【[^】]*】|\[[^\]]*\]|\{[^}]*\}/g, " ")
    .replace(/[(（]\s*(?:19|20)\d{2}\s*[)）]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || title).slice(0, 100);
}

/** 目录路径拿关键词：末尾的季目录（Season 1、S01、第二季）跳过，用作品那一级；全是季目录的拿不出，是空串 */
export function keywordFromPath(path: string): string {
  const { parts } = withoutSeasonDirs(path);
  return parts.length > 0 ? keywordFromName(parts[parts.length - 1]) : "";
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

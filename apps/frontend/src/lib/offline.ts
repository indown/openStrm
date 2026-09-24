/**
 * 贴进来的磁力 / 电驴 / 下载链接：认出来、拆成一行一条、交给云下载页打开添加框。
 * 顶栏、⌘K、资源搜索页的输入框都走这里。
 */

/** 云下载收的链接开头：磁力、电驴、http(s)、ftp（和后端 services/cloud-115/offline.ts 的 SUPPORTED_SCHEME 一样） */
const LINK_START = /magnet:\?|ed2k:\/\/|https?:\/\/|ftp:\/\//i;
const BARE_HASH = /^[0-9a-f]{40}$/i;

/** 输入框里的这段是不是要交给云下载的：带着磁力、电驴链接（「磁力：magnet:?…」这种一段话里带着的也算），或者整段就是一个 40 位 info hash */
export function looksLikeOfflineLink(text: string): boolean {
  const t = text.trim();
  return /magnet:\?|ed2k:\/\//i.test(t) || BARE_HASH.test(t);
}

/**
 * 挑出能交给云下载的链接，一条一行。单行输入框会把粘进来的换行吃成空格：在每条链接开头前的空白处断开
 * （电驴的文件名里本来就可能有空格，所以只在链接开头前断；和后端 normalizeOfflineUrls 的拆法一样）。
 * 断出来的每段只留链接开头之后的部分：「磁力：magnet:?…」前面那几个字、夹在中间的说明都不要
 */
export function splitOfflineLinks(text: string): string {
  return text
    .trim()
    .split(/\s+(?=magnet:\?|ed2k:\/\/|https?:\/\/|ftp:\/\/)/i)
    .map((part) => {
      const at = part.search(LINK_START);
      return at >= 0 ? part.slice(at) : BARE_HASH.test(part) ? part : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** 一次最多交给云下载多少条：后端（services/cloud-115/offline.ts 的 MAX_URLS_PER_ADD）同一个数 */
export const OFFLINE_ADD_MAX = 100;

const HANDOFF_KEY = "openstrm.offline.add";

/**
 * 去云下载页、打开添加框并预填这些链接的地址。链接放在 sessionStorage 里、地址只带个标记：
 * 一整季的电驴链接放进地址栏会超出请求头的长度上限。存不了（隐私模式、存储被禁）就直接放进地址
 */
export function offlineHandoffHref(text: string): string {
  try {
    sessionStorage.setItem(HANDOFF_KEY, text);
    return "/offline?paste=1";
  } catch {
    return `/offline?${new URLSearchParams({ add: text })}`;
  }
}

/** 云下载页取走交过来的链接，取一次就清掉；没有或读不了是空串 */
export function takeOfflineHandoff(): string {
  try {
    const text = sessionStorage.getItem(HANDOFF_KEY) ?? "";
    sessionStorage.removeItem(HANDOFF_KEY);
    return text;
  } catch {
    return "";
  }
}

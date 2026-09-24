/**
 * 贴进来的磁力 / 电驴 / 下载链接：认出来、拆成一行一条、交给云下载页打开添加框。
 * 顶栏、⌘K、资源搜索页的输入框都走这里。
 */

/* ---- 拆链接：和后端 apps/backend/src/services/cloud-115/offline.ts 里的同一段一字不差，改一边要改另一边 ---- */

/** 一条链接的开头：磁力 magnet:?，或者任意「xxx://」（thunder:// 这类收不了的也切出来，好告诉用户） */
const LINK_HEAD = /magnet:\?|[a-z][a-z0-9+.-]*:\/\//i;
/** 115 云下载收的：磁力、电驴、http(s)、ftp */
const TAKEN_HEAD = /^(?:magnet:\?|ed2k:\/\/|https?:\/\/|ftp:\/\/)/i;
/** 网址里常见的字符：前面挨着它们的「xxx://」是上一条链接的一部分（磁力 &tr=http://… 里的 tracker），不另起一条 */
const URL_CHAR = /[a-z0-9=&%?/#.+_~-]/i;
/** 磁力、网址到这些字符为止：空白、中文标点和括号。后面「大小：2.1G」这种说明不能粘上来 */
const LINK_STOP = /[\s，。；：！？、【】「」『』《》（）]/;
/** 句末粘在链接后面的英文标点：「(https://….mkv).」 */
const LINK_TRAILING = /[.,;!'")\]}>]+$/;
/** 行首只是个标签：「磁力：」「下载:」「【下载】」 */
const LEAD_LABEL = /[:：】\]]$/;
/** 有字（字母、数字、汉字）才算一句话；只有标点的（「【」「(」）直接丢掉 */
const LEAD_WORDY = /[a-z0-9\u3400-\u9fff]/i;
/** 裸的 info hash：40 位十六进制或 32 位 base32 */
const INFO_HASH = /^(?:[0-9a-f]{40}|[a-z2-7]{32})$/i;

/** 一段以链接开头的文字里，链接占多长：电驴到 |/ 为止（文件名里本来就有空格），磁力和网址到空白或中文标点为止 */
function linkLength(seg: string): number {
  if (/^ed2k:\/\//i.test(seg)) {
    const close = seg.indexOf("|/");
    return close >= 0 ? close + 2 : seg.replace(/\s+$/, "").length;
  }
  const stop = seg.search(LINK_STOP);
  return (stop >= 0 ? seg.slice(0, stop) : seg).replace(LINK_TRAILING, "").length;
}

/**
 * 贴进来的一段文字 → 链接（裸 info hash 原样）和认不出的（thunder:// 之类、一句话）。按行拆，一行里再按每条链接的开头拆：
 *   - 链接开头：磁力、电驴、http(s)、ftp，前面不用有空白（「磁力：magnet:?…」）；单行输入框把换行吃成空格、几条挨着的也拆得开；
 *   - 链接到哪为止：见 linkLength。后面跟着的说明（「大小：2.1G」）丢掉；
 *   - 行首的话：「磁力：」这种标签丢掉；一句话后面跟着磁力、电驴的，话归到认不出的、链接照收；
 *     一句话后面跟着网址的（「沙丘2 https://…」）连同网址一起归到认不出的：多半是在说话，不是要下载。
 */
export function splitOfflineText(text: string): { links: string[]; junk: string[] } {
  const links: string[] = [];
  const junk: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heads: number[] = [];
    const finder = new RegExp(LINK_HEAD.source, "gi");
    for (let m = finder.exec(line); m; m = finder.exec(line)) {
      const i = m.index;
      const prev = line.charAt(i - 1);
      // 电驴链接以 |/ 结尾，紧挨着它的是下一条
      if (i === 0 || /\s/.test(prev) || !URL_CHAR.test(prev) || line.slice(i - 2, i) === "|/") heads.push(i);
    }
    if (heads.length === 0) {
      (INFO_HASH.test(trimmed) ? links : junk).push(trimmed);
      continue;
    }
    let first = 0;
    const lead = line.slice(0, heads[0]).trim();
    if (lead && !LEAD_LABEL.test(lead) && LEAD_WORDY.test(lead)) {
      const seg = line.slice(heads[0], heads[1] ?? line.length);
      if (/^(?:magnet:\?|ed2k:\/\/)/i.test(seg)) junk.push(lead);
      else {
        junk.push(line.slice(0, heads[0] + linkLength(seg)).trim());
        first = 1;
      }
    }
    for (let k = first; k < heads.length; k++) {
      const seg = line.slice(heads[k], heads[k + 1] ?? line.length);
      const link = seg.slice(0, linkLength(seg));
      (TAKEN_HEAD.test(link) ? links : junk).push(link);
    }
  }
  return { links, junk };
}

/**
 * 这段是不是要交给云下载的（输入框决定开云下载还是去搜、拿名字当搜索词前先排除）：带着磁力、电驴链接
 * （「磁力：magnet:?…」这种一段话里带着的也算），或者整段就是一个 info hash（和拆的时候认的一样，base32 的也算）
 */
export function looksLikeOfflineLink(text: string): boolean {
  const t = text.trim();
  return /magnet:\?|ed2k:\/\//i.test(t) || INFO_HASH.test(t);
}

/* ---- 拆链接完 ---- */

/**
 * 挑出能交给云下载的链接，一条一行。拆法见 splitOfflineText，和后端提交时一样：
 * 「磁力：」这种前缀、链接后面跟着的说明（「大小：2.1G」）都不要，一句话后面跟着的网址（「沙丘2 https://…」）不算
 */
export function splitOfflineLinks(text: string): string {
  return splitOfflineText(text).links.join("\n");
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

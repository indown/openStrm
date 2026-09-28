/**
 * 影库搜索的文本归一化。
 *
 * 不用 SQLite 的全文检索：FTS5 默认分词不切中文（「沙丘」匹配不到「沙丘第二部」），trigram 分词要 3 个字以上。
 * 影库的量级（一个大包一两万个节点）归一化后 LIKE 子串匹配就够，几毫秒。
 *
 * 目录的 search_text = `路径各段（含自己）|…#直接文件名|…`，每段各自归一化：
 *   - 小写、全角转半角、罗马数字和汉字数字转阿拉伯数字（冰雪奇缘Ⅱ → 冰雪奇缘2，三十五岁 → 35岁，一九四二 → 1942）
 *   - 去掉空白和标点：`Forrest.Gump.1994` 和 `Forrest Gump` 都成了 `forrestgump…`
 * 查询按空白拆成几个词，逐个同样归一化，全部都要有（AND）。`|` `#` 归一化后不会出现在词里，所以词跨不过段的边界。
 *
 * 规则改了要把 SEARCH_TEXT_VERSION 加一：启动时按库里的目录树就地重算（indexer.ts），不用重抄网盘。
 */
import { stripInvisible } from "../../lib/text.js";

const ROMAN: Record<string, string> = {
  Ⅰ: "1", Ⅱ: "2", Ⅲ: "3", Ⅳ: "4", Ⅴ: "5", Ⅵ: "6", Ⅶ: "7", Ⅷ: "8", Ⅸ: "9", Ⅹ: "10", Ⅺ: "11", Ⅻ: "12",
  ⅰ: "1", ⅱ: "2", ⅲ: "3", ⅳ: "4", ⅴ: "5", ⅵ: "6", ⅶ: "7", ⅷ: "8", ⅸ: "9", ⅹ: "10", ⅺ: "11", ⅻ: "12",
};

/** search_text 的规则版本：1 = 最初；2 = 汉字数字转阿拉伯数字 */
export const SEARCH_TEXT_VERSION = 2;

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const CN_RUN = /[零〇一二两三四五六七八九十百千]+/g;

/**
 * 一串汉字数字换成阿拉伯数字：带十百千的按数值读（三十五 → 35，一百零八 → 108，十 → 10），
 * 不带的逐位读（一九四二 → 1942，二〇二三 → 2023）。只有「百」「千」没有数字的不动（百鸟朝凤、千与千寻）。
 * 查询和目录两边同一个规则，所以「一路向西」成了「1路向西」也照样对得上
 */
function cnNumber(run: string): string {
  if (!/[零〇一二两三四五六七八九十]/.test(run)) return run;
  if (!/[十百千]/.test(run)) return [...run].map((ch) => CN_DIGIT[ch]).join("");
  let total = 0;
  let cur = 0;
  for (const ch of run) {
    const unit = CN_UNIT[ch];
    if (unit === undefined) cur = CN_DIGIT[ch];
    else {
      total += (cur || 1) * unit;
      cur = 0;
    }
  }
  return String(total + cur);
}

/** 空白、标点、括号、分隔符；连 `|` `#` `%` 一起去掉，归一化后的词里不会有 LIKE 的通配符和段分隔符 */
const STRIP = /[\s\-–—_.,，。、:：;；!！?？'’"“”()（）[\]【】《》〈〉「」『』·・&+%|/\\~～`^*#@$<>{}=]/g;

export function normalizeForSearch(s: string): string {
  return stripInvisible(s)
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[Ⅰ-Ⅻⅰ-ⅻ]/g, (ch) => ROMAN[ch] ?? ch)
    .replace(CN_RUN, cnNumber)
    .toLowerCase()
    .replace(STRIP, "");
}

/** 直接文件名那一截最长多少：一个季目录几十集，名字全拼上也就几千字 */
const FILE_PART_MAX = 6000;

/** 目录的 search_text；pathSegments 从分享根到它自己（含自己） */
export function dirSearchText(pathSegments: string[], fileNames: string[] = []): string {
  const path = pathSegments.map(normalizeForSearch).filter(Boolean).join("|");
  let files = "";
  for (const f of fileNames) {
    const n = normalizeForSearch(f);
    if (!n) continue;
    if (files.length + n.length + 1 > FILE_PART_MAX) break;
    files = files ? `${files}|${n}` : n;
  }
  return files ? `${path}#${files}` : path;
}

/** search_text 里「直接文件名」那一截 */
export function filePartOf(searchText: string): string {
  const i = searchText.indexOf("#");
  return i === -1 ? "" : searchText.slice(i + 1);
}

const MAX_TERMS = 8;
const MAX_TERM_LEN = 60;

/**
 * 查询拆词：空白和括号分开（「末日地堡(2023)」是片名加年份两个词），逐个归一化，去空去重，最多 8 个词。
 * 点、冒号不拆：「Forrest.Gump」「A.I.」整个当一个词，拆成单个字母什么都对得上
 */
export function queryTerms(q: string): string[] {
  const out: string[] = [];
  for (const raw of q.split(/[\s【】[\]{}()（）《》「」]+/)) {
    const t = normalizeForSearch(raw).slice(0, MAX_TERM_LEN);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/** 视频文件：统计「直接放着几个视频」、结果里挑文件名给人看 */
const VIDEO_EXT = new Set(["mkv", "mp4", "ts", "m2ts", "mts", "iso", "avi", "rmvb", "rm", "wmv", "mov", "flv", "webm", "mpg", "mpeg", "vob", "m4v", "3gp", "divx"]);

export function isVideoName(name: string): boolean {
  const i = name.lastIndexOf(".");
  return i > 0 && VIDEO_EXT.has(name.slice(i + 1).toLowerCase());
}

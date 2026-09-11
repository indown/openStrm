/**
 * 文件名 / 目录名 → 结构化事实：标题、年份、季、集、绝对集数、版本标签、字幕语言。
 * 纯函数，不碰网络和设置；规则改动先过 parse-name.test.ts 的样本表。
 *
 * 思路：
 *   - 先把方括号段、日期、粘连的 CJK+S01E01 拆开，再按空格 / 点 / 下划线分词；
 *   - 从左到右扫，第一个「季集 / 年份 / 技术词 / 特别篇」标记切断标题，后面全是噪音；
 *   - 字幕组风格 `[Group][Title][01][1080p][JPSC]`：第一段是字幕组，纯数字段是绝对集数；
 *   - 标题里同时有中文和英文时给出多个候选，识别时依次去 TMDB 搜。
 */

export interface ParsedTags {
  resolution?: string;
  source?: string;
  videoCodec?: string;
  audio?: string;
  hdr?: string;
  group?: string;
}

export type ParseCutoff = "episode" | "season" | "year" | "tech" | "date" | "special" | "extra" | "part" | "edition";

export interface ParsedName {
  /** 首选标题（有中文优先中文） */
  title: string;
  /** 依次尝试的标题候选：中文、英文、整段 */
  titles: string[];
  year?: string;
  season?: number;
  episode?: number;
  episodeEnd?: number;
  /** 没有季标记的集数（字幕组的 [13]、`- 13`、`第13话`）：到底是第几季第几集要结合目录和 TMDB 判断 */
  absolute?: number;
  absoluteEnd?: number;
  isSpecial?: boolean;
  /** NCOP / PV / 花絮 / 预告 这类附加内容 */
  isExtra?: boolean;
  isSample?: boolean;
  /** 日播：YYYY-MM-DD */
  date?: string;
  part?: number;
  edition?: string;
  tags: ParsedTags;
  subtitleLang?: string;
  forced?: boolean;
  sdh?: boolean;
  cutoff?: ParseCutoff;
}

/* ------------------------------- 词表 ------------------------------- */

const RESOLUTION: Record<string, string> = {
  "2160p": "2160p", "1080p": "1080p", "1080i": "1080i", "720p": "720p", "576p": "576p", "480p": "480p",
  "4k": "4K", "8k": "8K", "uhd": "UHD", "2160": "2160p", "1080": "1080p", "720": "720p", "4320p": "4320p",
};
const SOURCE: Record<string, string> = {
  bluray: "BluRay", "blu-ray": "BluRay", bdrip: "BDRip", brrip: "BRRip", bdremux: "Remux", remux: "Remux",
  "web-dl": "WEB-DL", webdl: "WEB-DL", webrip: "WEBRip", web: "WEB", hdtv: "HDTV", hdtvrip: "HDTVRip", hdrip: "HDRip",
  dvdrip: "DVDRip", dvd: "DVD", uhdrip: "UHDRip", "uhd-bluray": "BluRay", hdcam: "HDCAM", hdts: "HDTS", cam: "CAM",
  dvdscr: "DVDSCR", screener: "Screener", 蓝光: "BluRay", 原盘: "Remux",
};
const VIDEO: Record<string, string> = {
  x264: "x264", x265: "x265", h264: "H.264", "h.264": "H.264", h265: "H.265", "h.265": "H.265", hevc: "HEVC",
  avc: "AVC", av1: "AV1", xvid: "XviD", divx: "DivX", vp9: "VP9", "10bit": "10bit", "8bit": "8bit", "10-bit": "10bit", hi10p: "Hi10P",
};
const AUDIO: Record<string, string> = {
  aac: "AAC", ac3: "AC3", eac3: "EAC3", "e-ac3": "EAC3", "e-ac-3": "EAC3", dd: "DD", "dd+": "DDP", ddp: "DDP", dts: "DTS",
  "dts-hd": "DTS-HD", dtshd: "DTS-HD", "dts-x": "DTS-X", dtsx: "DTS-X", truehd: "TrueHD", atmos: "Atmos", flac: "FLAC",
  opus: "Opus", mp3: "MP3", lpcm: "LPCM", pcm: "PCM", "aac2.0": "AAC", "aac5.1": "AAC", "ddp5.1": "DDP", "ddp2.0": "DDP",
  "dd5.1": "DD", "dd2.0": "DD", "ac3-5.1": "AC3",
};
const HDR: Record<string, string> = {
  hdr: "HDR", hdr10: "HDR10", "hdr10+": "HDR10+", hdr10plus: "HDR10+", dv: "DV", dovi: "DV", dolbyvision: "DV", sdr: "SDR", hlg: "HLG",
};
/** 只用来切断标题、不落进标签的噪音 */
const NOISE = new Set([
  "51", "71", "20", "51ch", "71ch", "20ch",
  "repack", "proper", "limited", "internal", "rerip", "complete", "multi", "multisub", "subbed", "dubbed", "dual", "dual-audio",
  "nfofix", "3d", "hsbs", "sbs", "hou", "60fps", "120fps", "24fps", "ma", "rip", "amzn", "nflx", "nf", "hmax", "max", "hulu",
  "dsnp", "dsny", "disney", "aptv", "atvp", "atv", "ami", "pcok", "pmtp", "itunes", "cr", "crunchyroll", "bilibili", "b-global",
  "baha", "ani", "viu", "iqiyi", "iq", "tencent", "youku", "mgtv", "hq", "fhd", "hd", "chs", "cht", "chi", "eng", "jpn", "jap",
  "kor", "ger", "fre", "ita", "spa", "rus", "jpsc", "jptc", "gb", "big5", "gb_jp", "big5_jp", "sc", "tc", "cn", "5.1", "7.1", "2.0",
  "6ch", "2ch", "8ch", "bit", "bits", "kbps", "hdr-x", "hqx", "hi-res", "web-rip", "webcap", "hc", "hardsub", "softsub",
  "国语", "粤语", "中字", "双语", "简中", "繁中", "简繁", "内封", "内嵌", "外挂", "中英", "中日", "英语", "日语", "韩语", "字幕", "特效",
  "简体", "繁体", "高清", "超清", "完结", "全集", "合集", "高码", "修复", "国粤", "台配", "国配", "官方", "无字", "生肉", "熟肉",
  "简日", "繁日", "简繁日", "简繁内封", "简体中字", "繁体中字", "中文字幕", "内嵌字幕", "外挂字幕", "更新至", "连载",
]);
const CJK_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 多词版本名：小写、按空格分好；顺序从长到短，先匹配长的 */
const EDITIONS: Array<{ words: string[]; label: string }> = [
  { words: ["director's", "cut"], label: "Director's Cut" },
  { words: ["directors", "cut"], label: "Director's Cut" },
  { words: ["final", "cut"], label: "Final Cut" },
  { words: ["extended", "cut"], label: "Extended" },
  { words: ["extended", "edition"], label: "Extended" },
  { words: ["theatrical", "cut"], label: "Theatrical" },
  { words: ["theatrical", "edition"], label: "Theatrical" },
  { words: ["ultimate", "edition"], label: "Ultimate Edition" },
  { words: ["ultimate", "cut"], label: "Ultimate Cut" },
  { words: ["special", "edition"], label: "Special Edition" },
  { words: ["collectors", "edition"], label: "Collector's Edition" },
  { words: ["collector's", "edition"], label: "Collector's Edition" },
  { words: ["anniversary", "edition"], label: "Anniversary Edition" },
  { words: ["open", "matte"], label: "Open Matte" },
  { words: ["extended"], label: "Extended" },
  { words: ["unrated"], label: "Unrated" },
  { words: ["uncut"], label: "Uncut" },
  { words: ["imax"], label: "IMAX" },
  { words: ["remastered"], label: "Remastered" },
  { words: ["criterion"], label: "Criterion" },
  { words: ["导演剪辑版"], label: "导演剪辑版" },
  { words: ["导剪版"], label: "导演剪辑版" },
  { words: ["加长版"], label: "加长版" },
  { words: ["未删减版"], label: "未删减版" },
  { words: ["未分级版"], label: "未分级版" },
  { words: ["剧场版"], label: "剧场版" },
  { words: ["终极剪辑版"], label: "终极剪辑版" },
  { words: ["修复版"], label: "修复版" },
];

const SUBTITLE_LANG: Record<string, string> = {
  "zh-cn": "zh-CN", "zh-hans": "zh-CN", zh: "zh-CN", chs: "zh-CN", chi: "zh-CN", zho: "zh-CN", sc: "zh-CN", 简: "zh-CN", 简体: "zh-CN",
  简中: "zh-CN", 中文: "zh-CN", chinese: "zh-CN", "chs&eng": "zh-CN", 简英: "zh-CN", 中英: "zh-CN", 简繁: "zh-CN", gb: "zh-CN",
  "zh-tw": "zh-TW", "zh-hant": "zh-TW", "zh-hk": "zh-HK", cht: "zh-TW", tc: "zh-TW", 繁: "zh-TW", 繁体: "zh-TW", 繁中: "zh-TW",
  "cht&eng": "zh-TW", 繁英: "zh-TW", big5: "zh-TW",
  en: "en", eng: "en", english: "en", 英文: "en", 英语: "en",
  ja: "ja", jp: "ja", jpn: "ja", japanese: "ja", 日文: "ja", 日语: "ja",
  ko: "ko", kor: "ko", korean: "ko", 韩文: "ko", 韩语: "ko",
  fr: "fr", fre: "fr", fra: "fr", french: "fr", de: "de", ger: "de", deu: "de", german: "de", es: "es", spa: "es", spanish: "es",
  ru: "ru", rus: "ru", russian: "ru", it: "it", ita: "it", italian: "it", pt: "pt", por: "pt", "pt-br": "pt-BR", th: "th", tha: "th",
  vi: "vi", vie: "vi", ar: "ar", ara: "ar", hi: "hi", hin: "hi",
};
const SUBTITLE_FLAGS = new Set(["forced", "default", "sdh", "cc", "hearing", "强制", "默认"]);

/* ------------------------------- 正则 ------------------------------- */

const RE_SXXEXX = /^s(\d{1,2})e(\d{1,4})(?:[-~]?e?(\d{1,4}))?$/i;
const RE_SXX = /^s(\d{1,2})$/i;
const RE_NXN = /^(\d{1,2})x(\d{1,3})$/i;
const RE_EXX = /^ep?(\d{1,4})(?:[-~]e?p?(\d{1,4}))?$/i;
const RE_CN_EP = /^第(\d{1,4}|[零〇一二两三四五六七八九十百]+)(?:[-~](\d{1,4}))?[集话話期回]$/;
const RE_CN_SEASON = /^第(\d{1,2}|[一二两三四五六七八九十]+)[季部]$/;
const RE_SEASON_WORD = /^season$/i;
const RE_SEASON_ATTACHED = /^season(\d{1,2})$/i;
const RE_YEAR = /^(19|20)\d{2}$/;
const RE_SPECIAL = /^(sp|special|specials|ova|oad|oav|特别篇|特別篇|番外|番外篇|sp\d{1,2}|ova\d{1,2}|oad\d{1,2})$/i;
const RE_SPECIAL_NUM = /^(?:sp|ova|oad)(\d{1,2})$/i;
const RE_EXTRA = /^(ncop|nced|pv|cm|menu|trailer|trailers|preview|featurette|featurettes|bts|making|makingof|behindthescenes|creditless)\d*$/i;
const RE_PART = /^(?:part|pt|cd|disc|disk|dvd)[.\-_ ]?(\d{1,2})$/i;
const RE_PART_CN = /^(?:上|中|下)[部集]?$/;
const RE_TECH_GROUP = /^(.+?)-([A-Za-z0-9@_]{2,})$/;
const RE_AT_GROUP = /^@([A-Za-z0-9_]{2,})$/;
const RE_BARE_EP = /^(\d{1,3})(?:v\d)?$/;
const RE_BARE_EP_RANGE = /^(\d{1,3})[-~](\d{1,3})$/;
const RE_DATE = /(?<![\d])((?:19|20)\d{2})[.\-_ ](\d{2})[.\-_ ](\d{2})(?![\d])/;
const RE_CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
const RE_LATIN = /[A-Za-z]/;

/* ------------------------------- 小工具 ------------------------------- */

export function parseCjkNumber(s: string): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let current = 0;
  let sawTen = false;
  for (const ch of s) {
    if (ch === "十") {
      total += (current || 1) * 10;
      current = 0;
      sawTen = true;
      continue;
    }
    if (ch === "百") {
      total += (current || 1) * 100;
      current = 0;
      sawTen = true;
      continue;
    }
    const d = CJK_DIGITS[ch];
    if (d === undefined) return null;
    current = current * 10 + d;
  }
  total += current;
  return sawTen || s.length <= 3 || /^[零〇一二两三四五六七八九]+$/.test(s) ? total : null;
}

function lower(s: string): string {
  return s.toLowerCase();
}

type Chunk = { kind: "text"; value: string } | { kind: "bracket"; value: string };

/** 先把方括号 / 圆括号段拆出来，其余按分隔符分词。全角括号先换成半角 */
function chunk(input: string): Chunk[] {
  const s = input.replace(/【/g, "[").replace(/】/g, "]").replace(/（/g, "(").replace(/）/g, ")").replace(/｛/g, "{").replace(/｝/g, "}");
  const out: Chunk[] = [];
  let i = 0;
  let text = "";
  const flush = () => {
    if (text.trim()) out.push({ kind: "text", value: text });
    text = "";
  };
  while (i < s.length) {
    const ch = s[i];
    const close = ch === "[" ? "]" : ch === "(" ? ")" : ch === "{" ? "}" : null;
    if (close) {
      const end = s.indexOf(close, i + 1);
      if (end !== -1) {
        flush();
        out.push({ kind: "bracket", value: s.slice(i + 1, end).trim() });
        i = end + 1;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** 被点号拆坏的技术词先粘回去：H.264 → H264、DDP5.1 → DDP5、DTS-HD.MA → DTS-HD、Blu-ray 已经带连字符不用管 */
function glueDottedTech(text: string): string {
  return text
    .replace(/\b([Hh])\.(26[45])\b/g, "$1$2")
    .replace(/\b(DDP|DD|AAC|AC3|EAC3|DTS|TrueHD|Atmos|FLAC|E-?AC-?3)(\d)\.(\d)\b/gi, "$1$2")
    .replace(/\b(\d)\.(\d)(ch)?\b/gi, "$1$2$3")
    .replace(/\bDTS-HD\.MA\b/gi, "DTS-HD")
    .replace(/\bWEB\.DL\b/gi, "WEB-DL")
    .replace(/\bBlu\.Ray\b/gi, "BluRay");
}

/** 文本段分词：空格 / 点 / 下划线；`Title - 01` 的 ` - ` 是强分隔，单独产出一个 "-" 记号 */
function splitWords(text: string): string[] {
  return glueDottedTech(text)
    .replace(/\s+-\s+/g, " - ")
    .split(/[\s._]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/** CJK 和 `S01E01` / 年份 / `EP01` 粘在一起时拆开：`怒呛人生S01E01`、`葬送的芙莉莲2023` */
function unglue(s: string): string {
  return s
    .replace(/([぀-ヿ一-鿿가-힯])(?=[Ss]\d{1,2}[Ee]\d{1,4}\b)/g, "$1 ")
    .replace(/([぀-ヿ一-鿿가-힯])(?=[Ee][Pp]?\d{1,4}\b)/g, "$1 ")
    .replace(/([぀-ヿ一-鿿가-힯])(?=(?:19|20)\d{2}\s*$)/g, "$1 ")
    .replace(/([぀-ヿ一-鿿가-힯])(?=第[零〇一二两三四五六七八九十百\d]+[季集话話期部回])/g, "$1 ")
    .replace(/(第[零〇一二两三四五六七八九十百\d]+[季集话話期部回])(?=[぀-ヿ一-鿿가-힯])/g, "$1 ")
    .replace(/\b((?:19|20)\d{2})(?=[぀-ヿ一-鿿])/g, "$1 ");
}

function stripEdges(w: string): string {
  return w.replace(/^[-–—~]+|[-–—~]+$/g, "");
}

/** 标题候选：`中文 / English`、`中文 English` 拆成多个，中文优先 */
export function titleCandidates(title: string): string[] {
  const t = title.trim();
  if (!t) return [];
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.replace(/\s+/g, " ").trim().replace(/^[-–—:：,，]+|[-–—:：,，]+$/g, "").trim();
    if (v && !out.includes(v)) out.push(v);
  };
  if (/\s*\/\s*/.test(t)) {
    const parts = t.split(/\s*\/\s*/).filter(Boolean);
    const cjk = parts.filter((p) => RE_CJK.test(p));
    for (const p of [...cjk, ...parts]) push(p);
    push(t);
    return out;
  }
  const hasCjk = RE_CJK.test(t);
  const hasLatin = RE_LATIN.test(t);
  if (hasCjk && hasLatin) {
    // 按词分：带 CJK 的词整个归中文（《沙丘2》的 2 跟着中文走），其余归英文
    const words = t.split(/\s+/);
    const cjkPart = words.filter((w) => RE_CJK.test(w)).join(" ");
    const latinPart = words.filter((w) => !RE_CJK.test(w)).join(" ");
    if (cjkPart.length >= 1) push(cjkPart);
    if (latinPart.replace(/[^A-Za-z]/g, "").length >= 2) push(latinPart);
  }
  push(t);
  return out;
}

/* ------------------------------- 字幕语言 ------------------------------- */

interface SubtitleSuffix {
  stem: string;
  lang?: string;
  forced?: boolean;
  sdh?: boolean;
}

/** 从字幕文件的主名末尾剥语言 / 标记段：`Movie.zh-CN.forced` → stem Movie */
export function stripSubtitleSuffix(stem: string): SubtitleSuffix {
  const parts = stem.split(".");
  const out: SubtitleSuffix = { stem };
  while (parts.length > 1) {
    const last = lower(parts[parts.length - 1].trim());
    if (SUBTITLE_FLAGS.has(last)) {
      if (last === "forced" || last === "强制") out.forced = true;
      else if (last === "sdh" || last === "cc" || last === "hearing") out.sdh = true;
      parts.pop();
      continue;
    }
    const lang = SUBTITLE_LANG[last];
    if (lang && !out.lang) {
      out.lang = lang;
      parts.pop();
      continue;
    }
    break;
  }
  out.stem = parts.join(".");
  return out;
}

/* ------------------------------- 主流程 ------------------------------- */

export interface ParseOptions {
  /** 字幕文件：先剥语言段 */
  subtitle?: boolean;
}

export function parseMediaName(rawName: string, opts: ParseOptions = {}): ParsedName {
  const result: ParsedName = { title: "", titles: [], tags: {} };
  let name = (rawName ?? "").trim();
  if (!name) return result;

  if (opts.subtitle) {
    const sub = stripSubtitleSuffix(name);
    name = sub.stem;
    if (sub.lang) result.subtitleLang = sub.lang;
    if (sub.forced) result.forced = true;
    if (sub.sdh) result.sdh = true;
  }

  // 日播日期先摘掉，不然分词会把它拆成三段数字
  const dateMatch = RE_DATE.exec(name);
  if (dateMatch) {
    result.date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    name = name.replace(dateMatch[0], " DATEMARK ");
  }
  name = unglue(name);

  // 整个名字就是一个 1-3 位数字（01.mkv / 第 07 集那种散集）：它是集数，不是标题
  const bare = /^0*(\d{1,3})(?:v\d)?$/.exec(name.trim());
  if (bare && !dateMatch) {
    result.absolute = Number(bare[1]);
    result.cutoff = "episode";
    return result;
  }

  const chunks = chunk(name);
  const animeStyle = chunks.length >= 2 && chunks[0].kind === "bracket" && chunks.filter((c) => c.kind === "bracket").length >= 2 && /^\s*\[/.test(name.trim());

  /** 标题词；bracket 段的标题也进这里 */
  const titleWords: string[] = [];
  let cut = false;
  let yearBeforeCut: string | undefined;
  let yearAfterCut: string | undefined;
  const cutAt = (why: ParseCutoff) => {
    if (!cut) {
      cut = true;
      result.cutoff = why;
    }
  };
  const setEpisode = (ep: number, end?: number) => {
    if (result.episode === undefined) {
      result.episode = ep;
      if (end !== undefined && end > ep) result.episodeEnd = end;
    }
  };
  const setAbsolute = (ep: number, end?: number) => {
    if (result.absolute === undefined && result.episode === undefined) {
      result.absolute = ep;
      if (end !== undefined && end > ep) result.absoluteEnd = end;
    }
  };
  const setSeason = (n: number) => {
    if (result.season === undefined) result.season = n;
  };

  /** 认技术词 / 噪音；认出来返回 true（并记标签） */
  const tech = (word: string): boolean => {
    const w = lower(word);
    if (RESOLUTION[w]) {
      result.tags.resolution ??= RESOLUTION[w];
      return true;
    }
    if (SOURCE[w]) {
      result.tags.source ??= SOURCE[w];
      return true;
    }
    if (VIDEO[w]) {
      result.tags.videoCodec ??= VIDEO[w];
      return true;
    }
    if (AUDIO[w]) {
      result.tags.audio ??= AUDIO[w];
      return true;
    }
    if (HDR[w]) {
      result.tags.hdr ??= HDR[w];
      return true;
    }
    if (NOISE.has(w)) return true;
    // 2160p.WEB-DL 已经拆开；`DDP5.1` 被点拆成 ddp5 / 1，`DDP5` 也认
    if (/^(ddp|dd|aac|ac3|eac3|dts|truehd|atmos|flac)\d{1,2}(\.\d)?(ch)?$/.test(w)) {
      result.tags.audio ??= AUDIO[w.replace(/\d.*$/, "")] ?? w.toUpperCase();
      return true;
    }
    if (/^\d{1,2}bit$/.test(w)) return true;
    if (/^\d+fps$/.test(w)) return true;
    if (/^v\d$/.test(w)) return true;
    return false;
  };

  /** 一个词是不是标记（季集 / 年份 / 特别篇 …），是就登记并切断 */
  const marker = (word: string, ctx: { bracket: boolean; afterDash: boolean; nextIsTech: boolean }): boolean => {
    const w = stripEdges(word);
    if (!w) return false;
    let m: RegExpExecArray | null;
    if ((m = RE_SXXEXX.exec(w))) {
      setSeason(Number(m[1]));
      setEpisode(Number(m[2]), m[3] ? Number(m[3]) : undefined);
      cutAt("episode");
      return true;
    }
    if ((m = RE_NXN.exec(w))) {
      setSeason(Number(m[1]));
      setEpisode(Number(m[2]));
      cutAt("episode");
      return true;
    }
    if ((m = RE_SXX.exec(w))) {
      setSeason(Number(m[1]));
      cutAt("season");
      return true;
    }
    if ((m = RE_SEASON_ATTACHED.exec(w))) {
      setSeason(Number(m[1]));
      cutAt("season");
      return true;
    }
    if ((m = RE_CN_SEASON.exec(w))) {
      const n = parseCjkNumber(m[1]);
      if (n !== null) {
        setSeason(n);
        cutAt("season");
        return true;
      }
    }
    if ((m = RE_CN_EP.exec(w))) {
      const n = parseCjkNumber(m[1]);
      if (n !== null) {
        if (result.season !== undefined) setEpisode(n, m[2] ? Number(m[2]) : undefined);
        else setAbsolute(n, m[2] ? Number(m[2]) : undefined);
        cutAt("episode");
        return true;
      }
    }
    if ((m = RE_EXX.exec(w)) && (w.length >= 3 || /^e\d{2,}$/i.test(w))) {
      const n = Number(m[1]);
      if (result.season !== undefined) setEpisode(n, m[2] ? Number(m[2]) : undefined);
      else setAbsolute(n, m[2] ? Number(m[2]) : undefined);
      cutAt("episode");
      return true;
    }
    if (RE_SPECIAL.test(w)) {
      result.isSpecial = true;
      const sm = RE_SPECIAL_NUM.exec(w);
      if (sm) setEpisode(Number(sm[1]));
      cutAt("special");
      return true;
    }
    if (RE_EXTRA.test(w)) {
      result.isExtra = true;
      cutAt("extra");
      return true;
    }
    if (lower(w) === "sample") {
      result.isSample = true;
      cutAt("extra");
      return true;
    }
    if ((m = RE_PART.exec(w))) {
      result.part ??= Number(m[1]);
      cutAt("part");
      return true;
    }
    if (w === "DATEMARK") {
      cutAt("date");
      return true;
    }
    if (RE_YEAR.test(w)) {
      if (cut) {
        yearAfterCut ??= w;
        return true;
      }
      // 标题开头的年份（《2012》《1917》）先当标题，后面再有年份或技术词再定
      if (titleWords.length === 0 && !ctx.bracket) {
        titleWords.push(w);
        return true;
      }
      // 已经有一个年份在前、又来一个：前一个属于标题（《银翼杀手 2049 2017》）
      if (yearBeforeCut !== undefined) {
        titleWords.push(yearBeforeCut);
        yearBeforeCut = w;
        return true;
      }
      yearBeforeCut = w;
      return true;
    }
    // 字幕组风格的 [01] / [01-12]、`- 01`、`01 [1080p]`（带前导零）
    if (ctx.bracket || ctx.afterDash || (ctx.nextIsTech && /^0\d{1,2}$/.test(w))) {
      if ((m = RE_BARE_EP_RANGE.exec(w))) {
        setAbsolute(Number(m[1]), Number(m[2]));
        cutAt("episode");
        return true;
      }
      if ((m = RE_BARE_EP.exec(w)) && (ctx.bracket || /^\d/.test(w))) {
        setAbsolute(Number(m[1]));
        cutAt("episode");
        return true;
      }
    }
    if (tech(w)) {
      cutAt("tech");
      return true;
    }
    // x265-FLUX / AAC-PTHweb：技术词带组名后缀
    const tg = RE_TECH_GROUP.exec(w);
    if (tg && tech(tg[1])) {
      result.tags.group ??= tg[2];
      cutAt("tech");
      return true;
    }
    const ag = RE_AT_GROUP.exec(w);
    if (ag) {
      result.tags.group ??= ag[1];
      cutAt("tech");
      return true;
    }
    if (RE_PART_CN.test(w) && titleWords.length > 0 && ctx.nextIsTech) {
      cutAt("part");
      return true;
    }
    return false;
  };

  /** 多词版本名：从当前位置起看能不能凑上 */
  const editionAt = (words: string[], i: number): { label: string; len: number } | null => {
    for (const e of EDITIONS) {
      if (e.words.every((w, k) => lower(words[i + k] ?? "") === w)) return { label: e.label, len: e.words.length };
    }
    return null;
  };

  const isTechWord = (w: string): boolean => {
    const s = lower(stripEdges(w));
    return !!(RESOLUTION[s] || SOURCE[s] || VIDEO[s] || AUDIO[s] || HDR[s] || NOISE.has(s));
  };

  let bracketIndex = 0;
  let groupFromBracket: string | undefined;
  // 非字幕组风格、开头一个方括号段后面紧跟正文：【高清剧集】【4K】这类站点标签，扔掉
  const leadingTag = !animeStyle && chunks.length >= 2 && chunks[0].kind === "bracket" && chunks[1].kind === "text" && !RE_YEAR.test(chunks[0].value.trim());
  chunks.forEach((c, ci) => {
    if (c.kind === "bracket") {
      const inner = c.value.trim();
      bracketIndex++;
      if (!inner) return;
      if (leadingTag && ci === 0) return;
      // 字幕组风格：第一段是组名
      if (animeStyle && bracketIndex === 1 && !RE_YEAR.test(inner) && !RE_BARE_EP.test(inner)) {
        groupFromBracket = inner;
        return;
      }
      const words = splitWords(inner);
      // 整段是一个标记（[01]、[2024]、[1080p]、[Nekomoe kissaten]）
      if (words.length === 1 || /^\d{1,3}[-~]\d{1,3}$/.test(inner) || /^(19|20)\d{2}$/.test(inner)) {
        if (marker(inner.replace(/\s+/g, ""), { bracket: true, afterDash: false, nextIsTech: false })) return;
        if (words.length === 1 && marker(words[0], { bracket: true, afterDash: false, nextIsTech: false })) return;
      }
      // 多词的段：全是技术词就整段当噪音；否则若还没切断就是标题（字幕组的 [Sousou no Frieren]）
      const allTech = words.every((w) => isTechWord(w) || marker(w, { bracket: true, afterDash: false, nextIsTech: true }));
      if (allTech) {
        cutAt("tech");
        return;
      }
      if (!cut) {
        // 圆括号里的年份：`Name (2024)`
        if (RE_YEAR.test(inner)) {
          yearBeforeCut = inner;
          return;
        }
        if (titleWords.length === 0 || animeStyle) {
          if (titleWords.length === 0) titleWords.push(...words.filter((w) => !isTechWord(w)));
          return;
        }
        // 标题后面括号里的东西（别名、副标题）：先切断，避免把它当技术词
        cutAt("tech");
      }
      return;
    }
    const words = splitWords(c.value);
    let afterDash = false;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === "-") {
        afterDash = titleWords.length > 0;
        continue;
      }
      const nextIsTech = i + 1 < words.length ? isTechWord(words[i + 1]) : ci + 1 < chunks.length && chunks[ci + 1].kind === "bracket";
      if (!cut) {
        const ed = editionAt(words, i);
        if (ed && (titleWords.length > 0 || yearBeforeCut)) {
          result.edition ??= ed.label;
          cutAt("edition");
          i += ed.len - 1;
          continue;
        }
      } else if (result.edition === undefined) {
        const ed = editionAt(words, i);
        if (ed) {
          result.edition = ed.label;
          i += ed.len - 1;
          continue;
        }
      }
      if (RE_SEASON_WORD.test(w) && i + 1 < words.length && /^\d{1,2}$/.test(words[i + 1])) {
        setSeason(Number(words[i + 1]));
        cutAt("season");
        i++;
        continue;
      }
      if (marker(w, { bracket: false, afterDash, nextIsTech })) {
        afterDash = false;
        continue;
      }
      afterDash = false;
      if (!cut) titleWords.push(w);
      else if (result.tags.group === undefined && i === words.length - 1 && ci === chunks.length - 1 && /^-[A-Za-z0-9@_]{2,}$/.test(w)) {
        result.tags.group = w.slice(1);
      }
    }
  });

  if (groupFromBracket && result.tags.group === undefined) result.tags.group = groupFromBracket;
  result.year = yearBeforeCut ?? yearAfterCut;
  // 没切断、标题最后一个词是年份（《Avatar 2009》）：它就是年份
  if (!cut && result.year === undefined && titleWords.length > 1 && RE_YEAR.test(titleWords[titleWords.length - 1])) {
    result.year = titleWords.pop();
  }

  const title = titleWords
    .map(stripEdges)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:：,，.]+|[\s\-–—:：,，.]+$/g, "")
    .trim();
  result.titles = titleCandidates(title);
  result.title = result.titles[0] ?? "";
  return result;
}

/* ------------------------------- 目录名 ------------------------------- */

const RE_SEASON_DIR = /^(?:season|s|series)[\s._-]*(\d{1,2})$|^第(\d{1,2}|[一二两三四五六七八九十]+)[季部]$/i;
const RE_SPECIALS_DIR = /^(?:specials?|sp|ova|oad|extras?|特别篇|特別篇|番外|番外篇|season[\s._-]*0+|s0+)$/i;
const RE_EXTRAS_DIR = /^(?:extras?|featurettes?|trailers?|behind[\s._-]*the[\s._-]*scenes|deleted[\s._-]*scenes|interviews?|scenes?|shorts?|samples?|花絮|预告|其他|其它|附赠|特典|cd|menu|bonus|bdmv|certificate)$/i;

/** 季目录：Season 1 / S01 / 第一季 → 季号；Specials / SP / 番外 → 0；不是季目录返回 null */
export function seasonDirNumber(name: string): number | null {
  const n = name.trim();
  if (RE_SPECIALS_DIR.test(n)) return RE_EXTRAS_DIR.test(n) ? null : 0;
  const m = RE_SEASON_DIR.exec(n);
  if (!m) return null;
  if (m[1]) return Number(m[1]);
  return parseCjkNumber(m[2]);
}

/** 花絮目录：里面的东西不是正片 */
export function isExtrasDirName(name: string): boolean {
  return RE_EXTRAS_DIR.test(name.trim());
}

const RE_CANONICAL_MOVIE = /^.+ \((?:19|20)\d{2}\)(?: - .+)?(?:-part\d+)?$/;
const RE_CANONICAL_TV = /^.+ - S\d{2}E\d{2,4}(?:-E\d{2,4})?(?: - .+)?$/;
/** 只有这些来源词才算「发布噪音」：`WEB`、`CAM`、`DVD` 这种也是普通词，放进标题里太常见 */
const STRONG_SOURCE = new Set(["WEB-DL", "WEBRip", "BluRay", "BDRip", "BRRip", "Remux", "HDTV", "HDTVRip", "HDRip", "DVDRip", "UHDRip", "HDCAM", "HDTS", "DVDSCR"]);

/**
 * 文件名像不像原始发布命名：已经是 `标题 (年)[ - 版本]` / `标题 - S01E01[ - 集名]` 这种规范形状的不算；
 * 其余带压制组 / 编码 / 来源词、或字幕组方括号开头的算。集名里的 Web / Opus 这种普通词不算噪音
 */
export function hasReleaseNoise(stem: string): boolean {
  const s = stem.trim();
  if (RE_CANONICAL_MOVIE.test(s) || RE_CANONICAL_TV.test(s)) return false;
  if (/^\[/.test(s)) return true;
  const t = parseMediaName(s).tags;
  return !!(t.videoCodec || t.group || (t.source && STRONG_SOURCE.has(t.source)));
}

/**
 * 目录名像不像一个发布目录：带年份、季集标记或发布噪音的算；`downloads`、`inbox`、`电影` 这种收件箱式的名字不算。
 * 用来决定「范围就是这个目录」时腾空了删不删
 */
export function looksLikeReleaseDir(name: string): boolean {
  const p = parseMediaName(name);
  return !!p.year || p.season !== undefined || p.episode !== undefined || hasReleaseNoise(name);
}

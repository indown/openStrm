/**
 * TMDB 的类型、国家 / 地区：编号 / 代码和中文名互换，给收藏夹按「科幻」「韩国」筛、给智能体看。
 * 类型名照 TMDB 简中；电影和剧的类型编号大多共用，剧多几个组合类（动作冒险、科幻奇幻、战争政治）。
 */

const GENRES: Record<number, { zh: string; en: string }> = {
  28: { zh: "动作", en: "action" },
  12: { zh: "冒险", en: "adventure" },
  16: { zh: "动画", en: "animation" },
  35: { zh: "喜剧", en: "comedy" },
  80: { zh: "犯罪", en: "crime" },
  99: { zh: "纪录", en: "documentary" },
  18: { zh: "剧情", en: "drama" },
  10751: { zh: "家庭", en: "family" },
  14: { zh: "奇幻", en: "fantasy" },
  36: { zh: "历史", en: "history" },
  27: { zh: "恐怖", en: "horror" },
  10402: { zh: "音乐", en: "music" },
  9648: { zh: "悬疑", en: "mystery" },
  10749: { zh: "爱情", en: "romance" },
  878: { zh: "科幻", en: "science fiction sci-fi" },
  10770: { zh: "电视电影", en: "tv movie" },
  53: { zh: "惊悚", en: "thriller" },
  10752: { zh: "战争", en: "war" },
  37: { zh: "西部", en: "western" },
  10759: { zh: "动作冒险", en: "action adventure" },
  10762: { zh: "儿童", en: "kids" },
  10763: { zh: "新闻", en: "news" },
  10764: { zh: "真人秀", en: "reality" },
  10765: { zh: "科幻奇幻", en: "sci-fi fantasy" },
  10766: { zh: "肥皂剧", en: "soap" },
  10767: { zh: "脱口秀", en: "talk" },
  10768: { zh: "战争政治", en: "war politics" },
};

/** 类型编号 → 中文名（认不出的编号不给） */
export const genreNames = (ids: number[]): string[] => ids.map((id) => GENRES[id]?.zh).filter((n): n is string => !!n);

/**
 * 「科幻」「科幻片」「Sci-Fi」「878」→ 对得上的类型编号：名字包含它的都算（科幻 → 科幻、科幻奇幻；战争 → 战争、战争政治）。
 * 认不出返回空数组
 */
/** TMDB 上没有、口头上常说的类型 */
const GENRE_ALIASES: Record<string, number[]> = { 动漫: [16], 卡通: [16], 综艺: [10764, 10767] };

export function genreIdsOf(query: string): number[] {
  const q = query.trim().toLowerCase().replace(/(?:片|类|电影|剧集)$/u, "");
  if (!q) return [];
  if (/^\d+$/.test(q)) return GENRES[Number(q)] ? [Number(q)] : [];
  if (GENRE_ALIASES[q]) return GENRE_ALIASES[q];
  return Object.entries(GENRES)
    .filter(([, g]) => g.zh.includes(q) || g.en.includes(q))
    .map(([id]) => Number(id));
}

const COUNTRIES: Record<string, string> = {
  CN: "中国大陆",
  HK: "中国香港",
  TW: "中国台湾",
  KR: "韩国",
  JP: "日本",
  US: "美国",
  GB: "英国",
  FR: "法国",
  DE: "德国",
  IT: "意大利",
  ES: "西班牙",
  RU: "俄罗斯",
  IN: "印度",
  TH: "泰国",
  CA: "加拿大",
  AU: "澳大利亚",
  NZ: "新西兰",
  IE: "爱尔兰",
  SE: "瑞典",
  DK: "丹麦",
  NO: "挪威",
  FI: "芬兰",
  BE: "比利时",
  NL: "荷兰",
  AT: "奥地利",
  CH: "瑞士",
  PL: "波兰",
  CZ: "捷克",
  HU: "匈牙利",
  TR: "土耳其",
  IL: "以色列",
  IR: "伊朗",
  BR: "巴西",
  MX: "墨西哥",
  AR: "阿根廷",
  CO: "哥伦比亚",
  ZA: "南非",
  SG: "新加坡",
  MY: "马来西亚",
  PH: "菲律宾",
  ID: "印度尼西亚",
  VN: "越南",
  UA: "乌克兰",
};

/** 口头上的叫法：「韩」「港」「国产」「华语」…… */
const COUNTRY_ALIASES: Record<string, string[]> = {
  大陆: ["CN"],
  内地: ["CN"],
  国产: ["CN"],
  中国: ["CN", "HK", "TW"],
  华语: ["CN", "HK", "TW"],
  香港: ["HK"],
  港: ["HK"],
  台湾: ["TW"],
  台: ["TW"],
  韩: ["KR"],
  南韩: ["KR"],
  日: ["JP"],
  美: ["US"],
  英: ["GB"],
  法: ["FR"],
  德: ["DE"],
  俄: ["RU"],
  泰: ["TH"],
  欧美: ["US", "GB", "CA", "FR", "DE", "IT", "ES", "AU", "IE", "SE", "DK", "NO", "BE", "NL"],
};

/** 国家 / 地区代码 → 中文名（不认识的原样给代码） */
export const countryNames = (codes: string[]): string[] => codes.map((c) => COUNTRIES[c] ?? c);

/**
 * 「韩国」「韩剧」「韩」「KR」「港剧」「国产」→ 国家 / 地区代码。认不出返回空数组
 */
export function countryCodesOf(query: string): string[] {
  const raw = query.trim();
  if (/^[a-z]{2}$/i.test(raw)) return [raw.toUpperCase()];
  const q = raw.replace(/(?:剧|片|电影|影视|国)$/u, "") || raw;
  if (COUNTRY_ALIASES[q]) return COUNTRY_ALIASES[q];
  if (COUNTRY_ALIASES[raw]) return COUNTRY_ALIASES[raw];
  // 名字整个对上的优先：「印度」不连「印度尼西亚」一起算
  const exact = Object.entries(COUNTRIES).filter(([, name]) => name === raw || name === q);
  const hits = exact.length ? exact : Object.entries(COUNTRIES).filter(([, name]) => name.includes(q));
  return hits.map(([code]) => code);
}

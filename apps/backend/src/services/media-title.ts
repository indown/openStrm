const QUALITY_TOKENS = [
  "2160p",
  "1080p",
  "720p",
  "480p",
  "2160",
  "1080",
  "720",
  "480",
  "4320",
  "4k",
  "8k",
  "uhd",
  "hdr",
  "hdr10",
  "hdr10+",
  "sdr",
  "dolby",
  "dovi",
  "dv",
  "10bit",
  "8bit",
  "bluray",
  "blu-ray",
  "remux",
  "web-dl",
  "webdl",
  "webrip",
  "web",
  "hdtv",
  "hdrip",
  "dvdrip",
  "bdrip",
  "brrip",
  "x264",
  "x265",
  "h264",
  "h265",
  "hevc",
  "avc",
  "aac",
  "ac3",
  "eac3",
  "flac",
  "dts",
  "dts-hd",
  "truehd",
  "atmos",
  "ddp",
  "ddp5",
  "dd5",
  "5.1",
  "7.1",
  "2.0",
  "repack",
  "proper",
  "limited",
  "extended",
  "unrated",
  "imax",
  "internal",
  "rerip",
  "complete",
  "subbed",
  "dubbed",
  "multi",
  "multisub",
  "amzn",
  "nflx",
  "nf",
  "hmax",
  "hulu",
  "dsnp",
  "dsny",
  "disney",
  "aptv",
  "atvp",
  "atv",
  "ami",
  "pcok",
  "国语",
  "粤语",
  "中字",
  "双语",
  "简中",
  "繁中",
  "简繁",
  "内封",
  "内嵌",
  "外挂",
];

const QUALITY_TOKEN_SET = new Set(QUALITY_TOKENS.map((t) => t.toLowerCase()));

const RE_SEASON_WITH_OPT_EP = /^s(\d{1,2})(?:e\d{1,3})?$/;
const RE_SEASON_RANGE = /^s(\d{1,2})-s\d{1,2}$/;
const RE_CN_SEASON = /^第([一二三四五六七八九十\d]+)季$/;
const RE_EP_SINGLE = /^e\d{1,3}$/;
const RE_EP_RANGE = /^e\d{1,3}-e\d{1,3}$/;
const RE_TECH_GROUP = /^(.+?)-([A-Za-z0-9@_]{2,})$/;
const RE_YEAR = /^(19|20)\d{2}$/;

export interface NormalizedTitle {
  title: string;
  year: string;
  isTv: boolean;
  season: number;
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function parseCnOrArabicInt(s: string): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  if (s.startsWith("十") && s.length === 2) {
    const d = CN_DIGITS[s[1]];
    return d !== undefined ? 10 + d : null;
  }
  if (s.endsWith("十") && s.length === 2) {
    const d = CN_DIGITS[s[0]];
    return d !== undefined ? d * 10 : null;
  }
  if (s.length === 3 && s[1] === "十") {
    const tens = CN_DIGITS[s[0]];
    const ones = CN_DIGITS[s[2]];
    if (tens !== undefined && ones !== undefined) return tens * 10 + ones;
  }
  const d = CN_DIGITS[s];
  return d !== undefined ? d : null;
}

// Cutoff-based parser inspired by Sonarr/Radarr/guessit: scan left-to-right,
// the first tech/season/episode token is the title terminator — everything after
// is noise (resolution, codec, audio, platform, release group, etc.)
export function normalizeTitle(raw: string): NormalizedTitle {
  if (!raw) return { title: "", year: "", isTv: false, season: 0 };
  let s = raw.trim();

  // Strip bracket characters but keep their content (e.g., "(2013)" → " 2013 ")
  s = s.replace(/[[\]()【】（）]/g, " ");

  const tokens = s.split(/[\s._]+/).filter(Boolean);

  let cutoffIdx = tokens.length;
  let isTv = false;
  let season = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const lower = tok.toLowerCase();

    // Single season or SxxExx
    const seM = lower.match(RE_SEASON_WITH_OPT_EP);
    if (seM) {
      cutoffIdx = i;
      isTv = true;
      season = Number(seM[1]);
      break;
    }
    // Season range: "S01-S05"
    const seRange = lower.match(RE_SEASON_RANGE);
    if (seRange) {
      cutoffIdx = i;
      isTv = true;
      season = Number(seRange[1]);
      break;
    }
    // Chinese season: "第一季" / "第1季" / "第10季"
    const cnSeasonM = tok.match(RE_CN_SEASON);
    if (cnSeasonM) {
      const n = parseCnOrArabicInt(cnSeasonM[1]);
      if (n !== null && n > 0) {
        cutoffIdx = i;
        isTv = true;
        season = n;
        break;
      }
    }
    if (RE_EP_SINGLE.test(lower) || RE_EP_RANGE.test(lower)) {
      cutoffIdx = i;
      isTv = true;
      break;
    }
    if (QUALITY_TOKEN_SET.has(lower)) {
      cutoffIdx = i;
      break;
    }
    // "x264-DEMAND" / "AAC-PTHweb" — tech token with release group suffix
    const hyphenMatch = tok.match(RE_TECH_GROUP);
    if (hyphenMatch && QUALITY_TOKEN_SET.has(hyphenMatch[1].toLowerCase())) {
      cutoffIdx = i;
      break;
    }
  }

  // Find year: prefer one immediately before cutoff (so it's stripped from title).
  // Fallback to anywhere after cutoff (e.g., "Name.S01-S05.(2013)" has year in trailing noise).
  let year = "";
  let yearIdx = -1;
  for (let i = cutoffIdx - 1; i >= 0; i--) {
    if (RE_YEAR.test(tokens[i])) {
      year = tokens[i];
      yearIdx = i;
      break;
    }
  }
  if (!year) {
    for (let i = cutoffIdx; i < tokens.length; i++) {
      if (RE_YEAR.test(tokens[i])) {
        year = tokens[i];
        break;
      }
    }
  }

  let titleEnd = cutoffIdx;
  if (yearIdx !== -1) {
    const hasTechAfter = cutoffIdx < tokens.length;
    const isYearImmediatelyBeforeCutoff = yearIdx === cutoffIdx - 1;
    const isYearAtTailNoTech = cutoffIdx === tokens.length && yearIdx === tokens.length - 1;
    if ((hasTechAfter && isYearImmediatelyBeforeCutoff) || isYearAtTailNoTech) {
      titleEnd = yearIdx;
    }
  }

  const title = tokens
    .slice(0, titleEnd)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^[-–—\s]+|[-–—\s]+$/g, "")
    .trim();

  return { title: title || raw.trim(), year, isTv, season };
}

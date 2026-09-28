/**
 * 影库条目拿什么名字去认作品。
 *
 * 子目录条目的目录名可能只是季目录（`Season 2`、`第二季`）、版本词（`导演剪辑版`）或花絮目录，
 * 拿它去 TMDB 搜，只会搜出一部真叫这个名字的片子，或者什么都搜不到。顺着分享路径往上，
 * 找第一个像作品名的目录去认；往上跳过的那几层留作后缀，标题带上它——同一部剧加了两季，
 * 两张卡不至于一模一样。
 */
import type { MediaLibraryEntry } from "@openstrm/shared";
import { isEditionOnlyName, isExtrasDirName, seasonDirNumber } from "../organize/parse-name.js";

export interface LibraryName {
  /** 拿去解析、搜索的名字 */
  query: string;
  /** 往上跳过的那几层（`Season 2`），没跳就是空串 */
  suffix: string;
  /** 跳过的里面有季目录：多半是剧 */
  tv: boolean;
}

/** 目录名本身不是作品名：季、版本、花絮 */
const isPlaceholderDir = (name: string): boolean =>
  seasonDirNumber(name) !== null || isEditionOnlyName(name) || isExtrasDirName(name);

export function libraryNameOf(entry: Pick<MediaLibraryEntry, "rawName" | "title" | "sharePath">): LibraryName {
  const own = entry.rawName || entry.title || "";
  // 子目录条目的 sharePath 最后一段就是它自己；整个分享的条目没有路径
  const segs = (entry.sharePath ?? "").split("/").map((s) => s.trim()).filter(Boolean);
  let i = segs.length - 1;
  while (i > 0 && isPlaceholderDir(segs[i])) i--;
  if (i < 0 || i === segs.length - 1) return { query: own, suffix: "", tv: false };
  const skipped = segs.slice(i + 1);
  return { query: segs[i], suffix: skipped.join(" "), tv: skipped.some((s) => seasonDirNumber(s) !== null) };
}

/** 认出来的标题带上跳过的那几层：`怒呛人生 · Season 2` */
export function withSuffix(title: string, suffix: string): string {
  return title && suffix ? `${title} · ${suffix}` : title;
}

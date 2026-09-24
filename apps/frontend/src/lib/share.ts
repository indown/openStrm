import type { DriveKind } from "./api";
import { looksLikeOfflineLink } from "./offline";

/**
 * 115 不带网址的分享码：`sw` 开头、一共 11 位、全是小写字母和数字而且至少有一个数字（swzjt593ztd），可以带「-提取码」。
 * 后端的解析连任何纯字母数字的词都当 115 分享码认（`dune` 也算）；前端要判断输入的是分享还是搜索词，得比它严，
 * 不然 Swordfish、switchblade 这种英文片名会被当成分享码打开
 */
const BARE_115_CODE = /^sw(?=[a-z0-9]*\d)[a-z0-9]{9}(?:-[a-z0-9]{4})?$/;

/** 从分享链接认出是哪家网盘的；认不出返回 null。网址的口径和后端 services/drive/registry.ts 的 parseShareRef 一致 */
export function shareKindOf(url: string | null | undefined): DriveKind | null {
  const u = (url ?? "").trim();
  if (!u) return null;
  if (/pan\.quark\.cn\/s\//i.test(u)) return "quark";
  if (/^https?:\/\/(?:[\w-]+\.)*(?:115\.com|115cdn\.com|anxia\.com)\//i.test(u)) return "115";
  if (BARE_115_CODE.test(u)) return "115";
  return null;
}

/**
 * 输入框里的这段是不是分享（而不是搜索词）：认得出的分享链接，或者一段话里带着分享链接（「链接：… 提取码：…」这种）。
 * 两用的输入框（顶栏、资源搜索页）按它决定是打开转存框还是去搜
 */
export function looksLikeShare(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (shareKindOf(t)) return true;
  return /https?:\/\/(?:[\w-]+\.)*(?:pan\.quark\.cn|115\.com|115cdn\.com|anxia\.com)\/s\//i.test(t);
}

/** 别家网盘的分享页：看着是 http 链接，交给云下载也只会下到一个网页 */
const OTHER_DRIVE_SHARE =
  /https?:\/\/(?:[\w-]+\.)*(?:pan\.baidu\.com|yun\.baidu\.com|aliyundrive\.com|alipan\.com|123pan\.com|123pan\.cn|123684\.com|123865\.com|123912\.com|drive\.uc\.cn|pan\.xunlei\.com|cloud\.189\.cn|caiyun\.139\.com|yun\.139\.com|mypikpak\.com|lanzou[a-z]?\.com|lanzn\.com|ilanzou\.com)\//i;

/**
 * 输入框里打的是什么：分享（打开转存框）、磁力 / 电驴 / 下载链接（交给云下载）、认不出的链接（说一声，不去搜）、
 * 别的都当片名去搜。顶栏、⌘K、资源搜索页共用。
 * 带着「xxx://」的都不当片名：拿网址去 PanSou 搜只会「没搜到」，还会记进最近搜索
 */
export type InputKind = "share" | "offline" | "unsupported" | "search";

export function inputKindOf(text: string): InputKind {
  const t = text.trim();
  if (looksLikeShare(t)) return "share";
  if (looksLikeOfflineLink(t)) return "offline";
  // http(s)、ftp 的下载链接交给云下载（和 Telegram 里一样）；别家网盘的分享页不行
  if (/(?:https?|ftp):\/\//i.test(t)) return OTHER_DRIVE_SHARE.test(t) ? "unsupported" : "offline";
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(t)) return "unsupported";
  return "search";
}

/** 认不出的链接怎么说 */
export function unsupportedInputMessage(text: string): string {
  return OTHER_DRIVE_SHARE.test(text)
    ? "这是别家网盘的分享，这里接不住：能转存的只有 115 和夸克的分享"
    : "认不出这种链接：能收的有 115 / 夸克分享、磁力、ed2k，以及 http(s)、ftp 的下载链接";
}

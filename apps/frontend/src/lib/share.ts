import type { DriveKind } from "./api";

/** 从分享链接认出是哪家网盘的；认不出返回 null。和后端 services/drive/registry.ts 的 parseShareRef 口径一致 */
export function shareKindOf(url: string | null | undefined): DriveKind | null {
  const u = (url ?? "").trim();
  if (!u) return null;
  if (/pan\.quark\.cn\/s\//i.test(u)) return "quark";
  if (/^https?:\/\/(?:[\w-]+\.)*(?:115\.com|115cdn\.com|anxia\.com)\//i.test(u)) return "115";
  return null;
}

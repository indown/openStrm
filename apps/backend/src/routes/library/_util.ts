export function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function sanitizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 115 cid 可能超过 JS 安全整数，统一以字符串存储 */
export function shareRootCidForDb(cid: unknown): string {
  if (typeof cid === "string") return cid.trim();
  if (typeof cid === "number" && Number.isFinite(cid)) return String(cid);
  return "";
}

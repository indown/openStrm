/** 文件大小：字节 → 人读得懂的单位；0 或没有就画个横 */
export function formatSize(bytes?: number | null): string {
  if (bytes == null || bytes <= 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 毫秒时间戳 → 本地时间；没有就画个横 */
export function fmtTime(ms?: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

/**
 * 毫秒时间戳 → 一眼能分清先后的短写法：今天 / 昨天只给时分，今年给月日，更早才带年份。
 * 列表里几条长得一样的记录（同一个任务、同一个范围）靠它区分，完整时间挂在 title 上
 */
export function fmtWhen(ms?: number | null): string {
  if (!ms) return "-";
  const d = new Date(ms);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return `今天 ${hm}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yesterday)) return `昨天 ${hm}`;
  const md = `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()} 年 ${md}`;
}

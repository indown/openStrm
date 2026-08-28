/**
 * 有界并发的 map：同时最多 limit 个 fn 在跑，结果按输入顺序返回。
 * 任一 fn 抛出就整体 reject——需要"单项失败不影响其余"的调用方自己在 fn 里 try/catch。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

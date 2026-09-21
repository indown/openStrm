/**
 * 按来源限流、计数时用的键。
 *
 *   - IPv4 原样；IPv4 映射的 IPv6（::ffff:1.2.3.4，双栈监听时常见）按里面那个 IPv4 算。
 *   - 其它 IPv6 取前 64 位：一户人家、一台 VPS 分到的通常是一整个 /64，按单个地址算的话，
 *     换个地址（随手就能换出几十亿个）就把每个地址一份的额度绕过去了。
 *   - 认不出的原样返回（不该出现，出现了也只是自己一个桶）。
 */
import net from "node:net";

export function ipKey(ip: string): string {
  const addr = ip.trim().split("%")[0];
  if (net.isIP(addr) !== 6) return addr;
  const groups = expandIPv6(addr);
  if (!groups) return addr;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** 把 IPv6 展开成 8 组 16 位整数（:: 补零、结尾内嵌的 IPv4 拆成两组）；格式不对返回 null */
function expandIPv6(addr: string): number[] | null {
  let s = addr.toLowerCase();
  const tail: number[] = [];
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    s = s.slice(0, v4.index);
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const hex = (part: string) => (part ? part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)) : []);
  const head = hex(halves[0]);
  const rest = halves.length === 2 ? hex(halves[1]) : [];
  const zeros = 8 - tail.length - head.length - rest.length;
  if (zeros < 0 || (halves.length === 1 && zeros !== 0)) return null;
  const all = [...head, ...new Array<number>(halves.length === 2 ? zeros : 0).fill(0), ...rest, ...tail];
  return all.length === 8 && all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : null;
}

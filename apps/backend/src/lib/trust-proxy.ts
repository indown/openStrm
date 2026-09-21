/**
 * 放在反代 / Tunnel 后面时设 TRUST_PROXY，request.ip 才取 X-Forwarded-For——登录退避、公网上的限流都按来源分桶，
 * 不设的话所有人共用反代那一个桶。取值：
 *   true      信任本机和内网来的代理（回环、链路本地、私有网段）：反代、cloudflared 和 OpenStrm 在同一台机器、
 *             同一个局域网或 docker 网络里时用这个。X-Forwarded-For 从右往左，取第一个不是这些地址的——
 *             反代往后追加了真实地址时，客户端自己塞在左边的写什么都没用
 *   数字 N    信任最近的 N 跳（前面还套了一层公网上的代理，比如 CDN → nginx → OpenStrm 就是 2）
 *   其它      逗号分隔的代理地址 / 网段（比如 10.0.0.2, 172.18.0.0/16）
 * 前提：OpenStrm 的端口不能绕过这些代理直接从公网连上。能直接连的话，数字 N 会把连进来的人当成代理；
 * docker 的端口转发在有些情况下（IPv6 连到只有 IPv4 的容器、rootless / Docker Desktop）会把外面的来源换成网关的内网地址，
 * true 也会把它当成代理——两种都等于来源能伪造。发布端口时绑到 127.0.0.1 或局域网地址，或者用防火墙挡住。
 * 连接自检的「来源地址」一项会用一个哨兵地址查「信任过头」。
 * 以前 true 是「谁都信」：客户端在 X-Forwarded-For 最左边随便写个地址，按来源的限流就都形同虚设
 */
export function trustProxyOption(raw: string | undefined): boolean | number | string {
  const v = raw?.trim();
  if (!v || v === "false" || v === "0") return false;
  if (v === "true") return "loopback, linklocal, uniquelocal";
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * 通用的安全响应头。多数人的管理界面直接放在公网域名上（和智能体接入共用一个域名），这几样是公网管理界面的标配：
 *   - 防点击劫持：别人的网页不能把管理界面嵌进去诱导你点（HTML 响应才加）。默认只许同源嵌入（SAMEORIGIN）；
 *     把 OpenStrm 嵌进导航页、仪表盘的，用环境变量 FRAME_ANCESTORS 放开：写允许嵌入它的地址（空格或逗号分隔），
 *     写 * 不限制，只写 'none' 就谁都不许嵌。写错的项启动时记一条警告、跳过，不会把整个管理界面弄挂。
 *   - X-Content-Type-Options: nosniff、Referrer-Policy：所有响应。
 * 路由自己设过的不覆盖（授权页有更严的 frame-ancestors 'none'、no-referrer）。HSTS 交给反代 / Cloudflare：
 * 局域网里走 http 的访问不能带它。
 */
import fp from "fastify-plugin";

export interface FrameHeaders {
  xFrameOptions?: string;
  csp?: string;
}

const SAME_ORIGIN: FrameHeaders = { xFrameOptions: "SAMEORIGIN", csp: "frame-ancestors 'self'" };

/**
 * FRAME_ANCESTORS 里的一项转成 CSP 的来源写法：'self'、https: / http:、[http(s)://][*.]主机[:端口]。
 * 国际化域名转 punycode（响应头里只能是 ASCII）；认不出的返回 null
 */
function frameSource(token: string): string | null {
  if (token === "'self'") return token;
  if (/^https?:$/i.test(token)) return token.toLowerCase();
  const m = /^(?:(https?):\/\/)?(\*\.)?([^/:?#\s;'",]+)(?::(\d{1,5}|\*))?\/?$/i.exec(token);
  if (!m) return null;
  const [, scheme, wildcard, host, port] = m;
  let ascii: string;
  try {
    ascii = new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(ascii)) return null;
  return `${scheme ? `${scheme.toLowerCase()}://` : ""}${wildcard ?? ""}${ascii}${port ? `:${port}` : ""}`;
}

/** FRAME_ANCESTORS 解析成要加的头：没设只许同源；* 不限制；'none' 谁都不许；别的是 'self' 加上允许嵌入的来源 */
export function frameHeaders(raw: string | undefined, warn: (message: string) => void = () => {}): FrameHeaders {
  const tokens = (raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) return SAME_ORIGIN;
  if (tokens.includes("*")) {
    if (tokens.length > 1) warn("FRAME_ANCESTORS 里有 *：不限制谁来嵌入，别的几项不起作用");
    return {};
  }
  if (tokens.includes("'none'")) {
    if (tokens.length > 1) warn("FRAME_ANCESTORS 里的 'none' 只能单独写：按谁都不许嵌入处理，别的几项不起作用");
    return { xFrameOptions: "DENY", csp: "frame-ancestors 'none'" };
  }
  const sources = new Set<string>(["'self'"]);
  for (const token of tokens) {
    const source = frameSource(token);
    if (source) sources.add(source);
    else warn(`FRAME_ANCESTORS 里的「${token}」不是合法的来源（写 https://home.example.com 这样的地址），跳过`);
  }
  // 一项都没认出来：按默认的只许同源
  if (sources.size === 1) return SAME_ORIGIN;
  // X-Frame-Options 写不了列表：只给 CSP（现在的浏览器都认 frame-ancestors）
  return { csp: `frame-ancestors ${[...sources].join(" ")}` };
}

export const securityHeadersPlugin = fp(
  async (fastify, opts: { frameAncestors?: string }) => {
    const frame = frameHeaders(opts.frameAncestors, (message) => fastify.log.warn(message));
    fastify.addHook("onSend", async (_request, reply, payload) => {
      if (!reply.hasHeader("x-content-type-options")) void reply.header("x-content-type-options", "nosniff");
      if (!reply.hasHeader("referrer-policy")) void reply.header("referrer-policy", "strict-origin-when-cross-origin");
      if (String(reply.getHeader("content-type") ?? "").startsWith("text/html")) {
        if (frame.xFrameOptions && !reply.hasHeader("x-frame-options")) void reply.header("x-frame-options", frame.xFrameOptions);
        if (frame.csp && !reply.hasHeader("content-security-policy")) void reply.header("content-security-policy", frame.csp);
      }
      return payload;
    });
  },
  { name: "security-headers" },
);

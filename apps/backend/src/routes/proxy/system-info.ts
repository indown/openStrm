/**
 * System/Info 端口改写 + web 播放器补丁。
 *
 * 两件事都是 nginx 时代无条件生效的 location，不做的话 302 在实际使用中会翻车：
 *
 * 1. System/Info 里带着 Emby 自己的端口（8096）。客户端拿到之后会直接连过去，
 *    绕开代理，302 自然就不生效了。要把端口换成代理的端口。
 *    对应 system-handler.js 的 systemInfoHandler。
 *
 * 2. web 端播放器对 IsRemote 的媒体源会加 crossorigin="anonymous"，
 *    而 115 直链不带 CORS 头，浏览器直接拒绝播放。把那段判断改掉。
 *    对应 redirect-core.js 的 modifyBaseHtmlPlayer。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { embyUpstream } from "../../services/emby/api.js";
import { applyForwardedHeaders, toEmby } from "./upstream.js";

const UPSTREAM_TIMEOUT_MS = 15_000;

async function fetchUpstream(request: FastifyRequest): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const headers = applyForwardedHeaders(request, {
      ...(request.headers as Record<string, string | string[] | undefined>),
    });
    delete headers["content-length"];
    delete headers["accept-encoding"];
    return await fetch(`${embyUpstream()}${request.url}`, {
      method: "GET",
      headers: headers as Record<string, string>,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 把 body 里所有出现的上游端口换成代理端口 */
export function swapPorts(
  body: Record<string, unknown>,
  fromPort: number,
  toPort: number,
): Record<string, unknown> {
  if (!fromPort || !toPort || fromPort === toPort) return body;

  const swapString = (value: unknown): unknown =>
    typeof value === "string" ? value.replace(String(fromPort), String(toPort)) : value;

  if (typeof body.WebSocketPortNumber === "number") body.WebSocketPortNumber = toPort;
  if (typeof body.HttpServerPortNumber === "number") body.HttpServerPortNumber = toPort;

  for (const key of ["LocalAddress", "WanAddress", "RemoteAddress"]) {
    body[key] = swapString(body[key]);
  }
  for (const key of ["LocalAddresses", "RemoteAddresses"]) {
    const list = body[key];
    if (Array.isArray(list)) body[key] = list.map(swapString);
  }
  return body;
}

function proxyPort(request: FastifyRequest): number {
  const address = request.server.server.address();
  if (address && typeof address === "object") return address.port;
  // 拿不到就退回配置值，别把 body 改坏
  return Number(process.env.PROXY_PORT) || 8091;
}

async function handleSystemInfo(request: FastifyRequest, reply: FastifyReply) {
  try {
    const upstream = await fetchUpstream(request);
    if (!upstream.ok) return toEmby(request, reply);

    const body = (await upstream.json()) as Record<string, unknown>;
    const originPort = Number(body.WebSocketPortNumber ?? body.HttpServerPortNumber ?? 0);
    swapPorts(body, originPort, proxyPort(request));

    return reply.type("application/json;charset=utf-8").send(JSON.stringify(body));
  } catch (err) {
    request.log.error({ err }, "System/Info 改写失败，回源");
    return toEmby(request, reply);
  }
}

/**
 * web 播放器里这段判断会给远端源加 crossorigin，把它整体替成 null。
 * Emby 每个版本的压缩产物变量名可能不同，所以用宽松一点的正则。
 */
const CROSSORIGIN_PATTERN =
  /(\w+)\.IsRemote\s*&&\s*"DirectPlay"\s*===\s*(\w+)\s*\?\s*null\s*:\s*"anonymous"/g;

async function handleBaseHtmlPlayer(request: FastifyRequest, reply: FastifyReply) {
  try {
    const upstream = await fetchUpstream(request);
    if (!upstream.ok) return toEmby(request, reply);

    const source = await upstream.text();
    const patched = source.replace(CROSSORIGIN_PATTERN, "null");
    if (patched === source) {
      request.log.warn("basehtmlplayer 未匹配到 crossorigin 判断，可能 Emby 版本变了");
    }

    return reply
      .type(upstream.headers.get("content-type") ?? "application/javascript")
      .send(patched);
  } catch (err) {
    request.log.error({ err }, "basehtmlplayer 改写失败，回源");
    return toEmby(request, reply);
  }
}

export default async function systemInfoRoutes(fastify: FastifyInstance) {
  for (const prefix of ["", "/emby"]) {
    for (const variant of ["System", "system"]) {
      for (const info of ["Info", "info"]) {
        fastify.get(`${prefix}/${variant}/${info}`, handleSystemInfo);
      }
    }
    fastify.get(
      `${prefix}/web/modules/htmlvideoplayer/basehtmlplayer.js`,
      handleBaseHtmlPlayer,
    );
  }
}

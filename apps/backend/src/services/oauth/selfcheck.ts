/**
 * 连接自检：从服务器自己这边去请求公网地址，逐项看网页客户端要走的路通不通，给配反代 / Tunnel 的人用。
 *   1. 受保护资源元数据；2. 授权服务器元数据；3. 不带令牌的 /mcp 应该回 401 并指到元数据；
 *   4、5. 管理界面和 /api 从公网地址应该访问不到（404）；
 *   6. 开了 CIMD 的话，本机能不能取到 claude.ai、ChatGPT 的客户端元数据（取不到它们就连不上）。
 * 服务器访问不到自己的公网地址也可能只是网络不支持「回环访问」，不代表外面访问不到，结果里照实说。
 */
import type { AgentSelfCheckItem } from "@openstrm/shared";
import { readAppSetting } from "../../db/repositories/settings.js";
import { MCP_PATH } from "../agent/access.js";
import { fetchClientMetadata } from "./cimd.js";
import { WELL_KNOWN_AS, WELL_KNOWN_PRM, publicBaseUrl } from "./config.js";
import { OAuthError } from "./errors.js";

/** 两家网页客户端的 CIMD 元数据地址（2026-09 核实） */
const KNOWN_CIMD = [
  ["claude.ai", "https://claude.ai/oauth/mcp-oauth-client-metadata"],
  ["ChatGPT", "https://chatgpt.com/oauth/client.json"],
] as const;

const TIMEOUT_MS = 8000;

interface Probe {
  status: number;
  headers: Headers;
  json: unknown;
}

async function probe(url: string, init: RequestInit = {}): Promise<Probe> {
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json };
}

const unreachable = (url: string, err: unknown) =>
  `访问不到 ${url}：${err instanceof Error ? err.message : String(err)}。也可能只是服务器访问不了自己的公网地址（网络不支持回环访问），用手机流量打开这个地址试试`;

export async function runSelfCheck(): Promise<AgentSelfCheckItem[]> {
  const base = publicBaseUrl();
  if (!base) return [{ name: "公网地址", ok: false, detail: "还没填公网地址：网页客户端（claude.ai、ChatGPT）要从公网连过来" }];
  const items: AgentSelfCheckItem[] = [];
  if (readAppSetting("agent")?.enabled !== true) {
    items.push({ name: "智能体接入", ok: false, detail: "还没开启：外面连进来都是 404" });
  }

  const prmUrl = `${base}${WELL_KNOWN_PRM}${MCP_PATH}`;
  try {
    const r = await probe(prmUrl);
    const resource = (r.json as { resource?: unknown } | null)?.resource;
    const ok = r.status === 200 && resource === `${base}${MCP_PATH}`;
    items.push({
      name: "受保护资源元数据",
      ok,
      detail: ok ? prmUrl : `回了 ${r.status}${resource ? `，resource 是 ${String(resource)}` : ""}：反代 / Tunnel 要放行 /.well-known/oauth-protected-resource 这几个路径`,
    });
  } catch (err) {
    items.push({ name: "受保护资源元数据", ok: false, detail: unreachable(prmUrl, err) });
  }

  const asUrl = `${base}${WELL_KNOWN_AS}`;
  try {
    const r = await probe(asUrl);
    const issuer = (r.json as { issuer?: unknown } | null)?.issuer;
    const ok = r.status === 200 && issuer === base;
    items.push({ name: "授权服务器元数据", ok, detail: ok ? asUrl : `回了 ${r.status}：反代 / Tunnel 要放行 /.well-known/oauth-authorization-server` });
  } catch (err) {
    items.push({ name: "授权服务器元数据", ok: false, detail: unreachable(asUrl, err) });
  }

  const mcpUrl = `${base}${MCP_PATH}`;
  try {
    const r = await probe(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const challenge = r.headers.get("www-authenticate") ?? "";
    const ok = r.status === 401 && challenge.includes("resource_metadata=");
    items.push({
      name: "MCP 地址",
      ok,
      detail: ok ? `${mcpUrl}（不带令牌回 401，指到了元数据）` : `回了 ${r.status}：反代 / Tunnel 要放行 POST /mcp，并且别缓冲流式响应`,
    });
  } catch (err) {
    items.push({ name: "MCP 地址", ok: false, detail: unreachable(mcpUrl, err) });
  }

  for (const [name, path] of [
    ["管理界面不在公网上", "/"],
    ["管理接口不在公网上", "/api/task"],
  ] as const) {
    const url = `${base}${path}`;
    try {
      const r = await probe(url);
      const ok = r.status === 404;
      items.push({ name, ok, detail: ok ? `${url} 回 404` : `${url} 回了 ${r.status}：这个域名下应该只放行智能体用的几个路径` });
    } catch (err) {
      items.push({ name, ok: false, detail: unreachable(url, err) });
    }
  }

  if (readAppSetting("agent")?.oauthCimd === true) {
    for (const [client, url] of KNOWN_CIMD) {
      try {
        await fetchClientMetadata(url);
        items.push({ name: `取 ${client} 的客户端元数据（CIMD）`, ok: true, detail: url });
      } catch (err) {
        items.push({
          name: `取 ${client} 的客户端元数据（CIMD）`,
          ok: false,
          detail: `${err instanceof OAuthError ? err.forHuman : String(err)}（${url}）`,
        });
      }
    }
  }
  return items;
}

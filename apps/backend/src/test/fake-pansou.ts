/**
 * 假 PanSou：资源搜索的测试共用。起一个本地 HTTP 服务，按 PanSou 的接口形状回话（/api/search、/api/health、
 * /api/check/links、/api/auth/login），记下每次请求，能开登录、能按第几次搜索回不同的结果、能延迟、能回错误码。
 *
 * 默认套 `{ code: 0, message, data }` 的壳（实测是套的）；wrap = false 回裸对象（文档里写的那种）。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakePansouRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
  /** 回话之前对面就断开了（调用方掐掉了这一问） */
  aborted?: boolean;
}

/** 直接给数据（按 200 + 壳回），或者指定状态码 / 原样的 body / 延迟 */
export type FakeReply = Record<string, unknown> | { status: number; raw: unknown; delayMs?: number } | { delayMs: number; data: Record<string, unknown> };

export type FakeLink = { url: string; password?: string; note?: string; datetime?: string; source?: string };

function parseBody(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class FakePansou {
  readonly requests: FakePansouRequest[] = [];
  /** 开登录：用户名 → 密码；null 是没开 */
  users: Record<string, string> | null = null;
  /** 登录发的令牌多久过期（秒，按 PanSou 的 expires_at 写法） */
  tokenTtlSeconds = 24 * 3600;
  /** 登录接口慢多少毫秒回（测并发的请求一起等同一次登录） */
  loginDelayMs = 0;
  /** 登录接口不管对错都这么回（测前面的防护、限流拦下登录） */
  loginReply: { status: number; raw: unknown } | null = null;
  /** health 回 502（测 health 读不到的时候） */
  healthDown = false;
  wrap = true;
  health: { plugins: string[]; channels: string[] } = { plugins: ["plugin-a"], channels: ["chan-a"] };
  /** 第 nth 次搜索（从 1 起数，含预热）回什么：给 merged_by_type 的内容就行 */
  onSearch: (body: Record<string, unknown>, nth: number) => Record<string, FakeLink[]> | FakeReply = () => ({});
  /** null：老版本，没有检测接口（404） */
  onCheck: ((items: Array<{ disk_type: string; url: string; password?: string }>) => FakeReply) | null = (items) => ({
    results: items.map((i) => ({ disk_type: i.disk_type, url: i.url, state: "ok", summary: "链接有效" })),
  });
  searchCount = 0;
  url = "";

  private readonly tokens = new Set<string>();
  private readonly server = http.createServer((req, res) => this.handle(req, res));

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.requests.length = 0;
    this.tokens.clear();
    this.users = null;
    this.tokenTtlSeconds = 24 * 3600;
    this.loginDelayMs = 0;
    this.loginReply = null;
    this.healthDown = false;
    this.wrap = true;
    this.health = { plugins: ["plugin-a"], channels: ["chan-a"] };
    this.onSearch = () => ({});
    this.onCheck = (items) => ({ results: items.map((i) => ({ disk_type: i.disk_type, url: i.url, state: "ok", summary: "链接有效" })) });
    this.searchCount = 0;
  }

  /** 让已发出去的令牌全部失效（模拟 PanSou 重启换了签名密钥） */
  revokeTokens(): void {
    this.tokens.clear();
  }

  searches(): FakePansouRequest[] {
    return this.requests.filter((r) => r.path === "/api/search");
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const body = parseBody(raw);
      const record: FakePansouRequest = { method: req.method ?? "GET", path: url.pathname, headers: req.headers, body };
      this.requests.push(record);
      res.on("close", () => {
        if (!res.writableFinished) record.aborted = true;
      });
      void this.route(url.pathname, req, body).then((reply) => this.send(res, reply));
    });
  }

  private async route(path: string, req: http.IncomingMessage, body: Record<string, unknown>): Promise<{ status: number; body: unknown; delayMs?: number }> {
    if (path === "/api/health") {
      if (this.healthDown) return { status: 502, body: "<html>502 Bad Gateway</html>" };
      return this.ok({ status: "ok", auth_enabled: this.users !== null, plugins_enabled: true, plugin_count: this.health.plugins.length, ...this.health, channels_count: this.health.channels.length }, false);
    }
    if (path === "/api/auth/login") {
      if (this.loginReply) return { status: this.loginReply.status, body: this.loginReply.raw };
      const user = String(body.username ?? "");
      if (!this.users || this.users[user] === undefined || this.users[user] !== String(body.password ?? "")) {
        return { status: 401, body: { error: "用户名或密码错误" } };
      }
      const token = `tok-${this.tokens.size + 1}-${Math.random().toString(36).slice(2)}`;
      this.tokens.add(token);
      return { status: 200, body: { token, expires_at: Math.floor(Date.now() / 1000) + this.tokenTtlSeconds, username: user }, delayMs: this.loginDelayMs };
    }
    // 先按路由找，找不到就 404（真 PanSou 是先路由、再在路由组上查登录）
    if (path !== "/api/search" && path !== "/api/check/links") return { status: 404, body: "404 page not found" };
    if (this.users !== null) {
      const auth = String(req.headers.authorization ?? "");
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token) return { status: 401, body: { error: "未授权：缺少认证令牌", code: "AUTH_TOKEN_MISSING" } };
      if (!this.tokens.has(token)) return { status: 401, body: { error: "未授权：令牌无效或已过期", code: "AUTH_TOKEN_INVALID" } };
    }
    if (path === "/api/search") {
      this.searchCount += 1;
      const reply = this.onSearch(body, this.searchCount);
      return this.toReply(reply, (data) => {
        const merged = data as Record<string, FakeLink[]>;
        const total = Object.values(merged).reduce((n, l) => n + l.length, 0);
        return { total, merged_by_type: merged };
      });
    }
    if (path === "/api/check/links") {
      if (!this.onCheck) return { status: 404, body: "404 page not found" };
      return this.toReply(this.onCheck((body.items as Array<{ disk_type: string; url: string; password?: string }>) ?? []), (d) => d);
    }
    return { status: 404, body: "404 page not found" };
  }

  private toReply(reply: FakeReply | Record<string, FakeLink[]>, shape: (data: Record<string, unknown>) => Record<string, unknown>) {
    if ("status" in reply && "raw" in reply && typeof reply.status === "number") {
      return { status: reply.status, body: reply.raw, delayMs: typeof reply.delayMs === "number" ? reply.delayMs : undefined };
    }
    if ("delayMs" in reply && "data" in reply && typeof reply.delayMs === "number") {
      return { ...this.ok(shape(reply.data as Record<string, unknown>)), delayMs: reply.delayMs };
    }
    return this.ok(shape(reply as Record<string, unknown>));
  }

  /** health 不套壳（它自己就是裸的）；别的按 wrap 决定 */
  private ok(data: unknown, wrappable = true): { status: number; body: unknown } {
    return { status: 200, body: wrappable && this.wrap ? { code: 0, message: "success", data } : data };
  }

  private send(res: http.ServerResponse, reply: { status: number; body: unknown; delayMs?: number }): void {
    const write = () => {
      if (res.destroyed) return;
      const isText = typeof reply.body === "string";
      res.writeHead(reply.status, { "content-type": isText ? "text/plain" : "application/json" });
      res.end(isText ? (reply.body as string) : JSON.stringify(reply.body));
    };
    if (reply.delayMs) setTimeout(write, reply.delayMs);
    else write();
  }
}

/** 常用的几条链接：115 三个域名同一个分享、夸克带提取码、磁力带 tracker、百度 */
export const SAMPLE = {
  l115: { url: "https://115.com/s/swabc123xyz?password=u796", password: "u796", note: "名称: 沙丘2 4K 原盘", datetime: "2024-07-24T14:15:00Z", source: "tg:Lsp115" },
  l115anxia: { url: "https://anxia.com/s/swabc123xyz?password=u796", password: "u796", note: "沙丘2", datetime: "2025-01-01T04:32:44Z", source: "tg:Lsp115" },
  l115b: { url: "https://115cdn.com/s/swdef456uvw?password=6969", password: "6969", note: "沙丘2 1080P", datetime: "2025-05-23T23:28:09Z", source: "plugin:wanou" },
  quark: { url: "https://pan.quark.cn/s/4efe86519372", password: "", note: "沙丘2", datetime: "0001-01-01T00:00:00Z", source: "plugin:wanou" },
  quarkPwd: { url: "https://pan.quark.cn/s/157e84553650", password: "ab12", note: "沙丘2部合集 (2024) 4K", datetime: "2026-07-29T04:45:18Z", source: "tg:vip115hot" },
  magnet: {
    url: "magnet:?xt=urn:btih:B1CAF2A9C5CABC705B056C06DC5365F1EAF4C098&dn=Dune.Part.Two&tr=udp%3A%2F%2Ftracker.example%3A1337",
    password: "",
    note: "沙丘2-Dune.Part.Two.2024.1080p.WEBRip[1.6G]",
    datetime: "2024-12-26T00:00:00Z",
    source: "plugin:clxiong",
  },
  baidu: { url: "https://pan.baidu.com/s/1abcdef", password: "1234", note: "沙丘2 百度", datetime: "2023-06-10T14:23:45Z", source: "tg:BaiduCloudDisk" },
} satisfies Record<string, FakeLink>;

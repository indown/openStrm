/**
 * 代理层离线集成测试：起一个假 Emby，把整个 proxy 插件装起来跑真实请求。
 *
 * 115 那一段用 setLinkResolver 换掉，所以不需要真账号也能验证
 * 302 / 回源 / 缓存这几条分支——它们才是最容易写错的地方。
 *
 *   CONFIG_DIR=... DATA_DIR=... npx tsx src/routes/proxy/proxy.itest.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import Fastify from "fastify";
import { initDb } from "../../db/migrate.js";
import { readAppSettings, writeAppSettings } from "../../db/repositories/settings.js";
import proxyPlugin from "./index.js";
import { clearLinkCache, setLinkResolver } from "./redirect.js";
import { swapPorts, swapUrlPort } from "./system-info.js";

// 指向临时 CONFIG_DIR 时库还是空的，自己把迁移跑起来
await initDb();

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  pass++;
  console.log("  ok  " + name);
};

const MOUNT = "/mnt/pan";
const PAN_FILE = `${MOUNT}/tv/Show/ep1.mkv`;
const LOCAL_FILE = "/media/local/movie.mkv";
/**
 * 真实形态的 115 直链：文件名已经是转义过的，签名里带 `+` 和 `=`。
 * 这条链接必须**原样**出现在 Location 里——nginx 版本就是原样透传的。
 * 一旦对它再做一次 encodeURI，`%` 会变成 `%25`，CDN 直接 403。
 */
const DIRECT_URL =
  "https://cdn-qn.115.com/lab/%E4%B8%AD%E6%96%87%E5%90%8D.mkv?t=1&u=a%2Bb&sign=xY%3D%3D";
/** 混进非 ASCII 的异常直链，只有这种才需要转义 */
const UNICODE_URL = "https://cdn.115.com/直链?t=1";

// ---- 假 Emby ----
const emby = http.createServer((req, res) => {
  const url = req.url ?? "";

  if (url.includes("/Items?Ids=")) {
    const id = new URL(url, "http://x").searchParams.get("Ids");
    // item-local 指向本地文件，其余都指向挂载点里的 strm
    const path = id === "item-local" ? LOCAL_FILE : PAN_FILE;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ Items: [{ Name: "Show", Path: path, MediaSources: [{ Id: id, Path: path, Container: "mkv" }] }] }));
    return;
  }
  if (url.includes("/PlaybackInfo")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      MediaSources: [
        { Id: "ms-pan", Path: PAN_FILE, Container: "mkv", SupportsDirectPlay: false, SupportsDirectStream: false, DirectStreamUrl: "/emby/Videos/ms-pan/stream.mkv?api_key=k" },
        { Id: "ms-local", Path: LOCAL_FILE, Container: "mp4", SupportsDirectPlay: false, SupportsDirectStream: false, DirectStreamUrl: "/emby/Videos/ms-local/stream.mp4?api_key=k" },
      ],
    }));
    return;
  }
  // 真 Emby 对 /System/Info 和 /emby/System/Info 都认，桩也照做
  if (url.includes("/System/Info")) {
    res.writeHead(200, { "content-type": "application/json", "x-lab-marker": "1", "cache-control": "no-cache" });
    res.end(JSON.stringify({
      WebSocketPortNumber: 8096,
      HttpServerPortNumber: 8096,
      LocalAddress: "http://192.168.1.2:8096",
      LocalAddresses: ["http://192.168.1.2:8096"],
    }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("upstream-ok");
});

await new Promise<void>((r) => emby.listen(0, "127.0.0.1", r));
const embyPort = (emby.address() as { port: number }).port;

// ---- 配置 ----
const baseline = readAppSettings();
writeAppSettings({
  ...baseline,
  emby: { url: `http://127.0.0.1:${embyPort}`, apiKey: "test-key" },
  mediaMountPath: [MOUNT],
});

// ---- 被测应用 ----
const app = Fastify({ logger: false });
await app.register(proxyPlugin);
await app.ready();

let resolveCalls = 0;
setLinkResolver(async (embyPath) => {
  resolveCalls++;
  return embyPath.startsWith(MOUNT)
    ? { ok: true, url: DIRECT_URL, accountName: "主号", panPath: embyPath }
    : { ok: false, reason: "not-mounted" };
});

function reset() {
  resolveCalls = 0;
  clearLinkCache();
}

try {
  console.log("302 重定向");

  await t("挂载点里的条目 302 到直链", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv?api_key=k" });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, DIRECT_URL, "已转义的直链必须原样透传，不能二次编码");
  });

  await t("小写路径同样命中（客户端大小写不统一）", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/videos/item-1/stream?api_key=k" });
    assert.equal(res.statusCode, 302);
  });

  await t("不带 /emby 前缀也命中", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/Videos/item-1/original.mkv" });
    assert.equal(res.statusCode, 302);
  });

  await t("Audio universal 命中", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/Audio/item-1/universal" });
    assert.equal(res.statusCode, 302);
  });

  await t("Items Download 命中", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/Items/item-1/Download" });
    assert.equal(res.statusCode, 302);
  });

  console.log("回源兜底");

  await t("HEAD 探测直接回源，不去换直链", async () => {
    reset();
    const res = await app.inject({ method: "HEAD", url: "/emby/Videos/item-1/stream.mkv" });
    assert.equal(res.statusCode, 200);
    assert.equal(resolveCalls, 0, "HEAD 不该触发直链解析");
  });

  await t("本地文件不被 302，老老实实回源", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/Videos/item-local/stream.mkv" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "upstream-ok");
  });

  await t("master/live 之类不在白名单的动作回源", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/master.m3u8" });
    assert.equal(res.statusCode, 200);
    assert.equal(resolveCalls, 0);
  });

  await t("字幕请求穿过通配路由回源", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/Subtitles/0/Stream.srt" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "upstream-ok");
  });

  await t("解析抛异常也回源，不让播放直接失败", async () => {
    reset();
    setLinkResolver(async () => {
      throw new Error("115 挂了");
    });
    const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "upstream-ok");
    // 复原
    setLinkResolver(async (embyPath) => {
      resolveCalls++;
      return embyPath.startsWith(MOUNT)
        ? { ok: true, url: DIRECT_URL, accountName: "主号", panPath: embyPath }
        : { ok: false, reason: "not-mounted" };
    });
  });

  console.log("缓存");

  await t("同一条目重复请求只解析一次", async () => {
    reset();
    const a = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv", headers: { "user-agent": "UA-1" } });
    const b = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv", headers: { "user-agent": "UA-1" } });
    assert.equal(a.statusCode, 302);
    assert.equal(b.statusCode, 302);
    assert.equal(resolveCalls, 1, "第二次该走缓存");
  });

  await t("UA 不同要重新解析——115 直链和 UA 绑定", async () => {
    reset();
    await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv", headers: { "user-agent": "UA-1" } });
    await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv", headers: { "user-agent": "UA-2" } });
    assert.equal(resolveCalls, 2);
  });

  console.log("PlaybackInfo 改写");

  await t("挂载点里的媒体源被标成可直连，本地源不动", async () => {
    reset();
    const res = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {} });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const pan = body.MediaSources.find((s: { Id: string }) => s.Id === "ms-pan");
    const local = body.MediaSources.find((s: { Id: string }) => s.Id === "ms-local");

    assert.equal(pan.SupportsDirectPlay, true);
    assert.equal(pan.SupportsDirectStream, true);
    // 路径段是条目 id，不是 MediaSource.Id——真 Emby 的 MediaSource.Id 长 mediasource_11 这样
    assert.match(pan.DirectStreamUrl, /^\/emby\/Videos\/item-1\/stream\.mkv\?/, "应指回本代理");
    assert.match(pan.DirectStreamUrl, /api_key=k/, "查询串要保留，丢了客户端就没法鉴权");

    assert.equal(local.SupportsDirectPlay, false, "本地源不该被改");
  });

  console.log("System/Info 端口改写");

  await t("端口被换掉，客户端才不会绕过代理直连 Emby", async () => {
    reset();
    const res = await app.inject({ method: "GET", url: "/emby/System/Info" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.notEqual(body.WebSocketPortNumber, 8096);
    assert.ok(!String(body.LocalAddress).includes("8096"), "地址里的端口也要换");
  });

  await t("swapPorts 对各种字段形态都生效", () => {
    const out = swapPorts(
      {
        WebSocketPortNumber: 8096,
        HttpServerPortNumber: 8096,
        LocalAddress: "http://a:8096",
        WanAddress: "http://b:8096",
        LocalAddresses: ["http://a:8096", "http://c:8096"],
        RemoteAddresses: ["http://d:8096"],
      },
      8096,
      8091,
    );
    assert.equal(out.WebSocketPortNumber, 8091);
    assert.equal(out.HttpServerPortNumber, 8091);
    assert.equal(out.LocalAddress, "http://a:8091");
    assert.equal(out.WanAddress, "http://b:8091");
    assert.deepEqual(out.LocalAddresses, ["http://a:8091", "http://c:8091"]);
    assert.deepEqual(out.RemoteAddresses, ["http://d:8091"]);
  });

  await t("端口相同时什么都不改", () => {
    const out = swapPorts({ WebSocketPortNumber: 8091, LocalAddress: "http://a:8091" }, 8091, 8091);
    assert.equal(out.LocalAddress, "http://a:8091");
  });

  console.log("转发头");

  await t("回源时带上真实客户端 IP", async () => {
    reset();
    const seen: Record<string, string | string[] | undefined> = {};
    const sniffer = http.createServer((req, res) => {
      Object.assign(seen, req.headers);
      res.writeHead(200).end("ok");
    });
    await new Promise<void>((r) => sniffer.listen(0, "127.0.0.1", r));
    const sniffPort = (sniffer.address() as { port: number }).port;

    const current = readAppSettings();
    writeAppSettings({ ...current, emby: { url: `http://127.0.0.1:${sniffPort}`, apiKey: "k" } });

    await app.inject({
      method: "GET",
      url: "/Users/u1/Views",
      headers: { "x-forwarded-for": "203.0.113.9", host: "emby.example.com" },
    });

    assert.match(String(seen["x-forwarded-for"]), /^203\.0\.113\.9/, "原有转发链要保留");
    // X-Real-IP 必须是真实对端，不能采信客户端自报的 XFF——
    // 否则任何人发一个头就能让 Emby 的日志和封禁认错人
    assert.notEqual(seen["x-real-ip"], "203.0.113.9", "X-Real-IP 不能采信客户端自报的转发链");
    assert.equal(seen.host, "emby.example.com", "Host 不能被改成上游的");

    writeAppSettings(current);
    sniffer.close();
  });

  console.log("回归：A/B 对照发现的问题");

  await t("非 ASCII 直链才转义，且只转非 ASCII 部分", async () => {
    reset();
    setLinkResolver(async () => ({ ok: true, url: UNICODE_URL, accountName: "主号", panPath: "/x" }));
    const res = await app.inject({ method: "GET", url: "/emby/Videos/item-1/stream.mkv" });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, "https://cdn.115.com/%E7%9B%B4%E9%93%BE?t=1");
    setLinkResolver(async (embyPath) => {
      resolveCalls++;
      return embyPath.startsWith(MOUNT)
        ? { ok: true, url: DIRECT_URL, accountName: "主号", panPath: embyPath }
        : { ok: false, reason: "not-mounted" };
    });
  });

  await t("PlaybackInfo 接受空 body 和表单 content-type", async () => {
    // nginx 版本对这些一律透传；默认 JSON 解析器会先判 400/415，handler 根本轮不到
    for (const ct of ["application/json", "application/x-www-form-urlencoded", "text/plain"]) {
      const res = await app.inject({
        method: "POST",
        url: "/emby/Items/item-1/PlaybackInfo",
        headers: { "content-type": ct },
        payload: "",
      });
      assert.equal(res.statusCode, 200, `${ct} 空 body 应当被接受`);
    }
  });

  await t("PlaybackInfo 关掉转码并去掉 TranscodingUrl", async () => {
    reset();
    const res = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {} });
    const pan = JSON.parse(res.body).MediaSources.find((s: { Id: string }) => s.Id === "ms-pan");
    assert.equal(pan.SupportsTranscoding, false, "留着转码的话限码率客户端会绕开 302");
    assert.equal(pan.TranscodingUrl, undefined);
  });

  await t("DirectStreamUrl 用条目 id 且带 Static=true", async () => {
    reset();
    const res = await app.inject({ method: "POST", url: "/emby/Items/item-1/PlaybackInfo", payload: {} });
    const pan = JSON.parse(res.body).MediaSources.find((s: { Id: string }) => s.Id === "ms-pan");
    // 路径段必须是条目 id，不能是 MediaSource.Id（真 Emby 里长 mediasource_11 这样）
    assert.match(pan.DirectStreamUrl, /^\/emby\/Videos\/item-1\/stream\./);
    assert.match(pan.DirectStreamUrl, /Static=true/);
    assert.ok(!/TranscodeReasons/.test(pan.DirectStreamUrl), "不该残留 TranscodeReasons");
  });

  await t("逐跳头不再把请求打成 500", async () => {
    for (const headers of [{ "keep-alive": "timeout=5" }, { expect: "100-continue" }]) {
      const a = await app.inject({ method: "GET", url: "/emby/System/Info", headers });
      const b = await app.inject({ method: "GET", url: "/Users/u1/Views", headers });
      assert.equal(a.statusCode, 200, "拦截路径");
      assert.equal(b.statusCode, 200, "透传路径");
    }
  });

  await t("拦截路径保留上游响应头", async () => {
    const res = await app.inject({ method: "GET", url: "/emby/System/Info" });
    // 只回 content-type 的话，跨源的浏览器客户端会被 CORS 拦掉
    assert.ok(res.headers["x-lab-marker"], "上游自定义响应头应当带回来");
  });

  await t("swapUrlPort 不碰主机名里的数字", () => {
    // 子串替换会把 emby8096.duckdns.org 改坏，同时端口没换
    assert.equal(swapUrlPort("http://emby8096.duckdns.org:8096", 8096, 8091),
                 "http://emby8096.duckdns.org:8091");
    assert.equal(swapUrlPort("http://192.168.0.80:80", 80, 8091), "http://192.168.0.80:8091");
    assert.equal(swapUrlPort("https://host:8920", 8096, 8091), "https://host:8920", "端口不匹配就别动");
    assert.equal(swapUrlPort("not-a-url", 8096, 8091), "not-a-url");
  });

  console.log(`\n${pass} passed`);
} finally {
  writeAppSettings(baseline);
  await app.close();
  emby.close();
}

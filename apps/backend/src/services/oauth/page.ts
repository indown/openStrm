/**
 * 授权页：后端直接出的一张极简 HTML（中文、内联样式和脚本），不依赖前端的静态导出——公网上不需要露出管理界面。
 * 页面上显示配对码，管理员把它输进管理界面（或发给 Telegram 机器人）批准；页面每两秒问一次后端批了没有，
 * 批了就带着授权码跳回客户端。轮询用 POST，轮询密钥不进地址栏、不进访问日志。
 * 客户端名、回调地址都是别人给的：一律转义；嵌进脚本的数据把 < 转掉，免得提前闭合 script。
 */
import { randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import { hostOf, type OAuthRequestRecord } from "../../db/repositories/oauth.js";
import { clientHostOf } from "./clients.js";
import { OAUTH_PATHS } from "./config.js";
import { isInsecureUri, isLoopbackUri } from "./redirect.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const jsonForScript = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --fg: #1d2129; --muted: #6b7280; --line: #e5e7eb; --brand: #0ea5c6; --warn: #b45309; --danger: #dc2626; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b1016; --card: #121a23; --fg: #e5e7eb; --muted: #94a3b8; --line: #1f2a37; --brand: #38bdf8; --warn: #fbbf24; --danger: #f87171; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 15px/1.6 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; padding: 16px; }
main { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 24px; }
h1 { font-size: 20px; margin: 0 0 12px; }
p { margin: 8px 0; }
.muted { color: var(--muted); font-size: 13px; }
.warn { color: var(--warn); font-size: 13px; }
.error { color: var(--danger); }
.code { font: 600 30px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 3px; text-align: center; padding: 14px; margin: 16px 0; border: 1px dashed var(--line); border-radius: 10px; }
.status { text-align: center; margin: 12px 0; }
details { margin-top: 16px; border-top: 1px solid var(--line); padding-top: 12px; }
summary { cursor: pointer; color: var(--muted); font-size: 13px; }
input, select, button { width: 100%; font: inherit; padding: 8px 10px; margin-top: 8px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; }
button { background: var(--brand); color: #fff; border: 0; cursor: pointer; }
button:disabled { opacity: .6; cursor: default; }
a.back { display: block; text-align: center; margin-top: 12px; color: var(--brand); }
`;

/** 页面自己的安全头：不许被嵌进别的页面，脚本只认带这次随机数的那一段，只能请求本站 */
function send(reply: FastifyReply, status: number, html: string, nonce?: string) {
  const script = nonce ? `'nonce-${nonce}'` : "'none'";
  return reply
    .code(status)
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .header("x-frame-options", "DENY")
    .header("referrer-policy", "no-referrer")
    .header(
      "content-security-policy",
      `default-src 'none'; style-src 'unsafe-inline'; script-src ${script}; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    )
    .send(html);
}

function layout(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main>${script}</body></html>`;
}

export function sendErrorPage(reply: FastifyReply, status: number, message: string, backUrl?: string) {
  // backUrl：回调地址核对过了，给个链接让人自己点回客户端（带着 error），不自动跳
  const back = backUrl ? `<a class="back" href="${esc(backUrl)}" rel="noreferrer">回到客户端</a>` : `<p class="muted">回到客户端，重新连接一次。</p>`;
  return send(reply, status, layout("连接 OpenStrm", `<h1>连接不上 OpenStrm</h1><p class="error">${esc(message)}</p>${back}`));
}

export function sendAuthorizePage(reply: FastifyReply, request: OAuthRequestRecord, pollSecret: string, allowPassword: boolean, telegramApproval: boolean) {
  const nonce = randomBytes(16).toString("base64");
  const target = hostOf(request.redirectUri);
  const verifiedHost = clientHostOf(request.clientKind, request.clientId);
  const where = telegramApproval
    ? "到 OpenStrm 管理界面的「设置 → 智能体接入 → 待批准」，点这一条的「批准」并输入下面的配对码；也可以把配对码发给 OpenStrm 的 Telegram 机器人。"
    : "到 OpenStrm 管理界面的「设置 → 智能体接入 → 待批准」，点这一条的「批准」并输入下面的配对码。";
  const body = `
<h1>连接 OpenStrm</h1>
<p><b>${esc(request.clientName)}</b> 请求连接你的 OpenStrm。</p>
${verifiedHost ? `<p class="muted">客户端身份：${esc(verifiedHost)}（它的元数据地址所在的域名）</p>` : ""}
<p class="muted">授权后跳回：${esc(target)}</p>
${isInsecureUri(request.redirectUri) ? `<p class="warn" id="warn">回调地址是公网上的 http（明文），确认它是你自己的服务再批准。</p>` : ""}
${isLoopbackUri(request.redirectUri) ? `<p class="warn" id="warn">授权后跳回本机（${esc(target)}）：只有你正在这台电脑上用命令行或桌面客户端连接时才对。</p>` : ""}
<div class="code" id="code">${esc(request.pairingCode)}</div>
<p id="howto">${where}不是你自己发起的连接就别批，直接拒绝。</p>
<p class="status" id="status">等待批准…</p>
<p class="muted" id="hint">批准后这个页面会自动跳回客户端，别关掉。</p>
${
  allowPassword
    ? `<details id="pwbox"><summary>用管理员密码直接批准</summary>
<form id="pw"><input type="password" id="password" autocomplete="current-password" placeholder="管理界面的登录密码" required>
<select id="preset"><option value="daily">日常：查看、开始同步、转存、云下载</option><option value="read">只读：只能查看</option></select>
<button type="submit" id="pwbtn">批准</button><p class="error" id="pwerr" hidden></p></form></details>`
    : ""
}`;
  const data = { id: request.id, k: pollSecret, status: OAUTH_PATHS.authorizeStatus, password: OAUTH_PATHS.authorizePassword, expiresAt: request.expiresAt };
  const script = `<script nonce="${nonce}">
(() => {
  const d = ${jsonForScript(data)};
  const statusEl = document.getElementById("status");
  let stopped = false;
  // 到头了（跳走、拒绝、过期、已完成）：怎么批准、「别关掉」、密码表单都不再有意义，留着只会和结果打架（比如旁边还挂着上一次的「密码不对」）
  const finish = (text, cls) => {
    stopped = true; statusEl.textContent = text; if (cls) statusEl.className = "status " + cls;
    for (const id of ["warn", "howto", "hint", "pwbox"]) document.getElementById(id)?.remove();
  };
  const backLink = (url) => {
    const a = document.createElement("a"); a.className = "back"; a.href = url; a.rel = "noreferrer"; a.textContent = "回到客户端";
    statusEl.after(a);
  };
  const handle = (r) => {
    if (r.status === "redirect") { finish("已批准，正在跳回客户端…"); location.replace(r.url); return; }
    if (r.status === "denied") { finish("管理员拒绝了这次连接，正在跳回客户端…", "error"); location.replace(r.url); return; }
    if (r.status === "expired") {
      finish("等太久过期了，回到客户端重新连接一次。", "error");
      if (r.url) { if (r.auto) location.replace(r.url); else backLink(r.url); }
      return;
    }
    if (r.status === "done") { finish("这次授权已经完成，可以关掉这个页面。"); return; }
    if (r.status === "missing") { finish("这次授权请求不存在了，回到客户端重新连接一次。", "error"); return; }
    const left = Math.max(0, d.expiresAt - Math.floor(Date.now() / 1000));
    statusEl.textContent = "等待批准…（" + Math.floor(left / 60) + " 分 " + (left % 60) + " 秒后过期）";
  };
  const post = (url, body) => fetch(url, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const poll = async () => {
    if (stopped) return;
    try {
      handle(await (await post(d.status, { id: d.id, k: d.k })).json());
    } catch {}
    if (!stopped) setTimeout(poll, 2000);
  };
  poll();
  const form = document.getElementById("pw");
  if (form) form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("pwbtn"), err = document.getElementById("pwerr");
    btn.disabled = true; err.hidden = true;
    try {
      const res = await post(d.password, { id: d.id, k: d.k, password: document.getElementById("password").value, preset: document.getElementById("preset").value });
      const r = await res.json();
      if (!res.ok) { err.textContent = r.message || r.error_description || "批准失败"; err.hidden = false; } else handle(r);
    } catch { err.textContent = "网络出错了，再试一次"; err.hidden = false; }
    btn.disabled = false;
  });
})();
</script>`;
  return send(reply, 200, layout("连接 OpenStrm", body, script), nonce);
}

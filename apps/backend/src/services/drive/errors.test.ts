/**
 * 网盘错误里的事实和账号问题的统一判断：登录码 / 风控按接口回来的错误认，
 * 我们自己拼的错误里带用户的路径，路径里的「405」「cookie」不能把整轮当成风控。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxiosError } from "axios";
import { PermanentError } from "../../lib/errors.js";
import { HttpError } from "../../lib/http-error.js";
import { Cloud115ApiError, Cloud115Error, ShareBusyError } from "../cloud-115/client.js";
import { ShareApiError } from "../cloud-115/share.js";
import { OpenlistError } from "../openlist/client.js";
import { QuarkError } from "../quark/client.js";
import { accountIssueOf, classifyAccountIssue, driveErrorFacts, driveErrorToHttp } from "./errors.js";
import { Cloud115Provider } from "./providers/cloud115.js";
import { ShareGoneError } from "./types.js";

const p115 = new Cloud115Provider({ accountType: "115", name: "a", cookie: "c" });

test("driveErrorFacts：三家的错误类和 axios 的响应算接口错误，普通 Error / PermanentError 不算；包着网盘错误的 PermanentError 看 cause", () => {
  assert.equal(driveErrorFacts(new Error("x")).api, false);
  assert.equal(driveErrorFacts(new PermanentError("File not found")).api, false);
  assert.deepEqual(driveErrorFacts(new Cloud115ApiError("115：登录超时（errno 990001）", 990001)), { transport: false, taskFailed: false, authCode: true, api: true });
  const wrapped = new PermanentError("Failed to get file info: unauthorized", { cause: new OpenlistError("unauthorized", 401) });
  assert.equal(driveErrorFacts(wrapped).authCode, true);
  assert.equal(driveErrorFacts(wrapped).status, 401);
  assert.equal(driveErrorFacts(new AxiosError("socket hang up", "ECONNRESET")).api, false, "连不上没有响应，文案也没得看");
  assert.equal(driveErrorFacts(new AxiosError("Request failed with status code 404", "ERR_BAD_REQUEST", undefined, undefined, { status: 404 } as never)).api, true);
});

test("accountIssueOf：路径里带 405 / cookie 的普通错误和 PermanentError 不算账号问题；接口回来的按码和文案认", () => {
  const idle = new Error("下载 /tv/Room 405/cookie.mkv：120 秒内没有收到数据");
  const missing = new PermanentError("File not found: x.mkv in directory: /电影/1405年. Available files: a");
  for (const provider of [undefined, p115]) {
    assert.equal(accountIssueOf(provider, idle), null);
    assert.equal(accountIssueOf(provider, missing), null);
    assert.equal(accountIssueOf(provider, new Cloud115ApiError("115：登录超时，请重新登录。（errno 990001）", 990001)), "auth");
    assert.equal(accountIssueOf(provider, new Cloud115ApiError("115：cookie 已失效", undefined)), "auth", "接口回来的文案可以猜");
    assert.equal(accountIssueOf(provider, new Cloud115Error(405, "<!doctypehtml>", "https://webapi.115.com/files")), "blocked");
    assert.equal(accountIssueOf(provider, new Cloud115Error(404, "not found")), null);
  }
  assert.equal(accountIssueOf(undefined, new PermanentError("Failed to get file info: unauthorized", { cause: new OpenlistError("unauthorized", 401) })), "auth", "OpenList 包在 PermanentError 里的 401");
  assert.equal(accountIssueOf(undefined, new QuarkError("require login", 401, 31001)), "auth");
  assert.equal(p115.classifyError(new Error("cookie 405")), null, "115 的 classifyError 只看接口层的错误");
  assert.equal(p115.classifyError(new Cloud115ApiError("115：登录超时，请重新登录。", 990001)), "auth");
  assert.equal(classifyAccountIssue("115 接口返回 405: 您的访问被阻断"), "blocked");
});

test("115 分享接口一时回不了话（太频繁、繁忙）：不是分享没了——不回 SHARE_GONE，追更也不当失效停掉", () => {
  const busy = new ShareBusyError("操作过于频繁，请稍后再试", 911);
  const http = driveErrorToHttp(busy, "失败");
  assert.ok(http instanceof HttpError);
  assert.equal(http.extra.code, "SHARE_BUSY", "资源搜索页只按 SHARE_GONE 标失效");
  assert.equal(http.extra.reason, undefined);
  assert.match(http.message, /暂时打不开：操作过于频繁/);
  assert.equal(p115.classifyError(busy), null, "追更按 gone 才停：这种只是这一轮没连上");
  assert.equal(accountIssueOf(p115, busy), null);
  // 说着频繁、其实是登录失效的照样认成账号问题
  assert.equal(p115.classifyError(new ShareBusyError("登录超时，请稍后重新登录", 990001)), "auth");
  // 真没了、提取码不对的照旧
  const gone = driveErrorToHttp(new ShareGoneError("分享已取消", 4100010), "失败");
  assert.equal(gone.extra.code, "SHARE_GONE");
  assert.equal(gone.extra.reason, "gone");
  assert.equal(driveErrorToHttp(new ShareGoneError("访问码错误", 4100012), "失败").extra.reason, "password");
  assert.equal(p115.classifyError(new ShareApiError("分享已取消", 4100010)), "gone");
});

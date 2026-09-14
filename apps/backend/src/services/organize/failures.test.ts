/**
 * 失败分类：三家网盘的错误类、我们自己的 StaleError、按文案兜底，以及重试 / 撤销的取舍谓词。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrganizeItem } from "@openstrm/shared";
import { PermanentError } from "../../lib/errors.js";
import { Cloud115ApiError, Cloud115Error } from "../cloud-115/client.js";
import { Cloud115Provider } from "../drive/providers/cloud115.js";
import { RemoteDirNotFoundError, type AccountIssue } from "../drive/types.js";
import { OpenlistError } from "../openlist/client.js";
import { QuarkError } from "../quark/client.js";
import { QuarkTaskError } from "../quark/share.js";
import { classifyFailure, OrganizeFailure, retryableItem, revertPendingItem, revertWorkItem, StaleError } from "./failures.js";

const provider = (issue: AccountIssue | null = null) => ({ classifyError: () => issue });

test("classifyFailure：账号问题优先，其次我们自己的 stale，再按各家错误类 / 文案", () => {
  assert.equal(classifyFailure(provider("blocked"), new Error("115 接口返回 405")), "blocked");
  assert.equal(classifyFailure(provider("auth"), new Error("请重新登录")), "blocked");
  assert.equal(classifyFailure(provider(), new StaleError("网盘上找不到 /a")), "stale");
  assert.equal(classifyFailure(provider(), new RemoteDirNotFoundError("/a")), "stale");
  assert.equal(classifyFailure(provider(), new OrganizeFailure("rejected", new Error("x"))), "rejected", "已经分好类的原样透传");
  // OpenList：连不上是临时；明确答复按文案
  assert.equal(classifyFailure(provider(), new OpenlistError("OpenList 连不上", undefined, true)), "transient");
  assert.equal(classifyFailure(provider(), new OpenlistError("object not found", 500)), "stale");
  assert.equal(classifyFailure(provider(), new OpenlistError("object already exists", 500)), "rejected");
  assert.equal(classifyFailure(provider(), new OpenlistError("OpenList /api/fs/move 失败：file [x.mkv] exists", 403)), "rejected", "OpenList 目标已存在回的是 403");
  assert.equal(classifyFailure(provider(), new OpenlistError("storage not init", 500)), "transient");
  assert.equal(classifyFailure(provider(), new OpenlistError("invalid request", 500)), "transient", "泛泛的 invalid 不算名字问题");
  // 115：404 是没了，5xx 是临时，state=false 的中文按文案
  assert.equal(classifyFailure(provider(), new Cloud115Error(404, "")), "stale");
  assert.equal(classifyFailure(provider(), new Cloud115Error(502, "bad gateway")), "transient");
  assert.equal(classifyFailure(provider(), new Error("115：文件不存在（errno 20018）")), "stale");
  assert.equal(classifyFailure(provider(), new Error("115：该目录名称已存在（errno 20004）")), "rejected");
  assert.equal(classifyFailure(provider(), new Error("115：文件名不能包含特殊字符")), "rejected");
  // 夸克：任务失败 / 超时是临时；5xx 临时；文案兜底
  assert.equal(classifyFailure(provider(), new QuarkTaskError("夸克转存任务超时（15 分钟）")), "transient");
  assert.equal(classifyFailure(provider(), new QuarkError("夸克 /file/rename 失败：HTTP 503", 503)), "transient");
  assert.equal(classifyFailure(provider(), new QuarkError("夸克 /file/rename 失败：同名文件已存在", 400, 23008)), "rejected");
  // 其余 PermanentError 是「明确说没有」；网络错误和认不出的都算临时
  assert.equal(classifyFailure(provider(), new PermanentError("No pickcode found for file: /a")), "stale");
  assert.equal(classifyFailure(provider(), new Error("read ECONNRESET")), "transient");
  assert.equal(classifyFailure(provider(), new Error("改不了")), "transient");
  assert.equal(classifyFailure(provider(), "字符串错误"), "transient");
  // 假网盘的两种文案
  assert.equal(classifyFailure(provider(), new Error("fake move: no such path /a")), "stale");
  assert.equal(classifyFailure(provider(), new Error("fake rename: target exists /b")), "rejected");
});

const item = (over: Partial<OrganizeItem>): OrganizeItem => ({
  id: "i", runId: "r", unitKey: "u", seq: 0, kind: "video", action: "move", srcPath: "/a", dstPath: "/b", nodeId: "n", reason: "",
  status: "pending", error: "", errorKind: "", attempts: 0, givenUp: false, finishedAt: null, curPath: "", hits: 0, ...over,
});

test("retryableItem：没做的做；失败的只重试临时 / 风控 / 没分类的，stale 和 rejected 要点名；done 只补镜像；rmdir 顺带再看", () => {
  assert.equal(retryableItem(item({ status: "pending" })), true);
  assert.equal(retryableItem(item({ status: "failed", errorKind: "transient" })), true);
  assert.equal(retryableItem(item({ status: "failed", errorKind: "blocked" })), true);
  assert.equal(retryableItem(item({ status: "failed", errorKind: "" })), true, "旧数据没分类的按临时");
  assert.equal(retryableItem(item({ status: "failed", errorKind: "stale" })), false);
  assert.equal(retryableItem(item({ status: "failed", errorKind: "stale" }), true), true, "点名才重试");
  assert.equal(retryableItem(item({ status: "failed", errorKind: "rejected" })), false);
  assert.equal(retryableItem(item({ status: "done" })), false);
  assert.equal(retryableItem(item({ status: "done", errorKind: "mirror" })), true);
  assert.equal(retryableItem(item({ status: "skipped", errorKind: "stale" })), false);
  assert.equal(retryableItem(item({ status: "reverted" })), false);
  assert.equal(retryableItem(item({ action: "rmdir", status: "skipped", errorKind: "transient" })), true, "目录不是空的：下次再看一眼");
  assert.equal(retryableItem(item({ action: "rmdir", status: "skipped", errorKind: "stale" })), false, "目录已经不在了");
  assert.equal(retryableItem(item({ action: "keep", status: "pending" })), false);
  assert.equal(retryableItem(item({ action: "conflict", status: "failed" })), false);
  assert.equal(retryableItem(item({ status: "failed", errorKind: "transient", givenUp: true })), false, "放弃了的不再重试");
  assert.equal(retryableItem(item({ status: "done", errorKind: "mirror", givenUp: true })), false);
});

test("revertPendingItem：done 的文件项要退回；带 curPath 的半路项要改回；已退回但镜像失败的只补本地", () => {
  assert.equal(revertPendingItem(item({ status: "done" })), true);
  assert.equal(revertPendingItem(item({ status: "done", errorKind: "transient" })), true, "上次撤销失败的还在整理后的位置");
  assert.equal(revertPendingItem(item({ status: "done", curPath: "/a/x" })), true, "挪回来了没改名");
  assert.equal(revertPendingItem(item({ status: "done", action: "mkdir" })), false, "只建了目录不算改动文件");
  assert.equal(revertPendingItem(item({ status: "failed", curPath: "/a/x" })), true, "执行时原地改了名没挪走");
  assert.equal(revertPendingItem(item({ status: "pending", curPath: "/a/x" })), true);
  assert.equal(revertPendingItem(item({ status: "failed", errorKind: "stale" })), false, "找不到的不再归整理管");
  assert.equal(revertPendingItem(item({ status: "reverted" })), false);
  assert.equal(revertPendingItem(item({ status: "reverted", errorKind: "mirror" })), true);
  assert.equal(revertPendingItem(item({ status: "skipped" })), false);
  assert.equal(revertWorkItem(item({ status: "done", action: "mkdir" })), true, "撤销时建过的目录要删");
  assert.equal(revertWorkItem(item({ status: "done", action: "rmdir" })), true);
  assert.equal(revertWorkItem(item({ status: "failed", errorKind: "stale" })), false);
  assert.equal(revertWorkItem(item({ status: "skipped", action: "mkdir" })), false, "上一轮没删掉的自建目录不算还有事");
  assert.equal(revertWorkItem(item({ status: "skipped", action: "mkdir" }), true), true, "撤销循环里再看一眼");
  assert.equal(revertWorkItem(item({ status: "skipped", action: "mkdir", nodeId: "" }), true), false, "从没建过的（放弃掉的失败 mkdir）不碰");
  assert.equal(revertWorkItem(item({ status: "skipped", action: "mkdir", givenUp: true }), true), false);
  assert.equal(revertPendingItem(item({ status: "done", errorKind: "transient", givenUp: true })), false, "放弃撤销的不算还有事");
  assert.equal(revertPendingItem(item({ status: "done", errorKind: "mirror", givenUp: true })), true, "放弃的只是补本地：网盘上挪过的照样要退");
  assert.equal(revertWorkItem(item({ status: "done", errorKind: "mirror", givenUp: true })), true);
  assert.equal(revertPendingItem(item({ status: "reverted", errorKind: "mirror", givenUp: true })), false, "退回了、放弃补本地的没事了");
});

test("classifyFailure：我们自己的 stale 先于账号判断，路径里的 405 不会把整轮按风控停；115 接口回的登录超时才算", () => {
  assert.equal(classifyFailure(provider("blocked"), new StaleError("网盘上找不到 /tv/Room 405/x.mkv")), "stale", "provider 按文案猜也拦不住 stale");
  const p115 = new Cloud115Provider({ accountType: "115", name: "a", cookie: "c" });
  assert.equal(classifyFailure(p115, new PermanentError("File not found: x in directory: /电影/1405年")), "stale");
  assert.equal(classifyFailure(p115, new Error("fake move: no such path /tv/cookie/405.mkv")), "stale");
  assert.equal(classifyFailure(p115, new Cloud115ApiError("115：登录超时，请重新登录。（errno 990001）", 990001)), "blocked");
  assert.equal(classifyFailure(p115, new Cloud115Error(405, "<!doctypehtml>")), "blocked");
});

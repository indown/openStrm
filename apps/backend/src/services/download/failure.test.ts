/**
 * 单个文件失败的分类：本地 errno、网盘账号问题、文件没了、网络抖动 → 类别 / 范围 / 可否重试 / 建议；
 * 以及事前预判文件名长度、执行历史的摘要文案。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxiosError } from "axios";
import { PermanentError } from "../../lib/errors.js";
import { Cloud115ApiError, Cloud115Error } from "../cloud-115/client.js";
import type { AccountIssue } from "../drive/types.js";
import { OpenlistError } from "../openlist/client.js";
import { QuarkError } from "../quark/client.js";
import { classifyFileFailure, describeFileFailure, nameTooLongError, overlongSegment, summarizeFailures } from "./failure.js";

const fsErr = (code: string, syscall = "open"): NodeJS.ErrnoException => Object.assign(new Error(`${code}: something, ${syscall} '/app/data/x'`), { code, syscall, errno: -1 });
const ctx = (relPath = "S1/ep1.mkv", kind: "strm" | "download" = "strm", issue: AccountIssue | null = null) => ({ relPath, kind, provider: { classifyError: () => issue } });

test("本地文件系统：名字过长 / 非法字符 / 撞名是单个文件的事，磁盘满 / 没权限 / 只读整轮停，EMFILE 之类可重试", () => {
  const long = classifyFileFailure(fsErr("ENAMETOOLONG"), ctx("Show/一个很长的名字.mkv"));
  assert.equal(long.kind, "name-too-long");
  assert.equal(long.scope, "file");
  assert.equal(long.retryable, false);
  assert.match(long.advice, /整理/);
  assert.deepEqual(long.action, { type: "organize", subPath: "Show" });
  assert.equal(classifyFileFailure(fsErr("EINVAL"), ctx()).kind, "invalid-name");
  assert.equal(classifyFileFailure(fsErr("ENOENT"), ctx("Show/a: b.mkv")).kind, "invalid-name", "SMB 上非法字符可能报 ENOENT：按名字里的字符认");
  assert.equal(classifyFileFailure(fsErr("ENOENT"), ctx("Show/ok.mkv")).kind, "io-error", "名字正常的 ENOENT 是目录被人清了");
  for (const code of ["ENOTDIR", "EISDIR", "EEXIST"]) assert.equal(classifyFileFailure(fsErr(code), ctx()).kind, "name-conflict", code);
  for (const code of ["ENOSPC", "EDQUOT"]) {
    const f = classifyFileFailure(fsErr(code, "write"), ctx());
    assert.equal(f.kind, "no-space");
    assert.equal(f.scope, "task");
  }
  assert.equal(classifyFileFailure(fsErr("EACCES", "mkdir"), ctx()).kind, "permission");
  assert.equal(classifyFileFailure(fsErr("EACCES", "mkdir"), ctx()).scope, "task");
  assert.match(classifyFileFailure(fsErr("EACCES"), ctx()).advice, /PUID/);
  assert.equal(classifyFileFailure(fsErr("EROFS"), ctx()).kind, "read-only");
  const mfile = classifyFileFailure(fsErr("EMFILE"), ctx());
  assert.equal(mfile.kind, "fs-transient");
  assert.equal(mfile.retryable, true);
  assert.deepEqual(mfile.action, { type: "settings" });
  assert.equal(classifyFileFailure(fsErr("EIO", "write"), ctx()).kind, "io-error");
  assert.equal(classifyFileFailure(fsErr("ESTALE"), ctx()).retryable, true);
  assert.equal(classifyFileFailure(fsErr("ELOOP"), ctx()).retryable, false);
});

test("网盘那边：账号问题由 provider 认，404 / PermanentError 是文件没了，连不上 / 5xx 是网络", () => {
  assert.equal(classifyFileFailure(new Error("x"), ctx("a", "download", "auth")).kind, "auth");
  assert.equal(classifyFileFailure(new Error("x"), ctx("a", "download", "auth")).scope, "task");
  assert.deepEqual(classifyFileFailure(new Error("x"), ctx("a", "download", "blocked")).action, { type: "account" });
  assert.equal(classifyFileFailure(new Error("x"), ctx("a", "download", "gone")).kind, "gone");
  assert.equal(classifyFileFailure(new PermanentError("No pickcode found for file"), ctx("a", "download")).kind, "gone");
  const notFound = new AxiosError("Request failed with status code 404", "ERR_BAD_REQUEST", undefined, undefined, { status: 404 } as never);
  assert.equal(classifyFileFailure(notFound, ctx("a", "download")).kind, "gone");
  assert.equal(classifyFileFailure(new Cloud115Error(404, "gone"), ctx("a", "download")).kind, "gone");
  assert.equal(classifyFileFailure(new Cloud115Error(502, "bad gateway"), ctx("a", "download")).kind, "network");
  assert.equal(classifyFileFailure(new QuarkError("夸克 /file/download 失败：HTTP 503", 503), ctx("a", "download")).kind, "network");
  assert.equal(classifyFileFailure(new OpenlistError("OpenList 连不上", undefined, true), ctx("a", "download")).kind, "network");
  const reset = new AxiosError("socket hang up", "ECONNRESET");
  const net = classifyFileFailure(reset, ctx("a", "download"));
  assert.equal(net.kind, "network");
  assert.equal(net.retryable, true);
  assert.equal(classifyFileFailure(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" }), ctx("a", "download")).kind, "network", "流式下载里 node 自己抛的网络错也是网络");
  // provider 没认出来时按文案兜底，只看接口回来的错误（115 接口层的错误类）
  assert.equal(classifyFileFailure(new Cloud115ApiError("115：登录超时，请重新登录。（errno 990001）", 990001), ctx("a", "download")).kind, "auth");
  assert.equal(classifyFileFailure(new Error("115：登录超时，请重新登录。"), ctx("a", "download")).kind, "unknown", "普通 Error 的文案不拿来猜（里面可能是路径）");
  assert.equal(classifyFileFailure(new Cloud115Error(405, "<!doctypehtml>"), ctx("a", "download")).kind, "blocked");
  const unknown = classifyFileFailure(new Error("莫名其妙"), ctx("a", "download"));
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.message, "莫名其妙");
  assert.equal(unknown.advice, "");
  assert.equal(describeFileFailure(new Error("莫名其妙"), ctx()), "莫名其妙", "认不出的只给原文");
  assert.match(describeFileFailure(fsErr("ENOSPC"), ctx()), /^磁盘满了.*；清理或扩容/);
});

test("本地错误先于网盘判断：路径里带 405 / cookie 也不会被当成风控或登录失效", () => {
  const f = classifyFileFailure(Object.assign(new Error("ENOSPC: no space left on device, open '/app/data/Show/Room 405/cookie.strm'"), { code: "ENOSPC", syscall: "open" }), ctx("Show/Room 405/cookie.mkv", "strm", "blocked"));
  assert.equal(f.kind, "no-space");
  const g = classifyFileFailure(Object.assign(new Error("ENOENT: no such file or directory, mkdir '/app/data/Mission: Impossible (1996)'"), { code: "ENOENT", syscall: "mkdir" }), ctx("Mission: Impossible (1996)/movie.mkv"));
  assert.equal(g.kind, "invalid-name", "目录段里的非法字符也算");
  assert.deepEqual(g.action, { type: "organize", subPath: "Mission: Impossible (1996)" });
});

test("「文件没了」只在取直链 / 下载时成立；转存、列目录那边的 404 和分享失效原样给", () => {
  const notFound = new AxiosError("Request failed with status code 404", "ERR_BAD_REQUEST", undefined, undefined, { status: 404 } as never);
  assert.equal(classifyFileFailure(notFound, ctx("a", "download")).kind, "gone");
  assert.equal(classifyFileFailure(notFound, ctx("a", "strm")).kind, "unknown");
  assert.equal(classifyFileFailure(new PermanentError("夸克转存缺少条目 X 的 share_fid_token"), ctx("a", "strm")).kind, "unknown");
  assert.equal(describeFileFailure(new PermanentError("夸克转存缺少条目 X 的 share_fid_token"), ctx("a", "strm")), "夸克转存缺少条目 X 的 share_fid_token");
  assert.equal(classifyFileFailure(new Error("x"), ctx("a", "strm", "gone")).kind, "unknown");
  // 账号问题的文案规则和 115 的 classifyError 同一份（drive/errors.ts），只看接口回来的错误
  assert.equal(classifyFileFailure(new Cloud115ApiError("115：cookie 已失效", undefined), ctx("a", "download")).kind, "auth");
  assert.equal(classifyFileFailure(new QuarkError("夸克 /file/download 失败：require login", 401, 31001), ctx("a", "download")).kind, "auth", "夸克的登录码不靠文案");
  // 整理镜像的撞名是本地的事
  const mirror = classifyFileFailure(Object.assign(new Error("ENOTEMPTY: directory not empty, rename"), { code: "ENOTEMPTY", syscall: "rename" }), { ...ctx("Show/Season 01"), context: "mirror" });
  assert.equal(mirror.kind, "name-conflict");
  assert.match(mirror.advice, /strm 管理/);
  assert.doesNotMatch(mirror.advice, /网盘上改掉/);
});

test("事前预判：任一路径段超过 255 字节就写不进去，按实际落盘的名字算（strm 是 .strm，下载是 .part）", () => {
  assert.equal(overlongSegment("/app/data/Show/ep1.strm"), null);
  const name = "字".repeat(84); // 252 字节
  assert.equal(overlongSegment(`/app/data/Show/${name}.mkv.part`), `${name}.mkv.part`, "252 + .mkv.part = 261 字节，超了");
  assert.equal(overlongSegment(`/app/data/Show/${"字".repeat(83)}.mkv`), null, "249 + 4 = 253 字节");
  assert.equal(overlongSegment(`/app/data/Show/${"字".repeat(84)}.strm`), `${"字".repeat(84)}.strm`, "252 + .strm = 257 字节");
  assert.equal(overlongSegment(`/app/data/${"d".repeat(256)}/ep1.strm`), "d".repeat(256), "目录段也算");
  const err = nameTooLongError("x".repeat(300));
  assert.equal(err.code, "ENAMETOOLONG");
  assert.equal(err.attempted, false);
  assert.equal(classifyFileFailure(err, ctx("Show/x.mkv")).kind, "name-too-long");
});

test("摘要：按类别计数，全认不出时列文件名", () => {
  assert.equal(summarizeFailures({ "name-too-long": 3, "no-space": 2 }, ["a", "b", "c", "d", "e"]), "5 个文件失败：文件名过长 3、磁盘满 2");
  assert.equal(summarizeFailures({ unknown: 2 }, ["S1/a.mkv", "S1/b.mkv"]), "2 个文件失败：a.mkv、b.mkv");
  assert.equal(summarizeFailures({ gone: 1, unknown: 1 }, ["a", "b"]), "2 个文件失败：网盘上已没有 1、其它 1");
});

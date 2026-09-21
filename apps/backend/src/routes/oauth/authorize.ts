/**
 * 授权页（后端出的 HTML）和它的两个接口：轮询批了没有、（开了的话）用管理员密码直接批准。
 * 两个接口都用 POST、参数放 body：轮询密钥不进地址，也就不进访问日志。
 */
import type { FastifyInstance } from "fastify";
import { readAppSetting } from "../../db/repositories/settings.js";
import { ipKey } from "../../lib/ip.js";
import { anonymousIpBucket } from "../../services/agent/rate-limit.js";
import { approveWithPassword, pollAuthorization, startAuthorization } from "../../services/oauth/authorize.js";
import { OAUTH_PATHS, oauthConfig } from "../../services/oauth/config.js";
import { sendAuthorizePage, sendErrorPage } from "../../services/oauth/page.js";
import { sendOAuthError, stringParams, throttleAnonymous, useOAuthErrorFormat } from "./common.js";

export default async function (fastify: FastifyInstance) {
  useOAuthErrorFormat(fastify);

  fastify.get(OAUTH_PATHS.authorize, async (request, reply) => {
    const cfg = oauthConfig();
    if (!cfg) return sendErrorPage(reply, 404, "这个 OpenStrm 没有开启网页客户端连接（智能体接入没开，或者没填公网地址）");
    // 这是浏览器打开的页面：超了限流也回一张页面，不回 JSON
    if (!anonymousIpBucket.take(`ip:${ipKey(request.ip)}`).ok) return sendErrorPage(reply, 429, "请求太频繁，过一会儿再试");
    const result = await startAuthorization(stringParams(request.query), request.ip, cfg);
    if (result.kind === "error") return sendErrorPage(reply, 400, result.message, result.backUrl);
    if (result.kind === "redirect") return reply.header("cache-control", "no-store").redirect(result.url, 302);
    const telegram = readAppSetting("telegram");
    const telegramApproval = telegram?.allowOAuthApproval === true && Boolean(telegram.botToken && telegram.chatId);
    return sendAuthorizePage(reply, result.request, result.pollSecret, {
      allowPassword: cfg.allowPasswordApproval,
      telegramApproval,
      passwordFirst: cfg.servesUi,
    });
  });

  // 授权页每两秒问一次：要带请求 id 和页面里的轮询密钥，光有 id 拿不到授权码
  fastify.post(OAUTH_PATHS.authorizeStatus, { bodyLimit: 4 * 1024 }, async (request, reply) => {
    const cfg = oauthConfig();
    void reply.header("cache-control", "no-store");
    if (!cfg) return reply.code(404).send({ status: "missing" });
    const b = stringParams(request.body);
    if (!b.id || !b.k) return reply.code(400).send({ status: "missing" });
    return pollAuthorization(b.id, b.k, cfg);
  });

  fastify.post(OAUTH_PATHS.authorizePassword, { bodyLimit: 4 * 1024 }, async (request, reply) => {
    const cfg = oauthConfig();
    void reply.header("cache-control", "no-store");
    if (!cfg) return reply.code(404).send({ error: "not_found", error_description: "web client access is not enabled", message: "没有开启网页客户端连接" });
    if (!throttleAnonymous(request, reply)) return reply;
    const b = stringParams(request.body);
    try {
      return await approveWithPassword({ id: b.id ?? "", pollSecret: b.k ?? "", password: b.password ?? "", preset: b.preset ?? "" }, request, cfg);
    } catch (err) {
      return sendOAuthError(reply, err, { withMessage: true });
    }
  });
}

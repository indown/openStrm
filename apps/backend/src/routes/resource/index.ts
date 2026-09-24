/**
 * 资源搜索（PanSou）：网页的一问一答、链接检测、设置页的「检查连接」。
 * 搜到的只是链接，转存 / 云下载走 /api/share 和 /api/115/offline，这里不写任何东西。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { isAbortError } from "../../lib/errors.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { pansouBaseUrlSchema } from "../../schemas/entities.js";
import { checkResourceLinks, pansouStatus, searchPhase } from "../../services/pansou/search.js";

/**
 * 浏览器不等了（换了关键词、离开了页面）就掐掉还在路上的那一问。盯 reply.raw 的 close（和 lib/sse.ts 一样，
 * POST 的请求流读完 body 就 close 了，盯它会一开始就掐）；已经回完了的那次 close 不算
 */
function abandonedSignal(reply: FastifyReply): AbortSignal {
  const ac = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) ac.abort();
  });
  return ac.signal;
}

const searchSchema = z.object({
  keyword: z.string().trim().min(1, "关键词不能为空").max(100, "关键词最多 100 个字"),
  /**
   * 网页排的轮次。first：这次搜索的第一问（频道、插件都有时先只搜 TG，同时预热插件）；more：之后的几轮补全。
   * 不给（自建的 agent 走 REST）：一次全量，不排轮次——回来的可能还不全，过半分钟再问同一个词会更全
   */
  phase: z.enum(["first", "more"]).optional(),
  /** 跳过 PanSou 的缓存：first 和不给 phase 时生效，more 不带 */
  refresh: z.boolean().optional(),
  /** 网页上选了 TMDB 候选时带的外文原名，交给 PanSou 认它的插件（ext.title_en） */
  titleEn: z.string().trim().max(200, "原名最多 200 个字").optional(),
});

const checkSchema = z.object({
  urls: z.array(z.string().max(2000)).min(1, "至少给一条链接").max(10, "一次最多检测 10 条"),
});

const statusSchema = z.object({
  baseUrl: pansouBaseUrlSchema.optional(),
  username: z.string().max(200).optional(),
  password: z.string().max(500).optional(),
});

export default async function (fastify: FastifyInstance) {
  // 令牌也能调（自建的 agent 走 REST）：只读，和它后面要接的转存、云下载同一组
  fastify.post(
    "/api/resource/search",
    { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "transfer" } },
    async (request, reply) => {
      const body = parse(searchSchema, request.body);
      // 只掐这一问：first 顺带发的全量预热不接这个信号，本来就是要它在后台接着跑、结果进 PanSou 的缓存
      const signal = abandonedSignal(reply);
      try {
        return await searchPhase(body.keyword, body.phase ?? "full", { refresh: body.refresh, titleEn: body.titleEn, signal });
      } catch (err) {
        // 浏览器走了不是出错：别记成一条没料到的异常
        if (signal.aborted && isAbortError(err)) throw new HttpError(499, "已取消", {}, { cause: err });
        throw err;
      }
    },
  );

  fastify.post(
    "/api/resource/check",
    { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "transfer" } },
    async (request) => {
      const body = parse(checkSchema, request.body);
      return checkResourceLinks(body.urls);
    },
  );

  // 不对令牌开放：它会让后端去请求表单里填的任意地址，而且属于设置
  fastify.post("/api/resource/status", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = parse(statusSchema, request.body ?? {});
    return pansouStatus(body);
  });
}

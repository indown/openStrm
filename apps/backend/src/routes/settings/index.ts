import type { FastifyInstance } from "fastify";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { maskSettings, unmaskSettingsPatch } from "../../lib/secrets.js";
import { parse } from "../../lib/validate.js";
import { settingsPatchSchema } from "../../schemas/entities.js";
import { invalidatePublicHost, requestHosts } from "../../plugins/public-host.js";
import { normalizeHost } from "../../services/oauth/config.js";

export default async function (fastify: FastifyInstance) {
  // 密钥只给末 4 位；表单原样提交掩码值等于不改（见 lib/secrets.ts）
  fastify.get("/api/settings", { preHandler: [fastify.authenticate] }, async () => maskSettings(readAppSettings()));

  /**
   * 按顶层键合并，不是整体替换：设置页只发它自己拥有的键，
   * telegram / lifeMonitor 这些由别的页面写的键不会被一份过期快照盖掉。
   */
  fastify.put("/api/settings", { preHandler: [fastify.authenticate] }, async (request) => {
    const patch = parse(settingsPatchSchema, request.body);
    // 没打开「这个域名也用来打开管理界面」时，公网地址的域名下只放行智能体用的路径：
    // 要是填的就是现在打开管理界面用的域名，保存完管理界面自己就被挡在外面了
    // （这次请求能看到的主机名都比一遍：原始 Host、X-Forwarded-Host，规范化过的）
    const publicUrl = patch.agent?.publicBaseUrl;
    if (publicUrl && patch.agent?.publicServesUi !== true && requestHosts(request).includes(normalizeHost(new URL(publicUrl).host) ?? "")) {
      throw new HttpError(
        400,
        "公网地址就是你现在打开管理界面用的域名。要继续在这个域名上用管理界面，打开「这个域名也用来打开管理界面」；要让它只给智能体用，换个地址（比如局域网地址）打开管理界面再关，不然保存完这个页面自己就打不开了",
      );
    }
    patchAppSettings(unmaskSettingsPatch(patch, readAppSettings()));
    // 公网守卫缓存着公网地址和共用开关：清掉，保存完马上按新的来（紧接着点自检也不会看到旧的）
    invalidatePublicHost();
    return { message: "ok" };
  });
}

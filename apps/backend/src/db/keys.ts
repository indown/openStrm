/**
 * settings 表是一张按前缀分命名空间的 KV，所有键在这里集中定义。
 *
 * - `app.*`     应用设置。readAppSettings / patchAppSettings 只认这个前缀，
 *               GET /api/settings 返回的就是这一组，前端能看到、能改。
 * - `auth.*`    登录凭据：用户名、口令哈希、mustChangePassword。
 * - `system.*`  不该随任何响应体外发的机密，目前只有 JWT 密钥。
 * - `life.*`    生活事件监控的运行状态：游标、接口降级状态。
 * - 无前缀的标记键：任何前缀匹配都碰不到它，用来记「已初始化」这类一次性事实。
 */
export const KEY = {
  appPrefix: "app.",
  authPrefix: "auth.",
  jwtSecret: "system.jwt_secret",
  /** 首次启动写入默认设置后落下的标记。名字是 v1 JSON 迁移时代留下的，改了老库就会被重新 seed */
  seededMarker: "__migrated_from_json__",
  lifeCursor: "life.cursor",
  lifeAppFallback: "life.appFallback",
} as const;

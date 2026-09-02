/**
 * settings 表是一张按前缀分命名空间的 KV，所有键在这里集中定义。
 *
 * - `app.*`     应用设置。readAppSettings / patchAppSettings 只认这个前缀，
 *               GET /api/settings 返回的就是这一组，前端能看到、能改。
 * - `auth.*`    登录凭据：用户名、口令哈希、mustChangePassword。
 * - `system.*`  不该随任何响应体外发的机密，目前只有 JWT 密钥。
 * - `life.*`    生活事件监控的运行状态：游标、接口降级状态，按账号各存一份。
 * - `offline.*` 云下载的回执：哪些 115 离线任务完成后要生成 strm。
 * - `emby.*`    Emby 侧的运行状态，目前只有入库通知的游标。
 * - 无前缀的标记键：任何前缀匹配都碰不到它，用来记「已初始化」这类一次性事实。
 */
export const KEY = {
  appPrefix: "app.",
  authPrefix: "auth.",
  jwtSecret: "system.jwt_secret",
  /** 首次启动写入默认设置后落下的标记。名字是 v1 JSON 迁移时代留下的，改了老库就会被重新 seed */
  seededMarker: "__migrated_from_json__",
  lifeCursor: (account: string) => `life.cursor.${account}`,
  lifeAppFallback: (account: string) => `life.appFallback.${account}`,
  /** 2.1 之前只监控一个账号时用的键；升级后第一次启动挪到账号名下，之后不再出现 */
  legacyLifeCursor: "life.cursor",
  legacyLifeAppFallback: "life.appFallback",
  offlineFollowups: "offline.followups",
  embyNewCursor: "emby.newCursor",
} as const;

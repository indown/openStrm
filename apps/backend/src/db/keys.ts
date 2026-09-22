/**
 * settings 表是一张按前缀分命名空间的 KV，所有键在这里集中定义。
 *
 * - `app.*`     应用设置。readAppSettings / patchAppSettings 只认这个前缀，
 *               GET /api/settings 返回的就是这一组，前端能看到、能改。
 * - `auth.*`    登录凭据：用户名、口令哈希、mustChangePassword。
 * - `system.*`  不该随任何响应体外发的机密：JWT 密钥、OAuth 令牌派生用的密钥。
 * - `life.*`    生活事件监控的运行状态：游标、接口降级状态，按账号各存一份。
 * - `offline.*` 云下载的回执：哪些 115 离线任务完成后要生成 strm。
 * - `copy.*`    「复制到 OpenList」的队列：哪些新文件等着 OpenList 复制走，复制到哪一步了。
 * - `emby.*`    Emby 侧的运行状态，目前只有入库通知的游标。
 * - `update.*`  检查更新的运行状态：上次查到的版本、时间、失败原因。
 * - 无前缀的标记键：任何前缀匹配都碰不到它，用来记「已初始化」这类一次性事实。
 */
export const KEY = {
  appPrefix: "app.",
  authPrefix: "auth.",
  jwtSecret: "system.jwt_secret",
  /** OAuth 刷新时由旧令牌派生新令牌用的 HMAC 密钥（宽限期内重试能拿回同一对令牌，见 repositories/oauth.ts） */
  oauthTokenKey: "system.oauth_token_key",
  /** 首次启动写入默认设置后落下的标记。名字是 v1 JSON 迁移时代留下的，改了老库就会被重新 seed */
  seededMarker: "__migrated_from_json__",
  lifeCursor: (account: string) => `life.cursor.${account}`,
  lifeAppFallback: (account: string) => `life.appFallback.${account}`,
  offlineFollowups: "offline.followups",
  /** 「复制到 OpenList」的队列；和回执一样是运行状态，不进 app. */
  copyQueue: "copy.queue",
  embyNewCursor: "emby.newCursor",
  /** 上一次检查更新的结果；不放 app. 前缀——它是运行状态，不是用户设置 */
  updateState: "update.state",
} as const;

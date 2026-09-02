
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import { initDb } from "./db/migrate.js";
import { sqlite } from "./db/client.js";
import { readAppSettings } from "./db/repositories/settings.js";
import { logger } from "./lib/logger.js";
import { registerErrorHandling } from "./plugins/error-handler.js";
import staticSitePlugin from "./plugins/static-site.js";

// Prevent unhandled rejections from crashing the process
process.on("unhandledRejection", (err) => {
  logger.error({ err }, "unhandledRejection");
});

// Apply DB migrations and seed from JSON on first run (before any plugin reads config)
await initDb();

// Core plugins
import { authPlugin } from "./plugins/auth.js";
import { cronPlugin } from "./plugins/cron.js";
import { startPolling, stopPolling } from "./services/telegram/polling.js";
import { cancelAllRunningTasks } from "./services/task/registry.js";
import { reconcileInterruptedExecutions } from "./services/task-history.js";
import { startHousekeeping } from "./services/housekeeping.js";

// Auth routes
import authLoginRoute from "./routes/auth/login.js";
import authLogoutRoute from "./routes/auth/logout.js";
import authPasswordRoute from "./routes/auth/password.js";

// CRUD routes
import accountRoute from "./routes/account/index.js";
import settingsRoute from "./routes/settings/index.js";
import taskRoute from "./routes/task/index.js";
import taskHistoryRoute from "./routes/task-history/index.js";

// Task execution routes
import taskStartRoute from "./routes/task/start.js";
import taskCancelRoute from "./routes/task/cancel.js";
import taskLogRoute from "./routes/task/log.js";
import taskCronRoute from "./routes/task/cron.js";

// Cloud storage routes
import cloudFilesRoute from "./routes/cloud/files.js";
import cloudShareRoute from "./routes/cloud/share.js";
import cloudOfflineRoute from "./routes/cloud/offline.js";
import { startOfflineWatcher, stopOfflineWatcher } from "./services/offline/service.js";

// 分享追更
import followRoute from "./routes/follow/index.js";
import { startFollowWatcher, stopFollowWatcher } from "./services/follow/service.js";

// Emby 入库通知
import { startEmbyNewWatcher, stopEmbyNewWatcher } from "./services/emby/library-new.js";

// Library routes
import libraryRoute from "./routes/library/index.js";
import libraryTmdbRoute from "./routes/library/tmdb.js";
import libraryHdhiveRoute from "./routes/library/hdhive.js";
import libraryBulkRoute from "./routes/library/bulk.js";
import librarySaveToTaskRoute from "./routes/library/save-to-task.js";
import { start as startScrapeWorker } from "./services/library/scrape-worker.js";

// Directory routes
import directoryLocalRoute from "./routes/directory/local.js";
import directoryRemoteRoute from "./routes/directory/remote.js";


// 115 life-event monitor (incremental cloud-drive change detection)
import lifeMonitorRoute from "./routes/life/index.js";
import { migrateLegacyLifeMonitorState, startLifeMonitor, stopLifeMonitor } from "./services/life/monitor.js";
import { flushEmbyRefresh } from "./services/media-server.js";

// System routes
import clearDirectoryRoute from "./routes/system/clear-directory.js";
import clearRateLimitersRoute from "./routes/system/clear-rate-limiters.js";
import healthRoute from "./routes/system/health.js";
import backupRoute from "./routes/system/backup.js";

const app = Fastify({
  loggerInstance: logger,
  forceCloseConnections: true,
  // 放在 nginx/Caddy 后面时设 TRUST_PROXY=true，request.ip 才取 X-Forwarded-For——
  // 登录退避按 IP 分桶，不设的话所有人共用反代那一个桶
  trustProxy: process.env.TRUST_PROXY === "true",
});
registerErrorHandling(app);

// 上个进程退出时还在跑的任务已经没了，历史里不能永远挂着 running
const interrupted = reconcileInterruptedExecutions();
if (interrupted > 0) app.log.warn(`[history] ${interrupted} 条执行记录因进程重启被标为失败`);
// 只增不减的几张表：启动清一次，之后每天一次
startHousekeeping();

// Global plugins
// 生产是同源（API 进程托管前端），开发走 next dev 的 rewrites，两种情况都用不到跨域；
// 留着 origin:true 只是给把 NEXT_PUBLIC_API_URL 指到别处的开发方式兜底。
// 不开 credentials：凭据是请求头里的 Bearer token，没有 cookie，反射任意 origin 再带凭据是给将来埋雷
await app.register(cors, { origin: true });
await app.register(compress);

// Core plugins (order matters)
await app.register(authPlugin);
await app.register(cronPlugin);

// Auth routes
await app.register(authLoginRoute);
await app.register(authLogoutRoute);
await app.register(authPasswordRoute);

// CRUD routes
await app.register(accountRoute);
await app.register(settingsRoute);
await app.register(taskRoute);
await app.register(taskHistoryRoute);

// Task execution routes
await app.register(taskStartRoute);
await app.register(taskCancelRoute);
await app.register(taskLogRoute);
await app.register(taskCronRoute);

// Cloud storage routes
await app.register(cloudFilesRoute);
await app.register(cloudShareRoute);
await app.register(cloudOfflineRoute);
await app.register(followRoute);

// Library routes
await app.register(libraryRoute);
await app.register(libraryTmdbRoute);
await app.register(libraryHdhiveRoute);
await app.register(libraryBulkRoute);
await app.register(librarySaveToTaskRoute);

// Directory routes
await app.register(directoryLocalRoute);
await app.register(directoryRemoteRoute);

// Alist-compatible route

// 115 life-event monitor
await app.register(lifeMonitorRoute);

// System routes
await app.register(clearDirectoryRoute);
await app.register(clearRateLimitersRoute);
await app.register(healthRoute);
await app.register(backupRoute);

// Telegram routes
import telegramBotRoute from "./routes/telegram/bot.js";
import telegramUsersRoute from "./routes/telegram/users.js";
import telegramPollingRoute from "./routes/telegram/polling.js";

await app.register(telegramBotRoute);
await app.register(telegramUsersRoute);
await app.register(telegramPollingRoute);

// 生产镜像里由这个进程托管管理界面（FRONTEND_DIR 指向前端的静态导出）；
// 开发时不设，next dev 自己在 3000 上跑
const frontendDir = process.env.FRONTEND_DIR;
if (frontendDir) {
  if (fs.existsSync(path.join(frontendDir, "index.html"))) {
    await app.register(staticSitePlugin, { root: path.resolve(frontendDir) });
  } else {
    app.log.warn(`FRONTEND_DIR=${frontendDir} 下没有 index.html，管理界面不可用`);
  }
}

// Emby 代理跑在独立进程里（src/proxy.ts）：
// 管理端崩溃或 strm 任务占满事件循环时，播放不受影响。
// 端口：开发默认 4000（next dev 占着 3000）；容器里 entrypoint 设成 3000，界面和 API 同一个口
const API_PORT = Number(process.env.BACKEND_PORT) || 4000;
const HOST = process.env.BACKEND_HOST || "0.0.0.0";

try {
  await app.listen({ port: API_PORT, host: HOST });
  app.log.info(`API server running on http://${HOST}:${API_PORT}`);
  try { startScrapeWorker(); } catch (err) { app.log.error({ err }, "scrape-worker start failed"); }

  // 生活事件监控：先把 2.1 之前的单账号状态挪到账号名下（界面还没机会改配置），配置里开着就跟随服务一起起来
  try { migrateLegacyLifeMonitorState(); } catch (err) { app.log.error({ err }, "life monitor state migration failed"); }
  const settings = readAppSettings();
  if (settings.lifeMonitor?.enabled) {
    startLifeMonitor()
      .then((r) => (r.ok && r.failed.length === 0 ? app.log.info(r.message) : app.log.warn(r.message)))
      .catch((err) => app.log.error({ err }, "life monitor start failed"));
  }
  // 云下载回执：上次关机前还有"下完生成 strm"没兑现的，接着盯
  startOfflineWatcher();
  // 分享追更：有开着的订阅就接着按周期检查
  startFollowWatcher();
  // Emby 入库通知：循环常驻，开关和配置每轮现查
  startEmbyNewWatcher();
  // Telegram 轮询同理：上次是开着的就自动恢复，别让每次重启都得有人去界面上再按一次
  if (settings.telegram?.pollingEnabled) {
    startPolling()
      .then((ok) => (ok ? app.log.info("Telegram 轮询已恢复") : app.log.warn("Telegram 轮询未能恢复：bot token 未配置")))
      .catch((err) => app.log.error({ err }, "telegram polling start failed"));
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown for tsx watch / SIGTERM
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  try { await stopLifeMonitor(); } catch { /* ignore */ }
  try { await stopOfflineWatcher(); } catch { /* ignore */ }
  try { await stopFollowWatcher(); } catch { /* ignore */ }
  try { await stopEmbyNewWatcher(); } catch { /* ignore */ }
  try { flushEmbyRefresh(); } catch { /* ignore */ }
  try { cancelAllRunningTasks(); } catch { /* ignore */ }

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
  const closeAll = app.close();

  await Promise.race([closeAll, timeout]);

  try { stopPolling(); } catch { /* ignore */ }
  try { sqlite.close(); } catch { /* ignore */ }

  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export default app;

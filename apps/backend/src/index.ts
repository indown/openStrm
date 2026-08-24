import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import { initDb } from "./db/migrate.js";
import { sqlite } from "./db/client.js";

// Prevent unhandled rejections from crashing the process
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

// Apply DB migrations and seed from JSON on first run (before any plugin reads config)
await initDb();

// Core plugins
import { configPlugin } from "./plugins/config.js";
import { authPlugin } from "./plugins/auth.js";
import { cachePlugin } from "./plugins/cache.js";
import { taskManagerPlugin } from "./plugins/task-manager.js";
import { cronPlugin } from "./plugins/cron.js";
import { setTaskStarter, stopPolling } from "./services/telegram-polling.js";

// Auth routes
import authLoginRoute from "./routes/auth/login.js";
import authLogoutRoute from "./routes/auth/logout.js";

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

// Alist-compatible file system route
import fsGetRoute from "./routes/fs/get.js";

// 115 life-event monitor (incremental cloud-drive change detection)
import lifeMonitorRoute from "./routes/life/index.js";
import {
  setLifeLogger,
  startLifeMonitor,
  stopLifeMonitor,
} from "./services/life/monitor.js";
import { flushEmbyRefresh, setMediaServerLogger } from "./services/media-server.js";

// System routes
import clearDirectoryRoute from "./routes/system/clear-directory.js";
import clearRateLimitersRoute from "./routes/system/clear-rate-limiters.js";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
  },
  forceCloseConnections: true,
});

// Global plugins
await app.register(cors, { origin: true, credentials: true });
await app.register(compress);

// Core plugins (order matters)
await app.register(configPlugin);
await app.register(cachePlugin);
await app.register(authPlugin);
await app.register(taskManagerPlugin);
await app.register(cronPlugin);

// Auth routes
await app.register(authLoginRoute);
await app.register(authLogoutRoute);

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
await app.register(fsGetRoute);

// 115 life-event monitor
await app.register(lifeMonitorRoute);

// System routes
await app.register(clearDirectoryRoute);
await app.register(clearRateLimitersRoute);

// Telegram routes
import telegramBotRoute from "./routes/telegram/bot.js";
import telegramSendRoute from "./routes/telegram/send.js";
import telegramUsersRoute from "./routes/telegram/users.js";
import telegramPollingRoute from "./routes/telegram/polling.js";

await app.register(telegramBotRoute);
await app.register(telegramSendRoute);
await app.register(telegramUsersRoute);
await app.register(telegramPollingRoute);

// Emby 代理跑在独立进程里（src/proxy.ts）：
// 管理端崩溃或 strm 任务占满事件循环时，播放不受影响。
const API_PORT = Number(process.env.BACKEND_PORT) || 4000;
const HOST = process.env.BACKEND_HOST || "0.0.0.0";

try {
  await app.listen({ port: API_PORT, host: HOST });
  app.log.info(`API server running on http://${HOST}:${API_PORT}`);
  try { startScrapeWorker(); } catch (err) { app.log.error({ err }, "scrape-worker start failed"); }

  // Telegram 按钮启动任务：走 inject + 现签 JWT，和 cron 同一套路
  // （是否真的允许启动由 settings.telegram.allowTaskStart 决定，默认关）
  setTaskStarter(async (taskId) => {
    const token = await app.signJwt({ username: "telegram", taskId });
    const res = await app.inject({
      method: "POST",
      url: "/api/startTask",
      payload: { id: taskId },
      headers: { authorization: `Bearer ${token}` },
    });
    return { ok: res.statusCode === 200, body: res.body };
  });

  setMediaServerLogger((m) => app.log.info(`[媒体服务器] ${m}`));

  // 生活事件监控：配置里开着就跟随服务一起起来
  setLifeLogger({
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
    error: (m) => app.log.error(m),
    debug: (m) => app.log.debug(m),
  });
  if (app.readSettings().lifeMonitor?.enabled) {
    startLifeMonitor()
      .then((r) => (r.ok ? app.log.info(r.message) : app.log.warn(r.message)))
      .catch((err) => app.log.error({ err }, "life monitor start failed"));
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
  try { flushEmbyRefresh(); } catch { /* ignore */ }

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

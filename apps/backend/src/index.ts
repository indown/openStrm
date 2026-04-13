import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";

// Core plugins
import { configPlugin } from "./plugins/config.js";
import { authPlugin } from "./plugins/auth.js";
import { cachePlugin } from "./plugins/cache.js";
import { taskManagerPlugin } from "./plugins/task-manager.js";

// Auth routes
import authLoginRoute from "./routes/auth/login.js";
import authLogoutRoute from "./routes/auth/logout.js";

// CRUD routes
import accountRoute from "./routes/account/index.js";
import settingsRoute from "./routes/settings/index.js";
import taskRoute from "./routes/task/index.js";
import taskHistoryRoute from "./routes/task-history/index.js";

// Task execution routes
import taskCancelRoute from "./routes/task/cancel.js";
import taskLogRoute from "./routes/task/log.js";

// Cloud storage routes
import cloudFilesRoute from "./routes/cloud/files.js";

// Directory routes
import directoryLocalRoute from "./routes/directory/local.js";
import directoryRemoteRoute from "./routes/directory/remote.js";

// Alist-compatible file system route
import fsGetRoute from "./routes/fs/get.js";

// System routes
import clearDirectoryRoute from "./routes/system/clear-directory.js";
import clearRateLimitersRoute from "./routes/system/clear-rate-limiters.js";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
  },
});

// Global plugins
await app.register(cors, { origin: true, credentials: true });
await app.register(compress);

// Core plugins (order matters)
await app.register(configPlugin);
await app.register(cachePlugin);
await app.register(authPlugin);
await app.register(taskManagerPlugin);

// Auth routes
await app.register(authLoginRoute);
await app.register(authLogoutRoute);

// CRUD routes
await app.register(accountRoute);
await app.register(settingsRoute);
await app.register(taskRoute);
await app.register(taskHistoryRoute);

// Task execution routes
await app.register(taskCancelRoute);
await app.register(taskLogRoute);

// Cloud storage routes
await app.register(cloudFilesRoute);

// Directory routes
await app.register(directoryLocalRoute);
await app.register(directoryRemoteRoute);

// Alist-compatible route
await app.register(fsGetRoute);

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

// Phase 5: emby proxy routes

const PORT = Number(process.env.BACKEND_PORT) || 4000;
const HOST = process.env.BACKEND_HOST || "0.0.0.0";

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Backend server running on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

export default app;

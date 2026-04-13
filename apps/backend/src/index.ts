import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import { configPlugin } from "./plugins/config.js";
import { authPlugin } from "./plugins/auth.js";
import { cachePlugin } from "./plugins/cache.js";

// Route modules
import authLoginRoute from "./routes/auth/login.js";
import authLogoutRoute from "./routes/auth/logout.js";
import accountRoute from "./routes/account/index.js";
import settingsRoute from "./routes/settings/index.js";
import taskRoute from "./routes/task/index.js";
import taskHistoryRoute from "./routes/task-history/index.js";

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

// API routes
await app.register(authLoginRoute);
await app.register(authLogoutRoute);
await app.register(accountRoute);
await app.register(settingsRoute);
await app.register(taskRoute);
await app.register(taskHistoryRoute);

// Phase 3: task start/cancel/log, cloud, directory, fs, system routes
// Phase 4: telegram routes
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

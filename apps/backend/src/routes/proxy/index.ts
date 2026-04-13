import type { FastifyInstance } from "fastify";
import replyFrom from "@fastify/reply-from";
import { configPlugin } from "../../plugins/config.js";
import catchAllProxy from "./catch-all.js";

/**
 * Emby proxy plugin - replaces the entire nginx/njs emby2Alist layer.
 *
 * The njs source files have been copied to services/proxy/ with:
 * - Import paths fixed to the new structure
 * - ngx.* calls shimmed via ngx-shim.js (LRUCache + native fetch)
 *
 * Route registration order matters: specific routes BEFORE catch-all.
 */
export default async function proxyPlugin(fastify: FastifyInstance) {
  // Register config plugin so we can read settings
  await fastify.register(configPlugin);

  const settings = fastify.readSettings();
  const embyUrl = settings.emby?.url || "http://172.17.0.1:8096";

  // Register reply-from for programmatic proxying (used by intercepting routes)
  await fastify.register(replyFrom, {
    base: embyUrl,
  });

  // TODO: Register intercepting routes here as they are ported:
  // - /emby/videos/:id/stream → redirect.ts (redirect2Pan)
  // - /emby/Items/:id/PlaybackInfo → playback-info.ts
  // - /emby/Users/:uid/Items → items-filter.ts
  // - /emby/system/info → system-info.ts
  // - /emby/videos/:id/live, /master → live.ts
  // - etc.

  // Catch-all proxy (MUST be last)
  await fastify.register(catchAllProxy);
}

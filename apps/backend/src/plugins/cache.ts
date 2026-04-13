import fp from "fastify-plugin";
import { LRUCache } from "lru-cache";

export interface CacheZones {
  routeL1: LRUCache<string, string>;
  routeL2: LRUCache<string, string>;
  transcode: LRUCache<string, Record<string, string>>;
  idem: LRUCache<string, boolean>;
  tmpDict: LRUCache<string, string>;
  version: LRUCache<string, string>;
}

export const cachePlugin = fp(async (fastify) => {
  const zones: CacheZones = {
    routeL1: new LRUCache({ max: 2000, ttl: 15 * 60 * 1000 }),
    routeL2: new LRUCache({ max: 4000, ttl: 15 * 60 * 1000 }),
    transcode: new LRUCache({ max: 500, ttl: 4 * 60 * 60 * 1000 }),
    idem: new LRUCache({ max: 200, ttl: 10 * 1000 }),
    tmpDict: new LRUCache({ max: 200, ttl: 60 * 1000 }),
    version: new LRUCache({ max: 5000, ttl: 11 * 60 * 60 * 1000 }),
  };

  fastify.decorate("cache", zones);

  fastify.addHook("onClose", () => {
    for (const cache of Object.values(zones)) {
      cache.clear();
    }
  });
}, { name: "cache" });

declare module "fastify" {
  interface FastifyInstance {
    cache: CacheZones;
  }
}

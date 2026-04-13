/**
 * ngx compatibility shim for Node.js
 * Replaces nginx njs built-in `ngx` object with Node.js equivalents.
 */
import { LRUCache } from "lru-cache";

// Log levels matching nginx njs
const INFO = 7;
const WARN = 5;
const ERR = 4;

// Shared dict zones (replaces ngx.shared)
const sharedDicts = {
  routeL1Dict: new LRUCache({ max: 2000, ttl: 15 * 60 * 1000 }),
  routeL2Dict: new LRUCache({ max: 4000, ttl: 15 * 60 * 1000 }),
  transcodeDict: new LRUCache({ max: 500, ttl: 4 * 60 * 60 * 1000 }),
  idemDict: new LRUCache({ max: 200, ttl: 10 * 1000 }),
  tmpDict: new LRUCache({ max: 200, ttl: 60 * 1000 }),
  versionDict: new LRUCache({ max: 5000, ttl: 11 * 60 * 60 * 1000 }),
};

// LRU wrappers that mimic ngx.shared dict API (get/set/has/delete/keys/clear + add/incr/size)
for (const [name, cache] of Object.entries(sharedDicts)) {
  const original = cache;
  sharedDicts[name] = {
    get(key) { return original.get(key); },
    set(key, value) { original.set(key, value); },
    has(key) { return original.has(key); },
    delete(key) { original.delete(key); },
    keys() { return [...original.keys()]; },
    clear() { original.clear(); },
    add(key, value) {
      if (!original.has(key)) { original.set(key, value); return true; }
      return false;
    },
    incr(key, delta) {
      const v = (original.get(key) || 0) + (delta || 1);
      original.set(key, v);
      return v;
    },
    get size() { return original.size; },
    // items/pop for compat
    items() { return original.size; },
    pop() { /* no-op for compat */ },
  };
}

function log(level, message) {
  if (level <= ERR) {
    console.error(`[ngx] ${message}`);
  } else if (level <= WARN) {
    console.warn(`[ngx] ${message}`);
  } else {
    console.log(`[ngx] ${message}`);
  }
}

/**
 * ngx.fetch replacement using Node.js native fetch.
 */
async function ngxFetch(url, options = {}) {
  const fetchOpts = {
    method: options.method || "GET",
    headers: options.headers || {},
  };
  if (options.body) {
    fetchOpts.body = options.body;
  }
  // Handle timeout via AbortController
  const timeout = options.timeout || 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  fetchOpts.signal = controller.signal;

  try {
    const resp = await fetch(url, fetchOpts);
    clearTimeout(timer);
    // Build a response object compatible with njs ngx.fetch response
    const text = await resp.text();
    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      headers: Object.fromEntries(resp.headers.entries()),
      redirected: resp.redirected,
      text() { return text; },
      async json() { return JSON.parse(text); },
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// The global ngx object
const ngx = {
  INFO,
  WARN,
  ERR,
  log,
  fetch: ngxFetch,
  shared: sharedDicts,
};

export default ngx;
export { ngx, sharedDicts };

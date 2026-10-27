/* Rate limiting — Redis backend with in-memory fallback.

   The in-memory limiter in proxy.mjs counts per-process, so behind a load
   balancer each instance has its own window — an attacker gets N× the limit
   across N instances, and the login brute-force guard is similarly weakened.
   This module counts in Redis instead, so the window is shared across every
   instance.

   Enable:
     npm i redis
     export REDIS_URL=redis://host:6379
     npm start

   The factory returns a limiter with the SAME shape as makeLimiter: a function
   (key) -> Promise<boolean> ("is this request allowed?"). It uses a fixed
   window via INCR + PEXPIRE, which is simple, atomic, and good enough for abuse
   prevention. If REDIS_URL is unset or the client can't be reached at startup,
   it transparently falls back to the in-memory limiter so the server still runs.
*/

// In-memory fixed-window limiter (same semantics as proxy.mjs makeLimiter,
// but returns a Promise so callers can await uniformly across backends).
export function inMemoryLimiter({ windowMs, max }) {
  const hits = new Map();   // key -> [timestamps]
  return async (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    }
    return arr.length <= max;
  };
}

// Redis fixed-window limiter. `client` is a connected node-redis v4 client
// (or anything exposing incr/pexpire/pttl). Injected so it's testable with a fake.
export function redisLimiter(client, { windowMs, max, prefix = "rl:" }) {
  return async (key) => {
    const k = prefix + key;
    // INCR is atomic; on the first hit in a window, set the TTL.
    const n = await client.incr(k);
    if (n === 1) {
      await client.pExpire(k, windowMs);
    } else {
      // guard against a key that somehow lost its TTL (e.g. a crash between
      // INCR and PEXPIRE): if no TTL, set one so it can't count forever.
      const ttl = await client.pTTL(k);
      if (ttl < 0) await client.pExpire(k, windowMs);
    }
    return n <= max;
  };
}

/* Build a limiter, choosing the backend from the environment.

   Returns { limiter, backend }:
     - REDIS_URL set + client connects  → redis   (cross-instance)
     - otherwise                        → memory  (per-process fallback)

   `connect` is injectable for testing. Never throws: a Redis failure at startup
   logs a warning and falls back to memory, so the server always comes up.
*/
export async function makeLimiterFactory({ windowMs, max, prefix = "rl:" }, {
  redisUrl = process.env.REDIS_URL,
  connect = defaultConnect,
  log = console,
} = {}) {
  if (redisUrl) {
    try {
      const client = await connect(redisUrl);
      return { limiter: redisLimiter(client, { windowMs, max, prefix }), backend: "redis", client };
    } catch (e) {
      log.warn?.(`[ratelimit] Redis unavailable (${e.message}); falling back to in-memory.`);
    }
  }
  return { limiter: inMemoryLimiter({ windowMs, max }), backend: "memory", client: null };
}

async function defaultConnect(redisUrl) {
  const { createClient } = await import("redis");
  const client = createClient({ url: redisUrl });
  client.on("error", () => {});   // don't crash on transient errors
  await client.connect();
  return client;
}

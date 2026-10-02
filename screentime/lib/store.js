// Storage backends: Upstash Redis (Vercel / any serverless host) or a local JSON file (dev / VPS).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRedisStore(redis) {
  return {
    kind: 'redis',
    load: () => redis.get('st:db'),
    init: async (fresh) => { await redis.set('st:db', fresh, { nx: true }); },
    save: async (db) => { await redis.set('st:db', db); },
    // Serialises read-modify-write requests across serverless instances.
    async lock(fn) {
      const id = crypto.randomUUID();
      for (let i = 0; i < 60; i++) {
        if (await redis.set('st:lock', id, { nx: true, px: 15000 })) {
          try { return await fn(); }
          finally { if ((await redis.get('st:lock')) === id) await redis.del('st:lock'); }
        }
        await sleep(100 + Math.random() * 100);
      }
      throw new Error('Server busy, please try again');
    },
    failCount: async (k) => Number(await redis.get('st:fail:' + k)) || 0,
    async failAdd(k, ttl) { if ((await redis.incr('st:fail:' + k)) === 1) await redis.expire('st:fail:' + k, ttl); },
    failClear: async (k) => { await redis.del('st:fail:' + k); },
  };
}

export function createFileStore(dir) {
  const file = path.join(dir, 'data.json');
  const fails = new Map();
  let chain = Promise.resolve();
  return {
    kind: 'file',
    async load() { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; },
    async init(fresh) { if (!fs.existsSync(file)) await this.save(fresh); },
    async save(db) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(db));
      fs.renameSync(file + '.tmp', file);
    },
    lock(fn) {
      const run = chain.then(fn, fn);
      chain = run.catch(() => {});
      return run;
    },
    async failCount(k) { const f = fails.get(k); return f && f.until > Date.now() ? f.n : 0; },
    async failAdd(k, ttl) { fails.set(k, { n: (await this.failCount(k)) + 1, until: Date.now() + ttl * 1000 }); },
    async failClear(k) { fails.delete(k); },
  };
}

let cached;
export function getStore() {
  cached ??= (async () => {
    const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
    const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
    if (url && token) {
      const { Redis } = await import('@upstash/redis');
      return createRedisStore(new Redis({ url, token }));
    }
    if (env.VERCEL) throw new Error('Storage is not configured: connect an Upstash Redis database to this Vercel project.');
    return createFileStore(env.DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
  })();
  return cached;
}

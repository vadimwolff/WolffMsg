import { Redis } from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Redis backs three things: rate-limit counters, presence, and cross-process
 * realtime fan-out.
 *
 * When `REDIS_URL` is unset the app falls back to an in-process implementation
 * with identical semantics for a single node. That keeps `npm run dev` a
 * one-command affair without pretending to be horizontally scalable — the
 * fallback logs a warning saying exactly that.
 */

export interface CounterStore {
  /** Increment `key`, returning the new value and the TTL in seconds. */
  incr(key: string, ttlSeconds: number): Promise<{ count: number; ttl: number }>;
  get(key: string): Promise<number>;
  reset(key: string): Promise<void>;
  setEx(key: string, value: string, ttlSeconds: number): Promise<void>;
  getValue(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  /** Add to a TTL'd set (used for presence and typing). */
  sAdd(key: string, member: string, ttlSeconds: number): Promise<void>;
  sRem(key: string, member: string): Promise<void>;
  sMembers(key: string): Promise<string[]>;
  /** Drop every counter. Test-only; see `resetCountersForTests`. */
  flushAll(): Promise<void>;
}

export interface PubSub {
  publish(channel: string, payload: string): Promise<void>;
  subscribe(channel: string, handler: (payload: string) => void): Promise<void>;
  close(): Promise<void>;
}

/* ────────────────────────────── in-memory ───────────────────────────────── */

class MemoryStore implements CounterStore, PubSub {
  private counters = new Map<string, { count: number; expiresAt: number }>();
  private values = new Map<string, { value: string; expiresAt: number }>();
  private sets = new Map<string, Map<string, number>>();
  private handlers = new Map<string, ((payload: string) => void)[]>();
  private sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref?.();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.counters) if (v.expiresAt <= now) this.counters.delete(k);
    for (const [k, v] of this.values) if (v.expiresAt <= now) this.values.delete(k);
    for (const [k, members] of this.sets) {
      for (const [m, exp] of members) if (exp <= now) members.delete(m);
      if (members.size === 0) this.sets.delete(k);
    }
  }

  async incr(key: string, ttlSeconds: number) {
    const now = Date.now();
    const existing = this.counters.get(key);
    if (!existing || existing.expiresAt <= now) {
      const entry = { count: 1, expiresAt: now + ttlSeconds * 1000 };
      this.counters.set(key, entry);
      return { count: 1, ttl: ttlSeconds };
    }
    existing.count += 1;
    return {
      count: existing.count,
      ttl: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000)),
    };
  }

  async get(key: string) {
    const e = this.counters.get(key);
    return e && e.expiresAt > Date.now() ? e.count : 0;
  }

  async reset(key: string) {
    this.counters.delete(key);
  }

  async setEx(key: string, value: string, ttlSeconds: number) {
    this.values.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async getValue(key: string) {
    const e = this.values.get(key);
    return e && e.expiresAt > Date.now() ? e.value : null;
  }

  async del(key: string) {
    this.values.delete(key);
    this.sets.delete(key);
  }

  async sAdd(key: string, member: string, ttlSeconds: number) {
    let members = this.sets.get(key);
    if (!members) {
      members = new Map();
      this.sets.set(key, members);
    }
    members.set(member, Date.now() + ttlSeconds * 1000);
  }

  async sRem(key: string, member: string) {
    this.sets.get(key)?.delete(member);
  }

  async sMembers(key: string) {
    const members = this.sets.get(key);
    if (!members) return [];
    const now = Date.now();
    const live: string[] = [];
    for (const [m, exp] of members) {
      if (exp > now) live.push(m);
      else members.delete(m);
    }
    return live;
  }

  async flushAll() {
    this.counters.clear();
    this.values.clear();
    this.sets.clear();
  }

  async publish(channel: string, payload: string) {
    // Deliver asynchronously so publishers never run subscriber code inline.
    queueMicrotask(() => {
      for (const handler of this.handlers.get(channel) ?? []) {
        try {
          handler(payload);
        } catch (err) {
          logger.error({ err, channel }, 'in-memory pubsub handler failed');
        }
      }
    });
  }

  async subscribe(channel: string, handler: (payload: string) => void) {
    const list = this.handlers.get(channel) ?? [];
    list.push(handler);
    this.handlers.set(channel, list);
  }

  async close() {
    clearInterval(this.sweeper);
    this.handlers.clear();
  }
}

/* ──────────────────────────────── redis ─────────────────────────────────── */

class RedisStore implements CounterStore {
  constructor(private readonly client: Redis) {}

  async incr(key: string, ttlSeconds: number) {
    const [countRes, ttlRes] = await this.client
      .multi()
      .incr(key)
      .expire(key, ttlSeconds, 'NX')
      .ttl(key)
      .exec()
      .then((res) => [res?.[0], res?.[2]] as const);

    const count = Number(countRes?.[1] ?? 1);
    const ttl = Number(ttlRes?.[1] ?? ttlSeconds);
    return { count, ttl: ttl > 0 ? ttl : ttlSeconds };
  }

  async get(key: string) {
    return Number((await this.client.get(key)) ?? 0);
  }

  async reset(key: string) {
    await this.client.del(key);
  }

  async setEx(key: string, value: string, ttlSeconds: number) {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async getValue(key: string) {
    return this.client.get(key);
  }

  async del(key: string) {
    await this.client.del(key);
  }

  async sAdd(key: string, member: string, ttlSeconds: number) {
    // Sorted set scored by expiry gives us per-member TTL, which plain sets
    // cannot express.
    await this.client
      .multi()
      .zadd(key, Date.now() + ttlSeconds * 1000, member)
      .expire(key, ttlSeconds + 60)
      .exec();
  }

  async sRem(key: string, member: string) {
    await this.client.zrem(key, member);
  }

  async sMembers(key: string) {
    const now = Date.now();
    await this.client.zremrangebyscore(key, '-inf', now);
    return this.client.zrangebyscore(key, now, '+inf');
  }

  async flushAll() {
    // Never wipe a shared Redis. The test suite runs against the in-memory
    // store, so this path exists only to satisfy the interface.
    throw new Error('flushAll is not supported against Redis');
  }
}

class RedisPubSub implements PubSub {
  private readonly handlers = new Map<string, ((payload: string) => void)[]>();

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
  ) {
    this.subscriber.on('message', (channel, payload) => {
      for (const handler of this.handlers.get(channel) ?? []) {
        try {
          handler(payload);
        } catch (err) {
          logger.error({ err, channel }, 'redis pubsub handler failed');
        }
      }
    });
  }

  async publish(channel: string, payload: string) {
    await this.publisher.publish(channel, payload);
  }

  async subscribe(channel: string, handler: (payload: string) => void) {
    const list = this.handlers.get(channel) ?? [];
    const first = list.length === 0;
    list.push(handler);
    this.handlers.set(channel, list);
    if (first) await this.subscriber.subscribe(channel);
  }

  async close() {
    this.handlers.clear();
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }
}

/* ─────────────────────────────── singleton ──────────────────────────────── */

let store: CounterStore;
let pubsub: PubSub;
let clients: Redis[] = [];

function makeClient(): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  client.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
  clients.push(client);
  return client;
}

if (env.redisEnabled) {
  const commandClient = makeClient();
  store = new RedisStore(commandClient);
  pubsub = new RedisPubSub(makeClient(), makeClient());
  logger.info('using redis for rate limiting, presence and realtime fan-out');
} else {
  const memory = new MemoryStore();
  store = memory;
  pubsub = memory;
  if (!env.isTest) {
    logger.warn(
      'REDIS_URL is not set — using the in-process store. Rate limits and ' +
        'presence are per-instance only; do not run more than one node.',
    );
  }
}

export const counters: CounterStore = store;
export const bus: PubSub = pubsub;

/**
 * Is the counter/fan-out backend actually usable right now?
 *
 * Reported by the readiness probe. The in-process store is always usable —
 * there is nothing to be unreachable — so this is only a real question when
 * Redis is configured. A node whose Redis has gone away still answers HTTP,
 * but its rate limits have silently become per-node and its realtime events
 * no longer reach anyone else, so it should be taken out of rotation.
 */
export async function isCounterStoreReady(): Promise<boolean> {
  if (!env.redisEnabled) return true;
  const client = clients[0];
  if (!client) return false;
  try {
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Clear every rate-limit and presence counter between tests.
 *
 * Guarded so it can never run against a real deployment: the suite uses the
 * in-process store, and the Redis implementation refuses outright.
 */
export async function resetCountersForTests(): Promise<void> {
  if (env.NODE_ENV !== 'test') {
    throw new Error('resetCountersForTests may only be called under NODE_ENV=test');
  }
  await counters.flushAll();
}

export async function closeRedis(): Promise<void> {
  await bus.close();
  await Promise.allSettled(clients.map((c) => c.quit()));
  clients = [];
}

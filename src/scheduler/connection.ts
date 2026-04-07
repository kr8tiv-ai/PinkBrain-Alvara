/**
 * Redis / IORedis connection factory for BullMQ.
 *
 * Follows the lazy-init singleton pattern from src/db/connection.ts.
 * Reads REDIS_URL from env (default: redis://localhost:6379).
 *
 * BullMQ requires an IORedis instance — bullmq bundles ioredis as a dependency,
 * so we import directly from ioredis (re-exported via bullmq's peer).
 */

import { Redis } from 'ioredis';

const DEFAULT_REDIS_URL = 'redis://localhost:6379';

let _redis: Redis | null = null;

/**
 * Get or create the shared IORedis connection.
 * The connection is created lazily on first call and reused afterwards (singleton).
 */
export function getRedisConnection(): Redis {
  if (!_redis) {
    const url = process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
    _redis = new Redis(url, {
      maxRetriesPerRequest: null, // required by BullMQ
    });
  }
  return _redis;
}

/**
 * Gracefully shut down the Redis connection. Call on process exit.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}

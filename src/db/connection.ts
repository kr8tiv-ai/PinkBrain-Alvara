/**
 * PostgreSQL connection factory using Drizzle ORM + node-postgres.
 * Follows the config encapsulation pattern from src/config/chains.ts.
 *
 * Reads DATABASE_URL from env (with a sensible local default).
 * Exports both the Drizzle instance and the raw pool for shutdown cleanup.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

const DEFAULT_DATABASE_URL =
  'postgresql://pinkbrain:pinkbrain_dev@localhost:5432/pinkbrain';

let _pool: pg.Pool | null = null;

/**
 * Get or create the shared pg Pool.
 * The pool is created lazily on first call and reused afterwards.
 */
function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
    _pool = new Pool({ connectionString: url });
  }
  return _pool;
}

/**
 * Create a Drizzle ORM instance backed by the shared pg pool.
 * Schema is inlined for full type inference on queries.
 */
export function createDb() {
  const pool = getPool();
  return drizzle(pool, { schema });
}

/**
 * Gracefully shut down the pool. Call on process exit.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/** Expose the pool for health checks or raw queries when Drizzle isn't enough. */
export function getDbPool(): pg.Pool {
  return getPool();
}

export type AppDb = ReturnType<typeof createDb>;

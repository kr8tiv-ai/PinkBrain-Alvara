/**
 * BullMQ queue factory for the accumulation pipeline.
 *
 * Exports the queue name constant and a factory that returns
 * a Queue instance using the shared Redis connection.
 */

import { Queue } from 'bullmq';
import { getRedisConnection } from './connection.js';

/** Queue name constant — used by both producer (scheduler) and consumer (worker). */
export const ACCUMULATION_QUEUE = 'accumulation-pipeline';

/**
 * Create a BullMQ Queue for scheduling accumulation jobs.
 * Uses the shared IORedis connection from connection.ts.
 */
export function createAccumulationQueue(): Queue {
  return new Queue(ACCUMULATION_QUEUE, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5_000,
      },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });
}

/**
 * Scheduler barrel — re-exports connection and queue factories.
 */

export { getRedisConnection, closeRedis } from './connection.js';
export {
  ACCUMULATION_QUEUE,
  createAccumulationQueue,
} from './queue.js';

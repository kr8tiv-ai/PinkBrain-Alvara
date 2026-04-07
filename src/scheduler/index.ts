/**
 * Scheduler barrel — re-exports connection, queue, and worker factories.
 */

export { getRedisConnection, closeRedis } from './connection.js';
export {
  ACCUMULATION_QUEUE,
  createAccumulationQueue,
} from './queue.js';
export {
  createAccumulationWorker,
  type AccumulationWorkerOptions,
} from './accumulation-worker.js';

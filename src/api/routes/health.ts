/**
 * Health check route — GET /health
 *
 * Returns { status: 'ok', db: boolean } where db indicates whether
 * the database pool can respond to a simple query.
 */

import type { FastifyPluginAsync } from 'fastify';

const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', {
    schema: {
      response: {
        200: {
          type: 'object' as const,
          properties: {
            status: { type: 'string' as const },
            db: { type: 'boolean' as const },
          },
        },
      },
    },
  }, async (_request, reply) => {
    let dbOk = false;
    try {
      // If the server has a dbPool decoration, test it.
      // Otherwise just report false.
      const pool = (app as any).dbPool;
      if (pool) {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        dbOk = true;
      }
    } catch {
      dbOk = false;
    }

    return reply.send({ status: 'ok', db: dbOk });
  });
};

export default healthRoutes;

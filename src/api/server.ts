/**
 * Fastify server factory.
 *
 * createServer() accepts dependency injections (db, publicClient, etc.) and
 * returns a configured-but-not-listening Fastify instance. This pattern keeps
 * the server testable — tests pass a mock db, production passes the real one.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import type { AppDb } from '../db/connection.js';
import { FundNotFound, InvalidStateTransition, ConfigLocked } from '../db/errors.js';
import { AlvaraApiError } from '../alvara/types.js';
import healthRoutes from './routes/health.js';
import fundRoutes from './routes/funds.js';
import rebalanceRoutes from './routes/rebalance.js';
import emergencyRoutes from './routes/emergency.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface ServerDeps {
  db: AppDb;
  dbPool?: any;
  publicClient?: unknown;
  walletClient?: unknown;
  registryAddress?: string;
}

// ── Logging helper ─────────────────────────────────────────────────────

function log(action: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ module: 'api', action, ...data }));
}

// ── Error handler plugin ───────────────────────────────────────────────

function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    // Fastify validation error (schema validation failures)
    if (error.validation) {
      log('validationError', {
        path: request.url,
        errors: error.validation,
      });
      return reply.status(400).send({
        error: 'ValidationError',
        message: error.message,
        statusCode: 400,
      });
    }

    // Domain errors
    if (error instanceof FundNotFound || (error as any).name === 'FundNotFound') {
      log('fundNotFound', { fundId: (error as any).fundId, path: request.url });
      return reply.status(404).send({
        error: 'FundNotFound',
        message: error.message,
        statusCode: 404,
      });
    }

    if (error instanceof InvalidStateTransition || (error as any).name === 'InvalidStateTransition') {
      log('invalidStateTransition', {
        fundId: (error as any).fundId,
        from: (error as any).currentStatus,
        to: (error as any).requestedStatus,
        path: request.url,
      });
      return reply.status(409).send({
        error: 'InvalidStateTransition',
        message: error.message,
        statusCode: 409,
      });
    }

    if (error instanceof ConfigLocked || (error as any).name === 'ConfigLocked') {
      log('configLocked', { fundId: (error as any).fundId, path: request.url });
      return reply.status(409).send({
        error: 'ConfigLocked',
        message: error.message,
        statusCode: 409,
      });
    }

    if (error instanceof AlvaraApiError || (error as any).name === 'AlvaraApiError') {
      log('alvaraApiError', {
        code: (error as any).code,
        endpoint: (error as any).endpoint,
        path: request.url,
      });
      return reply.status(502).send({
        error: 'AlvaraApiError',
        message: error.message,
        statusCode: 502,
      });
    }

    // Unknown / internal server error
    log('internalError', {
      path: request.url,
      message: error.message,
      stack: error.stack,
    });
    return reply.status(500).send({
      error: 'InternalServerError',
      message: 'An unexpected error occurred',
      statusCode: 500,
    });
  });
}

// ── Factory ────────────────────────────────────────────────────────────

export async function createServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // We use structured JSON logging directly
  });

  // Decorate dependencies onto the instance for route access
  app.decorate('db', deps.db);
  if (deps.dbPool) {
    app.decorate('dbPool', deps.dbPool);
  }
  if (deps.publicClient) {
    app.decorate('publicClient', deps.publicClient);
  }
  if (deps.walletClient) {
    app.decorate('walletClient', deps.walletClient);
  }
  if (deps.registryAddress) {
    app.decorate('registryAddress', deps.registryAddress);
  }

  // Register error handler
  registerErrorHandler(app);

  // Register routes
  await app.register(healthRoutes);
  await app.register(fundRoutes);
  await app.register(rebalanceRoutes);
  await app.register(emergencyRoutes);

  log('serverCreated', { decorations: Object.keys(deps).filter((k) => deps[k as keyof ServerDeps] !== undefined) });

  return app;
}

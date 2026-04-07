#!/usr/bin/env tsx
/**
 * CLI entry point for the REST API server.
 *
 * Usage:
 *   tsx scripts/start-api.ts [--port 3000] [--host 0.0.0.0]
 */

import 'dotenv/config';
import { createDb, closeDb, getDbPool } from '../src/db/connection.js';
import { createServer } from '../src/api/server.js';

function parseArgs(args: string[]): { port: number; host: string } {
  let port = 3000;
  let host = '0.0.0.0';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === '--host' && args[i + 1]) {
      host = args[i + 1];
      i++;
    }
  }

  return { port, host };
}

async function main() {
  const { port, host } = parseArgs(process.argv.slice(2));

  const db = createDb();
  const pool = getDbPool();

  const server = await createServer({ db, dbPool: pool });

  // Graceful shutdown
  const shutdown = async () => {
    console.log(JSON.stringify({ module: 'api', action: 'shutdown', message: 'Shutting down...' }));
    await server.close();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.listen({ port, host });
    console.log(JSON.stringify({
      module: 'api',
      action: 'started',
      port,
      host,
      message: `Server listening on ${host}:${port}`,
    }));
  } catch (err) {
    console.error(JSON.stringify({
      module: 'api',
      action: 'startFailed',
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

main();

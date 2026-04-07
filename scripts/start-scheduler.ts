#!/usr/bin/env tsx
/**
 * CLI entry point for the accumulation scheduler.
 *
 * Usage:
 *   npx tsx scripts/start-scheduler.ts [--cron '0 *\/6 * * *']
 *
 * Registers a BullMQ repeatable job on the configured cron, creates the
 * accumulation worker, and runs until SIGINT/SIGTERM.
 */

import 'dotenv/config';
import { Connection, Keypair } from '@solana/web3.js';
import { createDb, closeDb } from '../src/db/connection.js';
import {
  getRedisConnection,
  closeRedis,
  createAccumulationQueue,
} from '../src/scheduler/index.js';
import { createAccumulationWorker } from '../src/scheduler/accumulation-worker.js';
import bs58 from 'bs58';

// ── Parse CLI flags ─────────────────────────────────────────────────────

function parseCronFlag(): string {
  const args = process.argv.slice(2);
  const cronIdx = args.indexOf('--cron');
  if (cronIdx !== -1 && args[cronIdx + 1]) {
    return args[cronIdx + 1];
  }
  return '0 */6 * * *'; // Default: every 6 hours (D009)
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cronPattern = parseCronFlag();

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      module: 'scheduler',
      action: 'starting',
      cron: cronPattern,
    }),
  );

  // ── Initialize dependencies ─────────────────────────────────────────

  const db = createDb();
  const redis = getRedisConnection();
  const queue = createAccumulationQueue();

  const solanaRpcUrl =
    process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const solanaConnection = new Connection(solanaRpcUrl, 'confirmed');

  // Wallet from env (required for pipeline)
  const walletKey = process.env.SOLANA_PRIVATE_KEY;
  if (!walletKey) {
    console.error('SOLANA_PRIVATE_KEY env var is required');
    process.exit(1);
  }
  const wallet = Keypair.fromSecretKey(bs58.decode(walletKey));

  const platformTreasury = process.env.PLATFORM_TREASURY_WALLET;
  if (!platformTreasury) {
    console.error('PLATFORM_TREASURY_WALLET env var is required');
    process.exit(1);
  }

  // ── Register cron schedule ──────────────────────────────────────────

  await queue.upsertJobScheduler(
    'accumulation-cron',
    { pattern: cronPattern },
    {
      name: 'accumulation-scan',
      opts: {
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 200 },
      },
    },
  );

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      module: 'scheduler',
      action: 'cronRegistered',
      pattern: cronPattern,
      schedulerId: 'accumulation-cron',
    }),
  );

  // ── Create worker ───────────────────────────────────────────────────

  // Bags SDK is optional — can be initialized only when needed
  // For now we pass a stub that will fail if claim phase is reached
  // without proper initialization. In production, initialize with real config.
  const bagsSDK = null as any; // TODO: Initialize BagsSDK from env when available

  const worker = createAccumulationWorker({
    db,
    redisConnection: redis,
    solanaConnection,
    pipelineDeps: {
      sdk: bagsSDK,
      wallet,
      platformTreasuryWallet: platformTreasury,
    },
  });

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      module: 'scheduler',
      action: 'workerReady',
      queue: 'accumulation-pipeline',
    }),
  );

  // ── Graceful shutdown ───────────────────────────────────────────────

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        module: 'scheduler',
        action: 'shutdown',
        signal,
      }),
    );

    try {
      await worker.close();
      await queue.close();
      await closeRedis();
      await closeDb();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          module: 'scheduler',
          action: 'shutdownError',
          error: msg,
        }),
      );
    }

    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Scheduler failed to start:', err);
  process.exit(1);
});

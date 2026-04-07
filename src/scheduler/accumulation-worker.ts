/**
 * BullMQ accumulation worker — polls active funds, checks SOL balance
 * against threshold, dispatches outbound pipeline runs with concurrency guards.
 *
 * Job handler flow:
 * 1. listFunds({ status: 'active' })
 * 2. For each fund with accumulationThresholdLamports set:
 *    a. Look up Solana treasury wallet
 *    b. Check SOL balance via connection.getBalance()
 *    c. Skip if balance < threshold or active pipeline run exists
 *    d. Dispatch runOutboundPipeline() (or resume if failed run exists)
 *    e. Update lastPipelineRunAt
 * 3. Per-fund errors are caught — one fund's failure doesn't block others
 */

import { Worker, type Job } from 'bullmq';
import { Connection, PublicKey } from '@solana/web3.js';
import { ACCUMULATION_QUEUE } from './queue.js';
import {
  listFunds,
  getFundWallets,
  getActivePipelineRuns,
  updateFundLastPipelineRun,
} from '../db/fund-repository.js';
import { runOutboundPipeline, resumeOutboundPipeline } from '../pipeline/outbound.js';
import type { OutboundPipelineOptions } from '../pipeline/types.js';
import type { AppDb } from '../db/connection.js';
import type { Redis } from 'ioredis';

// ── Structured logging ──────────────────────────────────────────────────

function log(action: string, data: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      module: 'scheduler',
      action,
      ...data,
    }),
  );
}

// ── Types ───────────────────────────────────────────────────────────────

export interface AccumulationWorkerOptions {
  /** Drizzle database instance */
  db: AppDb;
  /** IORedis connection for BullMQ */
  redisConnection: Redis;
  /** Solana RPC connection */
  solanaConnection: Connection;
  /** Pipeline dependencies (passed through to runOutboundPipeline) */
  pipelineDeps: Omit<OutboundPipelineOptions, 'fundId' | 'db' | 'connection'>;
}

// ── Worker factory ──────────────────────────────────────────────────────

/**
 * Create the BullMQ accumulation worker.
 *
 * The worker processes jobs from the accumulation queue. Each job triggers
 * a scan of all active funds, checking SOL balances and dispatching
 * pipeline runs when thresholds are exceeded.
 */
export function createAccumulationWorker(
  opts: AccumulationWorkerOptions,
): Worker {
  const { db, redisConnection, solanaConnection, pipelineDeps } = opts;

  const worker = new Worker(
    ACCUMULATION_QUEUE,
    async (_job: Job) => {
      log('jobStart', { jobId: _job.id });

      let funds;
      try {
        funds = await listFunds(db, { status: 'active' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('listFundsError', { error: msg });
        throw err; // BullMQ will retry per job options
      }

      log('fundsLoaded', { count: funds.length });

      if (funds.length === 0) {
        log('jobComplete', { result: 'no_active_funds' });
        return;
      }

      let dispatched = 0;
      let skipped = 0;
      let errored = 0;

      for (const fund of funds) {
        try {
          await processFund(fund, {
            db,
            solanaConnection,
            pipelineDeps,
          });
          dispatched++;
        } catch (err) {
          if (err instanceof SkipFund) {
            skipped++;
            // Already logged in processFund
          } else {
            errored++;
            const msg = err instanceof Error ? err.message : String(err);
            log('fundError', { fundId: fund.id, error: msg });
          }
        }
      }

      log('jobComplete', { dispatched, skipped, errored, total: funds.length });
    },
    {
      connection: redisConnection,
      concurrency: 1, // One accumulation scan at a time
    },
  );

  log('workerCreated', { queue: ACCUMULATION_QUEUE });

  return worker;
}

// ── Internal helpers ────────────────────────────────────────────────────

/** Sentinel error to signal "skip this fund" without counting as an error. */
class SkipFund extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SkipFund';
  }
}

interface ProcessFundDeps {
  db: AppDb;
  solanaConnection: Connection;
  pipelineDeps: Omit<OutboundPipelineOptions, 'fundId' | 'db' | 'connection'>;
}

async function processFund(
  fund: { id: string; accumulationThresholdLamports: string | null; [key: string]: unknown },
  deps: ProcessFundDeps,
): Promise<void> {
  const { db, solanaConnection, pipelineDeps } = deps;

  // Skip funds without threshold
  if (!fund.accumulationThresholdLamports) {
    log('skipFund', { fundId: fund.id, reason: 'no_threshold_set' });
    throw new SkipFund('no_threshold_set');
  }

  const threshold = BigInt(fund.accumulationThresholdLamports);

  // Get Solana treasury wallet
  const wallets = await getFundWallets(db, fund.id);
  const solanaWallet = wallets.find(
    (w) => w.chain === 'solana' && w.walletType === 'treasury',
  );

  if (!solanaWallet) {
    log('skipFund', {
      fundId: fund.id,
      reason: 'no_solana_treasury_wallet',
    });
    throw new SkipFund('no_solana_treasury_wallet');
  }

  // Check SOL balance
  let balance: number;
  try {
    balance = await solanaConnection.getBalance(
      new PublicKey(solanaWallet.address),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('balanceCheckError', { fundId: fund.id, error: msg });
    throw new Error(`Balance check failed for fund ${fund.id}: ${msg}`);
  }

  // Validate balance is numeric
  if (typeof balance !== 'number' || isNaN(balance)) {
    log('skipFund', {
      fundId: fund.id,
      reason: 'invalid_balance_response',
      balance: String(balance),
    });
    throw new Error(`Invalid balance response for fund ${fund.id}: ${balance}`);
  }

  log('checkFund', {
    fundId: fund.id,
    balance,
    threshold: threshold.toString(),
    aboveThreshold: BigInt(balance) > threshold,
  });

  if (BigInt(balance) <= threshold) {
    log('skipFund', {
      fundId: fund.id,
      reason: 'below_threshold',
      balance,
      threshold: threshold.toString(),
    });
    throw new SkipFund('below_threshold');
  }

  // Concurrency guard — check for active pipeline runs
  const activeRuns = await getActivePipelineRuns(db, fund.id);
  if (activeRuns.length > 0) {
    log('skipFund', {
      fundId: fund.id,
      reason: 'active_pipeline_run',
      runIds: activeRuns.map((r) => r.id),
    });
    throw new SkipFund('active_pipeline_run');
  }

  // Dispatch pipeline
  log('dispatchPipeline', { fundId: fund.id, balance });

  await runOutboundPipeline({
    ...pipelineDeps,
    fundId: fund.id,
    db,
    connection: solanaConnection,
  });

  // Update last pipeline run timestamp
  await updateFundLastPipelineRun(db, fund.id);

  log('dispatchPipeline', {
    fundId: fund.id,
    result: 'success',
  });
}

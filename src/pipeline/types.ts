/**
 * Outbound pipeline types — shapes for the claim → swap → fee → bridge orchestration.
 *
 * Kept separate from implementation so callers can import types without pulling
 * in the full dependency tree (sdk, connection, db).
 */

import type { Connection, Keypair } from '@solana/web3.js';
import type { BagsSDK } from '@bagsfm/bags-sdk';
import type { AppDb } from '../db/connection.js';

// ── Pipeline options ────────────────────────────────────────────────────

/** Everything the outbound pipeline needs to run. Dependency-injected. */
export interface OutboundPipelineOptions {
  /** Fund UUID in the database */
  fundId: string;
  /** Initialized Bags FM SDK instance */
  sdk: BagsSDK;
  /** Solana wallet keypair for signing transactions */
  wallet: Keypair;
  /** Solana RPC connection */
  connection: Connection;
  /** Drizzle database instance */
  db: AppDb;
  /** Base58 address of the platform treasury wallet (receives protocol fees) */
  platformTreasuryWallet: string;
}

// ── Pipeline result ─────────────────────────────────────────────────────

/** Per-phase transaction hashes collected during the pipeline run. */
export interface PipelineTxHashes {
  claim: string[];
  swap: string | null;
  feeTransfer: string | null;
  bridgeSend: string | null;
  bridgeReceive: string | null;
}

/** Result returned on successful pipeline completion. */
export interface OutboundPipelineResult {
  /** Database ID of the pipeline_runs row */
  pipelineRunId: string;
  /** Transaction hashes keyed by phase */
  txHashes: PipelineTxHashes;
  /** SOL amount claimed (lamports, string for bigint safety) */
  amountClaimed: string;
  /** USDC amount received from swap (atomic units, string) */
  amountSwapped: string;
  /** USDC amount deducted as protocol fee (atomic units, string) */
  feeDeducted: string;
  /** USDC amount sent to the bridge (atomic units, string) */
  amountBridged: string;
  /** deBridge order ID for fulfillment tracking */
  bridgeOrderId: string;
  /** Wall-clock duration of the entire pipeline run (ms) */
  durationMs: number;
}

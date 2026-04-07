/**
 * Outbound pipeline types — shapes for the claim → swap → fee → bridge orchestration.
 *
 * Kept separate from implementation so callers can import types without pulling
 * in the full dependency tree (sdk, connection, db).
 */

import type { Connection, Keypair } from '@solana/web3.js';
import type { BagsSDK } from '@bagsfm/bags-sdk';
import type { AppDb } from '../db/connection.js';
import type { Address } from 'viem';

// Use loose typing to avoid viem chain-specific PublicClient/WalletClient generics mismatch
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPublicClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWalletClient = any;

// ── Checkpoint recovery ─────────────────────────────────────────────────

/** Per-phase output data stored in the checkpoint. */
export interface CheckpointPhaseData {
  claiming?: {
    claimedLamports: number;
    signatures: string[];
  };
  swapping?: {
    outAmount: string;
    signature: string;
    inAmount: string;
  };
  fee?: {
    feeAmount: string;
    feeSignature: string | null;
    bridgeAmount: string;
  };
  bridging?: {
    orderId: string;
    fulfillTx: string | null;
    bridgeAmount: string;
    bridgeSendSignature: string;
  };
  investing?: {
    usdcToEthTxHash: string;
    investTxHash: string;
    amountInvested: string;
  };
}

/** Checkpoint persisted in pipeline_runs.metadata for crash recovery. */
export interface PipelineCheckpoint {
  completedPhases: string[];
  phaseData: CheckpointPhaseData;
}

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

  // ── EVM / investing phase (optional — backward compatible) ──────────
  /** Viem PublicClient for Base reads (required for investing phase) */
  evmPublicClient?: AnyPublicClient;
  /** Viem WalletClient for Base signing (required for investing phase) */
  evmWalletClient?: AnyWalletClient;
  /** Target BSKT contract address on Base (required for investing phase) */
  bsktAddress?: Address;

  // ── Resume support ─────────────────────────────────────────────────
  /** Existing pipeline run ID to resume (skips createPipelineRun if set) */
  pipelineRunId?: string;
  /** Checkpoint data from a previous partial run — phases listed here are skipped */
  resumeCheckpoint?: PipelineCheckpoint;
}

// ── Pipeline result ─────────────────────────────────────────────────────

/** Per-phase transaction hashes collected during the pipeline run. */
export interface PipelineTxHashes {
  claim: string[];
  swap: string | null;
  feeTransfer: string | null;
  bridgeSend: string | null;
  bridgeReceive: string | null;
  /** USDC→ETH swap transaction hash on Base (null if not yet swapped) */
  usdcToEthTxHash: string | null;
  /** BSKT contribute() transaction hash on Base (null if not yet invested) */
  investTxHash: string | null;
}

// ── Inbound pipeline types ──────────────────────────────────────────────

/** Per-phase output data stored in the inbound checkpoint. */
export interface InboundCheckpointPhaseData {
  redeeming?: {
    txHash: string;
    ethReceived: string;
  };
  swapping?: {
    txHash: string;
    usdcReceived: string;
  };
  bridging?: {
    orderId: string;
    bridgeSendTxHash: string;
    bridgeReceiveTxHash: string | null;
    bridgeAmount: string;
  };
}

/** Checkpoint persisted in pipeline_runs.metadata for inbound crash recovery. */
export interface InboundPipelineCheckpoint {
  completedPhases: string[];
  phaseData: InboundCheckpointPhaseData;
}

/** Everything the inbound pipeline needs to run. Dependency-injected. */
export interface InboundPipelineOptions {
  /** Fund UUID in the database */
  fundId: string;
  /** Drizzle database instance */
  db: AppDb;
  /** Viem PublicClient for Base reads */
  evmPublicClient: AnyPublicClient;
  /** Viem WalletClient for Base signing */
  evmWalletClient: AnyWalletClient;
  /** Recipient address on Solana for the bridge */
  solanaRecipientAddress: string;
  /** BSKT NFT contract address on Base */
  bsktAddress: Address;
  /** BSKTPair address (optional — redeem reads from BSKT if not given) */
  bsktPairAddress?: Address;
  /** Existing pipeline run ID to resume */
  pipelineRunId?: string;
  /** Checkpoint from a previous partial run — listed phases are skipped */
  resumeCheckpoint?: InboundPipelineCheckpoint;
}

/** Per-phase transaction hashes collected during the inbound pipeline. */
export interface InboundTxHashes {
  redeemTx: string | null;
  swapTx: string | null;
  bridgeSendTx: string | null;
  bridgeReceiveTx: string | null;
}

/** Result returned on successful inbound pipeline completion. */
export interface InboundPipelineResult {
  /** Database ID of the pipeline_runs row */
  pipelineRunId: string;
  /** Transaction hashes keyed by phase */
  txHashes: InboundTxHashes;
  /** ETH received from BSKT redemption (wei as string) */
  amountRedeemed: string;
  /** USDC received from ETH→USDC swap (atomic units as string) */
  amountSwapped: string;
  /** USDC amount sent to bridge (atomic units as string) */
  amountBridged: string;
  /** Wall-clock duration of the entire pipeline (ms) */
  durationMs: number;
}

// ── Outbound result ─────────────────────────────────────────────────────

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
  /** ETH amount invested into the BSKT via contribute() (wei as string, empty if not yet invested) */
  amountInvested: string;
  /** Wall-clock duration of the entire pipeline run (ms) */
  durationMs: number;
}

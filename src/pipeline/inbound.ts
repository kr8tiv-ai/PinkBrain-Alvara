/**
 * Inbound pipeline orchestrator — redeem BSKT → swap ETH→USDC → bridge USDC to Solana.
 *
 * Mirrors the outbound pipeline pattern: each phase persists state via advisory
 * checkpoints in pipeline_runs.metadata. On failure, the pipeline can be resumed
 * from the last completed phase.
 *
 * Phases:
 *   1. Redeeming — call redeemBSKTForETH() → get ETH
 *   2. Swapping  — call swapEthToUsdc() → get USDC
 *   3. Bridging  — createBridgeOrder (Base→Solana, USDC) → submitEvmBridgeTransaction → waitForFulfillment
 */

import type {
  InboundPipelineOptions,
  InboundPipelineResult,
  InboundTxHashes,
  InboundPipelineCheckpoint,
  InboundCheckpointPhaseData,
} from './types.js';
import { redeemBSKTForETH } from '../alvara/redeem.js';
import { swapEthToUsdc } from '../evm/swap.js';
import { createBridgeOrder, waitForFulfillment } from '../debridge/api.js';
import { submitEvmBridgeTransaction } from '../debridge/evm-tx.js';
import { DeBridgeChainId } from '../debridge/types.js';
import { KNOWN_ADDRESSES } from '../config/chains.js';
import { SOLANA_KNOWN_ADDRESSES } from '../config/solana.js';
import {
  getFundById,
  getFundWallets,
  createPipelineRun,
  updatePipelineRun,
  recordTransaction,
  getPipelineRunById,
} from '../db/fund-repository.js';

// ── Constants ───────────────────────────────────────────────────────────

/** USDC on Solana — bridge destination token */
const SOLANA_USDC = SOLANA_KNOWN_ADDRESSES.USDC;

// ── Logging ─────────────────────────────────────────────────────────────

function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'inbound-pipeline',
    phase,
    action,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ── Checkpoint helpers ──────────────────────────────────────────────────

/**
 * Persist checkpoint state after a phase completes.
 * Advisory — a write failure logs a warning but never blocks the pipeline.
 */
async function writeCheckpoint(
  db: unknown,
  runId: string,
  phase: string,
  phaseData: unknown,
  existingCheckpoint: InboundPipelineCheckpoint,
): Promise<InboundPipelineCheckpoint> {
  const updated: InboundPipelineCheckpoint = {
    completedPhases: [...existingCheckpoint.completedPhases, phase],
    phaseData: { ...existingCheckpoint.phaseData, [phase]: phaseData } as InboundCheckpointPhaseData,
  };

  try {
    await updatePipelineRun(db as any, runId, {
      metadata: { checkpoint: updated },
    });
    log('checkpoint', 'written', { runId, phase, completedPhases: updated.completedPhases });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('checkpoint', 'writeFailed', { runId, phase, error: msg });
    // Advisory — don't block the pipeline on a checkpoint write failure
  }

  return updated;
}

/**
 * Validate and normalize an inbound checkpoint from DB metadata.
 * Returns an empty checkpoint for missing, null, or malformed data.
 */
export function parseInboundCheckpoint(metadata: unknown): InboundPipelineCheckpoint {
  const empty: InboundPipelineCheckpoint = { completedPhases: [], phaseData: {} };

  if (!metadata || typeof metadata !== 'object') return empty;

  const meta = metadata as Record<string, unknown>;
  if (!meta.checkpoint || typeof meta.checkpoint !== 'object') return empty;

  const cp = meta.checkpoint as Record<string, unknown>;
  if (!Array.isArray(cp.completedPhases)) return empty;
  if (!cp.phaseData || typeof cp.phaseData !== 'object') return empty;

  const KNOWN_PHASES = ['redeeming', 'swapping', 'bridging'];
  const validPhases = (cp.completedPhases as unknown[]).filter(
    (p): p is string => typeof p === 'string' && KNOWN_PHASES.includes(p),
  );

  return {
    completedPhases: validPhases,
    phaseData: cp.phaseData as InboundCheckpointPhaseData,
  };
}

// ── Pipeline orchestrator ───────────────────────────────────────────────

/**
 * Run the full inbound pipeline: redeem → swap → bridge.
 *
 * On failure at any phase, the pipeline run is marked as failed with the error
 * message. Callers should inspect the pipeline_runs table for diagnostic context.
 */
export async function runInboundPipeline(
  opts: InboundPipelineOptions,
): Promise<InboundPipelineResult> {
  const startTime = Date.now();
  const {
    fundId, db, evmPublicClient, evmWalletClient,
    solanaRecipientAddress, bsktAddress, bsktPairAddress,
  } = opts;

  const txHashes: InboundTxHashes = {
    redeemTx: null,
    swapTx: null,
    bridgeSendTx: null,
    bridgeReceiveTx: null,
  };

  // Initialize checkpoint
  let checkpoint: InboundPipelineCheckpoint = opts.resumeCheckpoint
    ? { ...opts.resumeCheckpoint }
    : { completedPhases: [], phaseData: {} };

  const isResume = checkpoint.completedPhases.length > 0;
  log('pipeline', 'start', { fundId, isResume, resumedPhases: checkpoint.completedPhases });

  // ── Validate fund ──────────────────────────────────────────────────

  const fund = await getFundById(db, fundId);
  if (!fund) {
    throw new Error(`Inbound pipeline: fund ${fundId} not found`);
  }
  if (fund.status !== 'active' && fund.status !== 'divesting') {
    throw new Error(
      `Inbound pipeline: fund ${fundId} status is '${fund.status}', expected 'active' or 'divesting'`,
    );
  }

  log('pipeline', 'validated', { fundId, fundName: fund.name, status: fund.status });

  // ── Create or reuse pipeline run ─────────────────────────────────────

  let runId: string;
  if (opts.pipelineRunId) {
    runId = opts.pipelineRunId;
    await updatePipelineRun(db, runId, { status: 'running' });
    log('pipeline', 'runResumed', { runId });
  } else {
    const pipelineRun = await createPipelineRun(db, {
      fundId,
      direction: 'inbound',
      phase: 'divesting',
      status: 'running',
      startedAt: new Date(),
    });
    runId = pipelineRun.id;
    log('pipeline', 'runCreated', { runId });
  }

  try {
    // ── Phase 1: Redeem BSKT → ETH ────────────────────────────────

    let ethReceived = 0n;

    if (checkpoint.completedPhases.includes('redeeming')) {
      const cpRedeem = checkpoint.phaseData.redeeming;
      if (cpRedeem) {
        ethReceived = BigInt(cpRedeem.ethReceived);
        txHashes.redeemTx = cpRedeem.txHash;
      }
      log('redeeming', 'restoredFromCheckpoint', {
        ethReceived: String(ethReceived),
        txHash: txHashes.redeemTx,
      });
    } else {
      log('redeeming', 'start', { bsktAddress, runId });

      const redeemResult = await redeemBSKTForETH({
        publicClient: evmPublicClient,
        walletClient: evmWalletClient,
        bsktAddress,
        bsktPairAddress,
      });

      txHashes.redeemTx = redeemResult.txHash;
      ethReceived = redeemResult.ethReceived;

      log('redeeming', 'done', {
        txHash: redeemResult.txHash,
        ethReceived: String(ethReceived),
        lpBurned: String(redeemResult.lpBalanceBefore - redeemResult.lpBalanceAfter),
      });

      await recordTransaction(db, {
        fundId,
        pipelineRunId: runId,
        chain: 'base',
        txHash: redeemResult.txHash!,
        operation: 'bskt_redeem',
        amount: String(ethReceived),
        token: 'ETH',
      });

      checkpoint = await writeCheckpoint(db, runId, 'redeeming', {
        txHash: redeemResult.txHash,
        ethReceived: String(ethReceived),
      }, checkpoint);
    }

    if (ethReceived <= 0n) {
      await updatePipelineRun(db, runId, {
        status: 'completed',
        completedAt: new Date(),
        metadata: { earlyExit: 'zero_eth_redeemed' },
      });

      log('pipeline', 'earlyExit', { reason: 'zero ETH redeemed' });

      return {
        pipelineRunId: runId,
        txHashes,
        amountRedeemed: '0',
        amountSwapped: '0',
        amountBridged: '0',
        durationMs: Date.now() - startTime,
      };
    }

    await updatePipelineRun(db, runId, { phase: 'swapping' });

    // ── Phase 2: Swap ETH → USDC ──────────────────────────────────

    let usdcReceived = 0n;

    if (checkpoint.completedPhases.includes('swapping')) {
      const cpSwap = checkpoint.phaseData.swapping;
      if (cpSwap) {
        usdcReceived = BigInt(cpSwap.usdcReceived);
        txHashes.swapTx = cpSwap.txHash;
      }
      log('swapping', 'restoredFromCheckpoint', {
        usdcReceived: String(usdcReceived),
        txHash: txHashes.swapTx,
      });
    } else {
      log('swapping', 'start', { ethAmount: String(ethReceived) });

      const swapResult = await swapEthToUsdc({
        publicClient: evmPublicClient,
        walletClient: evmWalletClient,
        ethAmount: ethReceived,
      });

      txHashes.swapTx = swapResult.txHash;
      usdcReceived = swapResult.usdcReceived;

      log('swapping', 'done', {
        txHash: swapResult.txHash,
        usdcReceived: String(usdcReceived),
      });

      await recordTransaction(db, {
        fundId,
        pipelineRunId: runId,
        chain: 'base',
        txHash: swapResult.txHash,
        operation: 'swap',
        amount: String(usdcReceived),
        token: KNOWN_ADDRESSES.USDC,
      });

      checkpoint = await writeCheckpoint(db, runId, 'swapping', {
        txHash: swapResult.txHash,
        usdcReceived: String(usdcReceived),
      }, checkpoint);
    }

    await updatePipelineRun(db, runId, { phase: 'bridging' });

    // ── Phase 3: Bridge USDC Base → Solana ─────────────────────────

    if (checkpoint.completedPhases.includes('bridging')) {
      const cpBridge = checkpoint.phaseData.bridging;
      if (cpBridge) {
        txHashes.bridgeSendTx = cpBridge.bridgeSendTxHash;
        txHashes.bridgeReceiveTx = cpBridge.bridgeReceiveTxHash;
      }
      log('bridging', 'restoredFromCheckpoint', {
        bridgeSend: txHashes.bridgeSendTx,
        bridgeReceive: txHashes.bridgeReceiveTx,
      });
    } else {
      log('bridging', 'start', {
        usdcAmount: String(usdcReceived),
        recipient: solanaRecipientAddress,
      });

      const bridgeOrder = await createBridgeOrder({
        srcChainId: DeBridgeChainId.BASE,
        srcChainTokenIn: KNOWN_ADDRESSES.USDC,
        srcChainTokenInAmount: String(usdcReceived),
        dstChainId: DeBridgeChainId.SOLANA,
        dstChainTokenOut: SOLANA_USDC,
        dstChainTokenOutRecipient: solanaRecipientAddress,
        prependOperatingExpenses: true,
      });

      log('bridging', 'orderCreated', { orderId: bridgeOrder.orderId });

      // Validate tx data
      if (!bridgeOrder.tx?.data) {
        throw new Error(
          `DeBridge create-tx returned no tx.data for order ${bridgeOrder.orderId}`,
        );
      }

      // Submit the EVM bridge transaction (approve USDC + send)
      const bridgeResult = await submitEvmBridgeTransaction({
        publicClient: evmPublicClient,
        walletClient: evmWalletClient,
        txData: bridgeOrder.tx,
        usdcAmount: usdcReceived,
      });

      txHashes.bridgeSendTx = bridgeResult.txHash;

      log('bridging', 'sent', {
        txHash: bridgeResult.txHash,
        orderId: bridgeOrder.orderId,
      });

      await recordTransaction(db, {
        fundId,
        pipelineRunId: runId,
        chain: 'base',
        txHash: bridgeResult.txHash,
        operation: 'bridge_send',
        amount: String(usdcReceived),
        token: KNOWN_ADDRESSES.USDC,
      });

      // Wait for fulfillment on Solana
      log('bridging', 'waitingForFulfillment', { orderId: bridgeOrder.orderId });

      const fulfillment = await waitForFulfillment(bridgeOrder.orderId);

      if (fulfillment.fulfillTransactionHash) {
        txHashes.bridgeReceiveTx = fulfillment.fulfillTransactionHash;

        await recordTransaction(db, {
          fundId,
          pipelineRunId: runId,
          chain: 'solana',
          txHash: fulfillment.fulfillTransactionHash,
          operation: 'bridge_receive',
          amount: String(usdcReceived),
          token: SOLANA_USDC,
        });
      }

      log('bridging', 'fulfilled', {
        orderId: bridgeOrder.orderId,
        status: fulfillment.status,
        fulfillTx: fulfillment.fulfillTransactionHash,
      });

      checkpoint = await writeCheckpoint(db, runId, 'bridging', {
        orderId: bridgeOrder.orderId,
        bridgeSendTxHash: bridgeResult.txHash,
        bridgeReceiveTxHash: fulfillment.fulfillTransactionHash ?? null,
        bridgeAmount: String(usdcReceived),
      }, checkpoint);
    }

    // ── Complete ────────────────────────────────────────────────────

    await updatePipelineRun(db, runId, {
      status: 'completed',
      completedAt: new Date(),
    });

    const result: InboundPipelineResult = {
      pipelineRunId: runId,
      txHashes,
      amountRedeemed: String(ethReceived),
      amountSwapped: String(usdcReceived),
      amountBridged: String(usdcReceived),
      durationMs: Date.now() - startTime,
    };

    log('pipeline', 'complete', {
      runId,
      durationMs: result.durationMs,
      redeemed: result.amountRedeemed,
      swapped: result.amountSwapped,
      bridged: result.amountBridged,
    });

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    log('pipeline', 'error', { runId, error: message });

    await updatePipelineRun(db, runId, {
      status: 'failed',
      error: message,
      completedAt: new Date(),
    });

    throw new Error(`Inbound pipeline failed [run=${runId}]: ${message}`);
  }
}

// ── Resume helper ───────────────────────────────────────────────────────

/**
 * Resume a failed inbound pipeline run from its last checkpoint.
 *
 * Reads the pipeline run from DB, extracts checkpoint from metadata,
 * and calls `runInboundPipeline()` with the checkpoint so completed
 * phases are skipped.
 */
export async function resumeInboundPipeline(
  opts: InboundPipelineOptions & { pipelineRunId: string },
): Promise<InboundPipelineResult> {
  const { pipelineRunId, db } = opts;

  log('resume', 'start', { pipelineRunId });

  const pipelineRun = await getPipelineRunById(db, pipelineRunId);
  if (!pipelineRun) {
    throw new Error(`resumeInboundPipeline: pipeline run ${pipelineRunId} not found`);
  }

  const checkpoint = parseInboundCheckpoint(pipelineRun.metadata);

  log('resume', 'checkpointLoaded', {
    pipelineRunId,
    completedPhases: checkpoint.completedPhases,
    hasPhaseData: Object.keys(checkpoint.phaseData).length > 0,
  });

  // If all phases complete, reconstruct result
  const ALL_PHASES = ['redeeming', 'swapping', 'bridging'];
  const allDone = ALL_PHASES.every((p) => checkpoint.completedPhases.includes(p));
  if (allDone) {
    log('resume', 'allPhasesComplete', { pipelineRunId });
    const cp = checkpoint.phaseData;
    return {
      pipelineRunId,
      txHashes: {
        redeemTx: cp.redeeming?.txHash ?? null,
        swapTx: cp.swapping?.txHash ?? null,
        bridgeSendTx: cp.bridging?.bridgeSendTxHash ?? null,
        bridgeReceiveTx: cp.bridging?.bridgeReceiveTxHash ?? null,
      },
      amountRedeemed: cp.redeeming?.ethReceived ?? '0',
      amountSwapped: cp.swapping?.usdcReceived ?? '0',
      amountBridged: cp.bridging?.bridgeAmount ?? '0',
      durationMs: 0,
    };
  }

  return runInboundPipeline({
    ...opts,
    pipelineRunId,
    resumeCheckpoint: checkpoint,
  });
}

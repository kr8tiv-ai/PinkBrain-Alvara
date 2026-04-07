/**
 * Outbound pipeline orchestrator — claim → swap → protocol fee → bridge.
 *
 * Orchestrates the full outbound flow for a fund:
 *   1. Claim reflection fees from Bags (SOL)
 *   2. Swap SOL → USDC via Jupiter
 *   3. Deduct protocol fee (SPL transfer to platform treasury)
 *   4. Bridge remaining USDC to Base via deBridge
 *
 * Each phase persists state to the database so a failure mid-pipeline
 * leaves an auditable trail. The pipeline_runs row tracks the current phase
 * and status; individual transactions are recorded in the transactions table.
 *
 * Constraints:
 * - No @solana/spl-token dependency — SPL transfer built from raw primitives.
 * - BigInt for all USDC arithmetic (atomic units can exceed Number.MAX_SAFE_INTEGER).
 * - All external deps injected via OutboundPipelineOptions.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import type { OutboundPipelineOptions, OutboundPipelineResult, PipelineTxHashes } from './types.js';
import { getClaimTransactions } from '../bags/fee-claim.js';
import { swapSolToUsdc } from '../jupiter/swap.js';
import { createBridgeOrder, waitForFulfillment } from '../debridge/api.js';
import { prepareSolanaTransaction, sendAndConfirmBridgeTransaction } from '../debridge/solana-tx.js';
import { DeBridgeChainId } from '../debridge/types.js';
import { SOLANA_KNOWN_ADDRESSES } from '../config/solana.js';
import {
  getFundById,
  getFundWallets,
  createPipelineRun,
  updatePipelineRun,
  recordTransaction,
} from '../db/fund-repository.js';

// ── Constants ───────────────────────────────────────────────────────────

/** USDC on Base (Circle native) */
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Buffer reserved for Solana transaction fees (lamports) — keeps enough SOL for signing */
const TX_FEE_BUFFER_LAMPORTS = 10_000;

/** SPL Token Program ID */
const TOKEN_PROGRAM_ID = new PublicKey(SOLANA_KNOWN_ADDRESSES.SPL_TOKEN_PROGRAM_ID);

/** Associated Token Account Program ID */
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** USDC mint on Solana */
const USDC_MINT = new PublicKey(SOLANA_KNOWN_ADDRESSES.USDC);

// ── Structured logging ──────────────────────────────────────────────────

function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'pipeline',
    phase,
    action,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ── SPL helpers (no @solana/spl-token dependency) ───────────────────────

/**
 * Derive the Associated Token Account address for a given owner and mint.
 * Uses the standard PDA seeds: [owner, TOKEN_PROGRAM_ID, mint] with ATA_PROGRAM_ID.
 */
function deriveATA(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ATA_PROGRAM_ID,
  );
  return ata;
}

/**
 * Build a raw SPL Token Transfer instruction (instruction index 3).
 *
 * Layout: 1 byte instruction discriminator (3 = Transfer) + 8 bytes little-endian u64 amount.
 * Accounts: [source ATA (writable), dest ATA (writable), owner (signer)].
 */
function buildSplTransferInstruction(
  sourceAta: PublicKey,
  destAta: PublicKey,
  owner: PublicKey,
  amount: bigint,
): TransactionInstruction {
  // Data: instruction index (3) + amount as LE u64
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0); // Transfer = 3
  data.writeBigUInt64LE(amount, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}

// ── Pipeline orchestrator ───────────────────────────────────────────────

/**
 * Run the full outbound pipeline: claim → swap → fee deduction → bridge.
 *
 * On failure at any phase, the pipeline run is marked as failed with the error
 * message. Callers should inspect the pipeline_runs table for diagnostic context.
 *
 * @throws Never — errors are caught, persisted, and re-thrown with pipeline context.
 */
export async function runOutboundPipeline(
  opts: OutboundPipelineOptions,
): Promise<OutboundPipelineResult> {
  const startTime = Date.now();
  const { fundId, sdk, wallet, connection, db, platformTreasuryWallet } = opts;

  const txHashes: PipelineTxHashes = {
    claim: [],
    swap: null,
    feeTransfer: null,
    bridgeSend: null,
    bridgeReceive: null,
    investTxHash: null,
  };

  log('pipeline', 'start', { fundId });

  // ── Validate fund ──────────────────────────────────────────────────

  const fund = await getFundById(db, fundId);
  if (!fund) {
    throw new Error(`Outbound pipeline: fund ${fundId} not found`);
  }
  if (fund.status !== 'active') {
    throw new Error(
      `Outbound pipeline: fund ${fundId} status is '${fund.status}', expected 'active'`,
    );
  }

  // Get fund wallets — need Base wallet for bridge recipient
  const wallets = await getFundWallets(db, fundId);
  const baseWallet = wallets.find((w) => w.chain === 'base');
  if (!baseWallet) {
    throw new Error(
      `Outbound pipeline: fund ${fundId} has no Base wallet — cannot bridge`,
    );
  }

  log('pipeline', 'validated', {
    fundId,
    fundName: fund.name,
    protocolFeeBps: fund.protocolFeeBps,
    baseWallet: baseWallet.address,
  });

  // ── Create pipeline run ────────────────────────────────────────────

  const pipelineRun = await createPipelineRun(db, {
    fundId,
    direction: 'outbound',
    phase: 'claiming',
    status: 'running',
    startedAt: new Date(),
  });
  const runId = pipelineRun.id;

  log('pipeline', 'runCreated', { runId });

  try {
    // ── Phase 1: Claim ─────────────────────────────────────────────

    log('claim', 'start', { runId, wallet: wallet.publicKey.toBase58(), mint: fund.tokenMint });

    const balanceBefore = await connection.getBalance(wallet.publicKey);
    log('claim', 'balanceBefore', { lamports: balanceBefore });

    const claimTxs = await getClaimTransactions(sdk, wallet.publicKey.toBase58(), fund.tokenMint);

    let claimedLamports = 0;

    if (claimTxs && claimTxs.length > 0) {
      // SDK returns legacy Transaction objects — sign and send each directly
      const claimSignatures: string[] = [];

      for (let i = 0; i < claimTxs.length; i++) {
        const tx = claimTxs[i];
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        tx.sign(wallet);

        const signature = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });

        const confirmation = await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed',
        );

        if (confirmation.value.err) {
          throw new Error(
            `Claim transaction ${i} failed on-chain: ${JSON.stringify(confirmation.value.err)}`,
          );
        }

        log('claim', 'txConfirmed', { index: i, signature });
        claimSignatures.push(signature);
      }

      txHashes.claim = claimSignatures;

      const balanceAfter = await connection.getBalance(wallet.publicKey);
      claimedLamports = balanceAfter - balanceBefore;

      log('claim', 'done', {
        signatures: claimSignatures.length,
        claimedLamports,
      });

      // Record claim transaction(s)
      if (claimSignatures.length > 0) {
        await recordTransaction(db, {
          fundId,
          pipelineRunId: runId,
          chain: 'solana',
          txHash: claimSignatures[0],
          operation: 'fee_claim',
          amount: String(claimedLamports),
          token: 'SOL',
        });
      }
    } else {
      log('claim', 'skip', { reason: 'no claim transactions returned' });
    }

    if (claimedLamports <= TX_FEE_BUFFER_LAMPORTS) {
      // Nothing meaningful claimed — complete early
      await updatePipelineRun(db, runId, {
        status: 'completed',
        completedAt: new Date(),
        metadata: { earlyExit: 'insufficient_claim', claimedLamports },
      });

      log('pipeline', 'earlyExit', { reason: 'claim too small', claimedLamports });

      return {
        pipelineRunId: runId,
        txHashes,
        amountClaimed: String(claimedLamports),
        amountSwapped: '0',
        feeDeducted: '0',
        amountBridged: '0',
        bridgeOrderId: '',
        amountInvested: '0',
        durationMs: Date.now() - startTime,
      };
    }

    await updatePipelineRun(db, runId, { phase: 'swapping' });

    // ── Phase 2: Swap SOL → USDC ───────────────────────────────────

    const swapAmountLamports = claimedLamports - TX_FEE_BUFFER_LAMPORTS;

    log('swap', 'start', { swapAmountLamports });

    const swapResult = await swapSolToUsdc(swapAmountLamports, wallet, connection);
    txHashes.swap = swapResult.signature;

    log('swap', 'done', {
      signature: swapResult.signature,
      inAmount: swapResult.inAmount,
      outAmount: swapResult.outAmount,
    });

    await recordTransaction(db, {
      fundId,
      pipelineRunId: runId,
      chain: 'solana',
      txHash: swapResult.signature,
      operation: 'swap',
      amount: swapResult.outAmount,
      token: SOLANA_KNOWN_ADDRESSES.USDC,
    });

    // ── Phase 3: Protocol fee deduction ────────────────────────────

    const swapOutUsdc = BigInt(swapResult.outAmount);
    const feeAmount = (swapOutUsdc * BigInt(fund.protocolFeeBps)) / 10000n;
    const bridgeAmount = swapOutUsdc - feeAmount;

    log('fee', 'computed', {
      swapOutUsdc: swapOutUsdc.toString(),
      protocolFeeBps: fund.protocolFeeBps,
      feeAmount: feeAmount.toString(),
      bridgeAmount: bridgeAmount.toString(),
    });

    if (feeAmount > 0n) {
      const sourceAta = deriveATA(wallet.publicKey, USDC_MINT);
      const treasuryPubkey = new PublicKey(platformTreasuryWallet);
      const destAta = deriveATA(treasuryPubkey, USDC_MINT);

      const transferIx = buildSplTransferInstruction(sourceAta, destAta, wallet.publicKey, feeAmount);

      const feeTx = new Transaction().add(transferIx);
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      feeTx.recentBlockhash = blockhash;
      feeTx.feePayer = wallet.publicKey;
      feeTx.sign(wallet);

      const feeSignature = await connection.sendRawTransaction(feeTx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });

      // Confirm the fee transfer
      const feeBlockhash = await connection.getLatestBlockhash('confirmed');
      const feeConfirmation = await connection.confirmTransaction(
        {
          signature: feeSignature,
          blockhash: feeBlockhash.blockhash,
          lastValidBlockHeight: feeBlockhash.lastValidBlockHeight,
        },
        'confirmed',
      );

      if (feeConfirmation.value.err) {
        throw new Error(
          `Protocol fee transfer failed on-chain: ${JSON.stringify(feeConfirmation.value.err)}`,
        );
      }

      txHashes.feeTransfer = feeSignature;

      log('fee', 'transferred', {
        signature: feeSignature,
        amount: feeAmount.toString(),
        treasury: platformTreasuryWallet,
      });

      await recordTransaction(db, {
        fundId,
        pipelineRunId: runId,
        chain: 'solana',
        txHash: feeSignature,
        operation: 'fee_claim',
        amount: feeAmount.toString(),
        token: SOLANA_KNOWN_ADDRESSES.USDC,
      });
    } else {
      log('fee', 'skip', { reason: 'zero fee (0 bps or too small)' });
    }

    await updatePipelineRun(db, runId, { phase: 'bridging' });

    // ── Phase 4: Bridge USDC → Base ────────────────────────────────

    log('bridge', 'start', {
      bridgeAmount: bridgeAmount.toString(),
      recipient: baseWallet.address,
    });

    const bridgeOrder = await createBridgeOrder({
      srcChainId: DeBridgeChainId.SOLANA,
      srcChainTokenIn: SOLANA_KNOWN_ADDRESSES.USDC,
      srcChainTokenInAmount: bridgeAmount.toString(),
      dstChainId: DeBridgeChainId.BASE,
      dstChainTokenOut: BASE_USDC,
      dstChainTokenOutRecipient: baseWallet.address,
      prependOperatingExpenses: true,
    });

    log('bridge', 'orderCreated', { orderId: bridgeOrder.orderId });

    // Prepare and send the bridge transaction (hex → sign → submit)
    const signedBridgeTx = await prepareSolanaTransaction(
      connection,
      bridgeOrder.tx.data,
      wallet,
    );

    const bridgeSendSig = await sendAndConfirmBridgeTransaction(connection, signedBridgeTx);
    txHashes.bridgeSend = bridgeSendSig;

    log('bridge', 'sent', { signature: bridgeSendSig, orderId: bridgeOrder.orderId });

    await recordTransaction(db, {
      fundId,
      pipelineRunId: runId,
      chain: 'solana',
      txHash: bridgeSendSig,
      operation: 'bridge_send',
      amount: bridgeAmount.toString(),
      token: SOLANA_KNOWN_ADDRESSES.USDC,
    });

    // Wait for deBridge fulfillment on the destination chain
    log('bridge', 'waitingForFulfillment', { orderId: bridgeOrder.orderId });

    const fulfillment = await waitForFulfillment(bridgeOrder.orderId);

    if (fulfillment.fulfillTransactionHash) {
      txHashes.bridgeReceive = fulfillment.fulfillTransactionHash;

      await recordTransaction(db, {
        fundId,
        pipelineRunId: runId,
        chain: 'base',
        txHash: fulfillment.fulfillTransactionHash,
        operation: 'bridge_receive',
        amount: bridgeAmount.toString(),
        token: BASE_USDC,
      });
    }

    log('bridge', 'fulfilled', {
      orderId: bridgeOrder.orderId,
      status: fulfillment.status,
      fulfillTx: fulfillment.fulfillTransactionHash,
    });

    // ── Complete ────────────────────────────────────────────────────

    await updatePipelineRun(db, runId, {
      status: 'completed',
      completedAt: new Date(),
    });

    const result: OutboundPipelineResult = {
      pipelineRunId: runId,
      txHashes,
      amountClaimed: String(claimedLamports),
      amountSwapped: swapResult.outAmount,
      feeDeducted: feeAmount.toString(),
      amountBridged: bridgeAmount.toString(),
      bridgeOrderId: bridgeOrder.orderId,
      amountInvested: '0',
      durationMs: Date.now() - startTime,
    };

    log('pipeline', 'complete', {
      runId,
      durationMs: result.durationMs,
      claimed: result.amountClaimed,
      swapped: result.amountSwapped,
      fee: result.feeDeducted,
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

    throw new Error(`Outbound pipeline failed [run=${runId}]: ${message}`);
  }
}

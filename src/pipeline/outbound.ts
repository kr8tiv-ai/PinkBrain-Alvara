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
import type { OutboundPipelineOptions, OutboundPipelineResult, PipelineTxHashes, PipelineCheckpoint, CheckpointPhaseData } from './types.js';
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
  getPipelineRunById,
} from '../db/fund-repository.js';
import { swapUsdcToEth } from '../evm/swap.js';
import { contributeToBSKT } from '../alvara/contribute.js';
import { KNOWN_ADDRESSES } from '../config/chains.js';
import { formatEther } from 'viem';

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
  existingCheckpoint: PipelineCheckpoint,
): Promise<PipelineCheckpoint> {
  const updated: PipelineCheckpoint = {
    completedPhases: [...existingCheckpoint.completedPhases, phase],
    phaseData: { ...existingCheckpoint.phaseData, [phase]: phaseData } as CheckpointPhaseData,
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
 * Validate and normalize a checkpoint from DB metadata.
 * Returns an empty checkpoint for missing, null, or malformed data.
 */
export function parseCheckpoint(metadata: unknown): PipelineCheckpoint {
  const empty: PipelineCheckpoint = { completedPhases: [], phaseData: {} };

  if (!metadata || typeof metadata !== 'object') return empty;

  const meta = metadata as Record<string, unknown>;
  if (!meta.checkpoint || typeof meta.checkpoint !== 'object') return empty;

  const cp = meta.checkpoint as Record<string, unknown>;
  if (!Array.isArray(cp.completedPhases)) return empty;
  if (!cp.phaseData || typeof cp.phaseData !== 'object') return empty;

  // Filter to only known phases
  const KNOWN_PHASES = ['claiming', 'swapping', 'fee', 'bridging', 'investing'];
  const validPhases = (cp.completedPhases as unknown[]).filter(
    (p): p is string => typeof p === 'string' && KNOWN_PHASES.includes(p),
  );

  return {
    completedPhases: validPhases,
    phaseData: cp.phaseData as CheckpointPhaseData,
  };
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
    usdcToEthTxHash: null,
    investTxHash: null,
  };

  // Initialize checkpoint — either from resume or empty
  let checkpoint: PipelineCheckpoint = opts.resumeCheckpoint
    ? { ...opts.resumeCheckpoint }
    : { completedPhases: [], phaseData: {} };

  const isResume = checkpoint.completedPhases.length > 0;
  log('pipeline', 'start', { fundId, isResume, resumedPhases: checkpoint.completedPhases });

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

  // ── Create or reuse pipeline run ─────────────────────────────────────

  let runId: string;
  if (opts.pipelineRunId) {
    runId = opts.pipelineRunId;
    await updatePipelineRun(db, runId, { status: 'running' });
    log('pipeline', 'runResumed', { runId });
  } else {
    const pipelineRun = await createPipelineRun(db, {
      fundId,
      direction: 'outbound',
      phase: 'claiming',
      status: 'running',
      startedAt: new Date(),
    });
    runId = pipelineRun.id;
    log('pipeline', 'runCreated', { runId });
  }

  try {
    // ── Phase 1: Claim ─────────────────────────────────────────────

    let claimedLamports = 0;

    if (checkpoint.completedPhases.includes('claiming')) {
      // Restore from checkpoint
      const cpClaim = checkpoint.phaseData.claiming;
      if (cpClaim) {
        claimedLamports = cpClaim.claimedLamports;
        txHashes.claim = cpClaim.signatures;
      }
      log('claim', 'restoredFromCheckpoint', { claimedLamports, signatures: txHashes.claim.length });
    } else {
      log('claim', 'start', { runId, wallet: wallet.publicKey.toBase58(), mint: fund.tokenMint });

      const balanceBefore = await connection.getBalance(wallet.publicKey);
      log('claim', 'balanceBefore', { lamports: balanceBefore });

      const claimTxs = await getClaimTransactions(sdk, wallet.publicKey.toBase58(), fund.tokenMint);

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

      // Write checkpoint after claiming
      checkpoint = await writeCheckpoint(db, runId, 'claiming', {
        claimedLamports,
        signatures: txHashes.claim,
      }, checkpoint);
    }

    await updatePipelineRun(db, runId, { phase: 'swapping' });

    // ── Phase 2: Swap SOL → USDC ───────────────────────────────────

    let swapOutAmount: string;

    if (checkpoint.completedPhases.includes('swapping')) {
      const cpSwap = checkpoint.phaseData.swapping;
      swapOutAmount = cpSwap?.outAmount ?? '0';
      txHashes.swap = cpSwap?.signature ?? null;
      log('swap', 'restoredFromCheckpoint', { outAmount: swapOutAmount, signature: txHashes.swap });
    } else {
      const swapAmountLamports = claimedLamports - TX_FEE_BUFFER_LAMPORTS;

      log('swap', 'start', { swapAmountLamports });

      const swapResult = await swapSolToUsdc(swapAmountLamports, wallet, connection);
      txHashes.swap = swapResult.signature;
      swapOutAmount = swapResult.outAmount;

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

      checkpoint = await writeCheckpoint(db, runId, 'swapping', {
        outAmount: swapResult.outAmount,
        signature: swapResult.signature,
        inAmount: swapResult.inAmount,
      }, checkpoint);
    }

    // ── Phase 3: Protocol fee deduction ────────────────────────────

    let feeAmount: bigint;
    let bridgeAmount: bigint;

    if (checkpoint.completedPhases.includes('fee')) {
      const cpFee = checkpoint.phaseData.fee;
      feeAmount = BigInt(cpFee?.feeAmount ?? '0');
      bridgeAmount = BigInt(cpFee?.bridgeAmount ?? swapOutAmount);
      txHashes.feeTransfer = cpFee?.feeSignature ?? null;
      log('fee', 'restoredFromCheckpoint', {
        feeAmount: feeAmount.toString(),
        bridgeAmount: bridgeAmount.toString(),
      });
    } else {
      const swapOutUsdc = BigInt(swapOutAmount);
      feeAmount = (swapOutUsdc * BigInt(fund.protocolFeeBps)) / 10000n;
      bridgeAmount = swapOutUsdc - feeAmount;

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

      checkpoint = await writeCheckpoint(db, runId, 'fee', {
        feeAmount: feeAmount.toString(),
        feeSignature: txHashes.feeTransfer,
        bridgeAmount: bridgeAmount.toString(),
      }, checkpoint);
    }

    await updatePipelineRun(db, runId, { phase: 'bridging' });

    // ── Phase 4: Bridge USDC → Base ────────────────────────────────

    let bridgeOrderId: string;

    if (checkpoint.completedPhases.includes('bridging')) {
      const cpBridge = checkpoint.phaseData.bridging;
      bridgeOrderId = cpBridge?.orderId ?? '';
      txHashes.bridgeSend = cpBridge?.bridgeSendSignature ?? null;
      txHashes.bridgeReceive = cpBridge?.fulfillTx ?? null;
      log('bridge', 'restoredFromCheckpoint', {
        orderId: bridgeOrderId,
        bridgeSend: txHashes.bridgeSend,
        bridgeReceive: txHashes.bridgeReceive,
      });
    } else {
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

      bridgeOrderId = bridgeOrder.orderId;

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

      checkpoint = await writeCheckpoint(db, runId, 'bridging', {
        orderId: bridgeOrder.orderId,
        fulfillTx: fulfillment.fulfillTransactionHash ?? null,
        bridgeAmount: bridgeAmount.toString(),
        bridgeSendSignature: bridgeSendSig,
      }, checkpoint);
    }

    // ── Phase 5: Investing — USDC→ETH swap + BSKT contribute ──────

    let amountInvested = '0';

    if (checkpoint.completedPhases.includes('investing')) {
      const cpInvest = checkpoint.phaseData.investing;
      if (cpInvest) {
        txHashes.usdcToEthTxHash = cpInvest.usdcToEthTxHash;
        txHashes.investTxHash = cpInvest.investTxHash;
        amountInvested = cpInvest.amountInvested;
      }
      log('investing', 'restoredFromCheckpoint', {
        usdcToEthTxHash: txHashes.usdcToEthTxHash,
        investTxHash: txHashes.investTxHash,
        amountInvested,
      });
    } else {
      const canInvest = opts.evmPublicClient && opts.evmWalletClient && fund.bsktAddress;

      if (!canInvest) {
        const missing: string[] = [];
        if (!opts.evmPublicClient) missing.push('evmPublicClient');
        if (!opts.evmWalletClient) missing.push('evmWalletClient');
        if (!fund.bsktAddress) missing.push('fund.bsktAddress');
        log('investing', 'skip', { reason: 'missing dependencies', missing });
      } else {
        await updatePipelineRun(db, runId, { phase: 'investing' });

        const evmPublicClient = opts.evmPublicClient!;
        const evmWalletClient = opts.evmWalletClient!;
        const bsktAddr = fund.bsktAddress as `0x${string}`;

        // Read actual USDC balance on Base wallet (more reliable than bridged amount)
        log('investing', 'readingUsdcBalance', { wallet: baseWallet.address });

        const usdcBalance: bigint = await evmPublicClient.readContract({
          address: KNOWN_ADDRESSES.USDC,
          abi: [
            {
              inputs: [{ name: 'account', type: 'address' }],
              name: 'balanceOf',
              outputs: [{ name: '', type: 'uint256' }],
              stateMutability: 'view',
              type: 'function',
            },
          ] as const,
          functionName: 'balanceOf',
          args: [baseWallet.address as `0x${string}`],
        });

        log('investing', 'usdcBalance', { balance: String(usdcBalance) });

        if (usdcBalance <= 0n) {
          log('investing', 'skip', { reason: 'zero USDC balance on Base' });
        } else {
          // 5a. Swap USDC → ETH via 1inch
          log('investing', 'swapStart', { usdcAmount: String(usdcBalance) });

          const swapEvmResult = await swapUsdcToEth({
            publicClient: evmPublicClient,
            walletClient: evmWalletClient,
            usdcAmount: usdcBalance,
          });

          txHashes.usdcToEthTxHash = swapEvmResult.txHash;

          log('investing', 'swapDone', {
            txHash: swapEvmResult.txHash,
            ethReceived: String(swapEvmResult.ethReceived),
          });

          await recordTransaction(db, {
            fundId,
            pipelineRunId: runId,
            chain: 'base',
            txHash: swapEvmResult.txHash,
            operation: 'swap',
            amount: String(swapEvmResult.ethReceived),
            token: KNOWN_ADDRESSES.USDC,
          });

          // 5b. Contribute ETH to BSKT
          const ethToContribute = swapEvmResult.ethReceived;
          if (ethToContribute <= 0n) {
            log('investing', 'skipContribute', { reason: 'zero ETH from swap' });
          } else {
            const ethStr = formatEther(ethToContribute);
            log('investing', 'contributeStart', {
              bskt: bsktAddr,
              ethAmount: ethStr,
            });

            const contributeResult = await contributeToBSKT({
              publicClient: evmPublicClient,
              walletClient: evmWalletClient,
              bsktAddress: bsktAddr,
              ethAmount: ethStr,
            });

            txHashes.investTxHash = contributeResult.txHash;
            amountInvested = String(ethToContribute);

            log('investing', 'contributeDone', {
              txHash: contributeResult.txHash,
              gasUsed: String(contributeResult.gasUsed),
              lpIncrease: String(contributeResult.lpBalanceAfter - contributeResult.lpBalanceBefore),
            });

            await recordTransaction(db, {
              fundId,
              pipelineRunId: runId,
              chain: 'base',
              txHash: contributeResult.txHash!,
              operation: 'bskt_contribute',
              amount: amountInvested,
              token: 'ETH',
            });
          }
        }

        // Only write investing checkpoint if we actually invested
        if (txHashes.investTxHash) {
          checkpoint = await writeCheckpoint(db, runId, 'investing', {
            usdcToEthTxHash: txHashes.usdcToEthTxHash,
            investTxHash: txHashes.investTxHash,
            amountInvested,
          }, checkpoint);
        }
      }
    }

    // ── Complete ────────────────────────────────────────────────────

    await updatePipelineRun(db, runId, {
      status: 'completed',
      completedAt: new Date(),
    });

    const result: OutboundPipelineResult = {
      pipelineRunId: runId,
      txHashes,
      amountClaimed: String(claimedLamports),
      amountSwapped: swapOutAmount,
      feeDeducted: feeAmount.toString(),
      amountBridged: bridgeAmount.toString(),
      bridgeOrderId: bridgeOrderId,
      amountInvested: amountInvested,
      durationMs: Date.now() - startTime,
    };

    log('pipeline', 'complete', {
      runId,
      durationMs: result.durationMs,
      claimed: result.amountClaimed,
      swapped: result.amountSwapped,
      fee: result.feeDeducted,
      bridged: result.amountBridged,
      invested: result.amountInvested,
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

// ── Resume helper ───────────────────────────────────────────────────────

/**
 * Resume a failed pipeline run from its last checkpoint.
 *
 * Reads the pipeline run from DB, extracts checkpoint from metadata,
 * and calls `runOutboundPipeline()` with the checkpoint data so
 * completed phases are skipped.
 *
 * If the run has no checkpoint or malformed checkpoint data, falls back
 * to a full pipeline run (safe default).
 */
export async function resumeOutboundPipeline(
  opts: OutboundPipelineOptions & { pipelineRunId: string },
): Promise<OutboundPipelineResult> {
  const { pipelineRunId, db } = opts;

  log('resume', 'start', { pipelineRunId });

  const pipelineRun = await getPipelineRunById(db, pipelineRunId);
  if (!pipelineRun) {
    throw new Error(`resumeOutboundPipeline: pipeline run ${pipelineRunId} not found`);
  }

  const checkpoint = parseCheckpoint(pipelineRun.metadata);

  log('resume', 'checkpointLoaded', {
    pipelineRunId,
    completedPhases: checkpoint.completedPhases,
    hasPhaseData: Object.keys(checkpoint.phaseData).length > 0,
  });

  // If all 5 phases are complete, return immediately — nothing to resume
  const ALL_PHASES = ['claiming', 'swapping', 'fee', 'bridging', 'investing'];
  const allDone = ALL_PHASES.every((p) => checkpoint.completedPhases.includes(p));
  if (allDone) {
    log('resume', 'allPhasesComplete', { pipelineRunId });
    // Reconstruct a result from checkpoint data
    const cp = checkpoint.phaseData;
    return {
      pipelineRunId,
      txHashes: {
        claim: cp.claiming?.signatures ?? [],
        swap: cp.swapping?.signature ?? null,
        feeTransfer: cp.fee?.feeSignature ?? null,
        bridgeSend: cp.bridging?.bridgeSendSignature ?? null,
        bridgeReceive: cp.bridging?.fulfillTx ?? null,
        usdcToEthTxHash: cp.investing?.usdcToEthTxHash ?? null,
        investTxHash: cp.investing?.investTxHash ?? null,
      },
      amountClaimed: String(cp.claiming?.claimedLamports ?? 0),
      amountSwapped: cp.swapping?.outAmount ?? '0',
      feeDeducted: cp.fee?.feeAmount ?? '0',
      amountBridged: cp.bridging?.bridgeAmount ?? '0',
      bridgeOrderId: cp.bridging?.orderId ?? '',
      amountInvested: cp.investing?.amountInvested ?? '0',
      durationMs: 0,
    };
  }

  return runOutboundPipeline({
    ...opts,
    pipelineRunId,
    resumeCheckpoint: checkpoint,
  });
}

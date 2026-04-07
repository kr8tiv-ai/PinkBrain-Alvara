/**
 * Unit tests for pipeline checkpoint recovery.
 * Verifies that checkpoints are written after each phase and that
 * resumeOutboundPipeline skips completed phases correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type VersionedTransaction,
} from '@solana/web3.js';
import type { PipelineCheckpoint } from '../src/pipeline/types.js';

// ── Mock subsystem modules (hoisted before imports) ─────────────────────

vi.mock('../src/bags/fee-claim.js', () => ({
  getClaimTransactions: vi.fn(),
}));

vi.mock('../src/jupiter/swap.js', () => ({
  swapSolToUsdc: vi.fn(),
}));

vi.mock('../src/debridge/api.js', () => ({
  createBridgeOrder: vi.fn(),
  waitForFulfillment: vi.fn(),
}));

vi.mock('../src/debridge/solana-tx.js', () => ({
  prepareSolanaTransaction: vi.fn(),
  sendAndConfirmBridgeTransaction: vi.fn(),
}));

vi.mock('../src/db/fund-repository.js', () => ({
  getFundById: vi.fn(),
  getFundWallets: vi.fn(),
  createPipelineRun: vi.fn(),
  updatePipelineRun: vi.fn(),
  recordTransaction: vi.fn(),
  getPipelineRunById: vi.fn(),
}));

vi.mock('../src/evm/swap.js', () => ({
  swapUsdcToEth: vi.fn(),
}));

vi.mock('../src/alvara/contribute.js', () => ({
  contributeToBSKT: vi.fn(),
}));

// ── Imports (receive mocked versions) ───────────────────────────────────

import {
  runOutboundPipeline,
  resumeOutboundPipeline,
  parseCheckpoint,
} from '../src/pipeline/outbound.js';
import type { OutboundPipelineOptions } from '../src/pipeline/types.js';
import { getClaimTransactions } from '../src/bags/fee-claim.js';
import { swapSolToUsdc } from '../src/jupiter/swap.js';
import {
  createBridgeOrder,
  waitForFulfillment,
} from '../src/debridge/api.js';
import {
  prepareSolanaTransaction,
  sendAndConfirmBridgeTransaction,
} from '../src/debridge/solana-tx.js';
import {
  getFundById,
  getFundWallets,
  createPipelineRun,
  updatePipelineRun,
  recordTransaction,
  getPipelineRunById,
} from '../src/db/fund-repository.js';
import { swapUsdcToEth } from '../src/evm/swap.js';
import { contributeToBSKT } from '../src/alvara/contribute.js';

// ── Typed mock aliases ──────────────────────────────────────────────────

const mGetFundById = vi.mocked(getFundById);
const mGetFundWallets = vi.mocked(getFundWallets);
const mCreatePipelineRun = vi.mocked(createPipelineRun);
const mUpdatePipelineRun = vi.mocked(updatePipelineRun);
const mRecordTx = vi.mocked(recordTransaction);
const mGetClaimTxs = vi.mocked(getClaimTransactions);
const mSwapSolToUsdc = vi.mocked(swapSolToUsdc);
const mCreateBridgeOrder = vi.mocked(createBridgeOrder);
const mWaitForFulfillment = vi.mocked(waitForFulfillment);
const mPrepareSolanaTx = vi.mocked(prepareSolanaTransaction);
const mSendAndConfirmBridge = vi.mocked(sendAndConfirmBridgeTransaction);
const mSwapUsdcToEth = vi.mocked(swapUsdcToEth);
const mContributeToBSKT = vi.mocked(contributeToBSKT);
const mGetPipelineRunById = vi.mocked(getPipelineRunById);

// ── Fixtures ────────────────────────────────────────────────────────────

const FUND_ID = 'fund-cp-001';
const RUN_ID = 'run-cp-001';
const BASE_WALLET_ADDR = '0x1234567890abcdef1234567890abcdef12345678';

const testWallet = Keypair.generate();
const treasuryKeypair = Keypair.generate();
const MOCK_BLOCKHASH = Keypair.generate().publicKey.toBase58();

// ── Factory helpers ─────────────────────────────────────────────────────

function makeFund(overrides: Record<string, unknown> = {}) {
  return {
    id: FUND_ID,
    name: 'Checkpoint Test Fund',
    tokenMint: 'So11111111111111111111111111111111111111112',
    creatorWallet: testWallet.publicKey.toBase58(),
    status: 'active' as const,
    targetChain: 'base' as const,
    protocolFeeBps: 500,
    bsktAddress: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeWallets() {
  return [
    {
      id: 'w-sol',
      fundId: FUND_ID,
      chain: 'solana' as const,
      address: testWallet.publicKey.toBase58(),
      walletType: 'treasury',
      createdAt: new Date(),
    },
    {
      id: 'w-base',
      fundId: FUND_ID,
      chain: 'base' as const,
      address: BASE_WALLET_ADDR,
      walletType: 'treasury',
      createdAt: new Date(),
    },
  ];
}

function makePipelineRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    fundId: FUND_ID,
    direction: 'outbound',
    phase: 'claiming' as const,
    status: 'running',
    startedAt: new Date(),
    completedAt: null,
    error: null,
    metadata: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeTxRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: `tx-${Math.random().toString(36).slice(2, 8)}`,
    fundId: FUND_ID,
    pipelineRunId: RUN_ID,
    chain: 'solana' as const,
    txHash: 'mock-hash',
    operation: 'fee_claim' as const,
    amount: '0',
    token: 'SOL',
    status: 'pending',
    createdAt: new Date(),
    confirmedAt: null,
    ...overrides,
  };
}

function createDummyTx(): Transaction {
  const tx = new Transaction();
  tx.add(
    new TransactionInstruction({
      keys: [],
      programId: new PublicKey('11111111111111111111111111111111'),
      data: Buffer.alloc(0),
    }),
  );
  return tx;
}

function createMockConnection(overrides: Record<string, unknown> = {}) {
  return {
    getBalance: vi.fn()
      .mockResolvedValueOnce(100_000)
      .mockResolvedValueOnce(1_100_000),
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: MOCK_BLOCKHASH,
      lastValidBlockHeight: 200_000,
    }),
    sendRawTransaction: vi.fn()
      .mockResolvedValueOnce('claim-sig-1')
      .mockResolvedValueOnce('fee-sig-1'),
    confirmTransaction: vi.fn().mockResolvedValue({
      value: { err: null },
    }),
    ...overrides,
  } as any;
}

function setupBridgePhase() {
  mCreateBridgeOrder.mockResolvedValue({
    tx: { data: '0xabc123', to: '0x000', value: '0' },
    estimation: {
      srcChainTokenIn: { address: 'x', amount: '950000', decimals: 6, name: 'USDC', symbol: 'USDC' },
      srcChainTokenOut: { address: 'y', amount: '940000', decimals: 6, name: 'USDC', symbol: 'USDC' },
      dstChainTokenOut: { address: 'z', amount: '940000', decimals: 6, name: 'USDC', symbol: 'USDC', recommendedAmount: '935000' },
      recommendedSlippage: 0.5,
      costsDetails: [],
    },
    orderId: 'bridge-order-1',
    fixFee: '0',
    userPoints: 0,
    integratorPoints: 0,
  });

  mPrepareSolanaTx.mockResolvedValue({} as VersionedTransaction);
  mSendAndConfirmBridge.mockResolvedValue('bridge-sig-1');

  mWaitForFulfillment.mockResolvedValue({
    orderId: 'bridge-order-1',
    status: 'Fulfilled',
    fulfillTransactionHash: '0xfulfill123',
    sourceChainId: 7565164,
    destinationChainId: 8453,
  });
}

function setupHappyPath(feeBps = 500) {
  const connection = createMockConnection();

  mGetFundById.mockResolvedValue(makeFund({ protocolFeeBps: feeBps }) as any);
  mGetFundWallets.mockResolvedValue(makeWallets() as any);
  mCreatePipelineRun.mockResolvedValue(makePipelineRun() as any);
  mUpdatePipelineRun.mockResolvedValue(makePipelineRun() as any);
  mRecordTx.mockResolvedValue(makeTxRecord() as any);

  mGetClaimTxs.mockResolvedValue([createDummyTx()] as any);

  mSwapSolToUsdc.mockResolvedValue({
    signature: 'swap-sig-1',
    inAmount: '990000',
    outAmount: '1000000',
  });

  setupBridgePhase();

  return connection;
}

function makeOpts(connection: any, overrides: Partial<OutboundPipelineOptions> = {}): OutboundPipelineOptions {
  return {
    fundId: FUND_ID,
    sdk: {} as any,
    wallet: testWallet,
    connection,
    db: {} as any,
    platformTreasuryWallet: treasuryKeypair.publicKey.toBase58(),
    ...overrides,
  };
}

// ── Checkpoint data factories ─────────────────────────────────────────

function makeClaimingCheckpoint(): PipelineCheckpoint {
  return {
    completedPhases: ['claiming'],
    phaseData: {
      claiming: {
        claimedLamports: 1_000_000,
        signatures: ['claim-sig-restored'],
      },
    },
  };
}

function makeBridgingCheckpoint(): PipelineCheckpoint {
  return {
    completedPhases: ['claiming', 'swapping', 'fee', 'bridging'],
    phaseData: {
      claiming: {
        claimedLamports: 1_000_000,
        signatures: ['claim-sig-restored'],
      },
      swapping: {
        outAmount: '1000000',
        signature: 'swap-sig-restored',
        inAmount: '990000',
      },
      fee: {
        feeAmount: '50000',
        feeSignature: 'fee-sig-restored',
        bridgeAmount: '950000',
      },
      bridging: {
        orderId: 'bridge-order-restored',
        fulfillTx: '0xfulfill-restored',
        bridgeAmount: '950000',
        bridgeSendSignature: 'bridge-sig-restored',
      },
    },
  };
}

function makeAllPhasesCheckpoint(): PipelineCheckpoint {
  return {
    completedPhases: ['claiming', 'swapping', 'fee', 'bridging', 'investing'],
    phaseData: {
      claiming: {
        claimedLamports: 1_000_000,
        signatures: ['claim-sig-all'],
      },
      swapping: {
        outAmount: '1000000',
        signature: 'swap-sig-all',
        inAmount: '990000',
      },
      fee: {
        feeAmount: '50000',
        feeSignature: 'fee-sig-all',
        bridgeAmount: '950000',
      },
      bridging: {
        orderId: 'bridge-order-all',
        fulfillTx: '0xfulfill-all',
        bridgeAmount: '950000',
        bridgeSendSignature: 'bridge-sig-all',
      },
      investing: {
        usdcToEthTxHash: '0xswap-eth-all',
        investTxHash: '0xcontribute-all',
        amountInvested: '400000000000000',
      },
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('checkpoint recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  // ── Checkpoint writes during full pipeline ────────────────────────

  describe('checkpoint writes during full pipeline', () => {
    it('writes checkpoints after each phase via updatePipelineRun metadata', async () => {
      const conn = setupHappyPath();
      await runOutboundPipeline(makeOpts(conn));

      // Collect all updatePipelineRun calls that write metadata with checkpoint
      const checkpointCalls = mUpdatePipelineRun.mock.calls.filter(
        (c) =>
          c[2]?.metadata &&
          typeof c[2].metadata === 'object' &&
          (c[2].metadata as any).checkpoint,
      );

      // Should have 4 checkpoint writes: claiming, swapping, fee, bridging
      // (investing is skipped when no EVM clients)
      expect(checkpointCalls.length).toBe(4);

      // Verify progressive checkpoint accumulation
      const phases = checkpointCalls.map(
        (c) => (c[2].metadata as any).checkpoint.completedPhases,
      );

      expect(phases[0]).toEqual(['claiming']);
      expect(phases[1]).toEqual(['claiming', 'swapping']);
      expect(phases[2]).toEqual(['claiming', 'swapping', 'fee']);
      expect(phases[3]).toEqual(['claiming', 'swapping', 'fee', 'bridging']);
    });

    it('stores phase-specific data in each checkpoint', async () => {
      const conn = setupHappyPath();
      await runOutboundPipeline(makeOpts(conn));

      const checkpointCalls = mUpdatePipelineRun.mock.calls.filter(
        (c) =>
          c[2]?.metadata &&
          typeof c[2].metadata === 'object' &&
          (c[2].metadata as any).checkpoint,
      );

      // Claiming checkpoint has lamports and signatures
      const claimCp = (checkpointCalls[0][2].metadata as any).checkpoint.phaseData.claiming;
      expect(claimCp.claimedLamports).toBe(1_000_000);
      expect(claimCp.signatures).toEqual(['claim-sig-1']);

      // Swapping checkpoint has outAmount and signature
      const swapCp = (checkpointCalls[1][2].metadata as any).checkpoint.phaseData.swapping;
      expect(swapCp.outAmount).toBe('1000000');
      expect(swapCp.signature).toBe('swap-sig-1');

      // Fee checkpoint has fee amount and bridge amount
      const feeCp = (checkpointCalls[2][2].metadata as any).checkpoint.phaseData.fee;
      expect(feeCp.feeAmount).toBe('50000');
      expect(feeCp.bridgeAmount).toBe('950000');

      // Bridge checkpoint has order ID and signatures
      const bridgeCp = (checkpointCalls[3][2].metadata as any).checkpoint.phaseData.bridging;
      expect(bridgeCp.orderId).toBe('bridge-order-1');
      expect(bridgeCp.bridgeSendSignature).toBe('bridge-sig-1');
      expect(bridgeCp.fulfillTx).toBe('0xfulfill123');
    });
  });

  // ── Resume after claiming ─────────────────────────────────────────

  describe('resume after claiming — skips claim, runs swap→fee→bridge→invest', () => {
    it('skips claiming phase and runs remaining phases', async () => {
      const conn = createMockConnection();

      mGetFundById.mockResolvedValue(makeFund() as any);
      mGetFundWallets.mockResolvedValue(makeWallets() as any);
      mUpdatePipelineRun.mockResolvedValue(makePipelineRun() as any);
      mRecordTx.mockResolvedValue(makeTxRecord() as any);

      mSwapSolToUsdc.mockResolvedValue({
        signature: 'swap-sig-resume',
        inAmount: '990000',
        outAmount: '1000000',
      });

      setupBridgePhase();

      const result = await runOutboundPipeline(
        makeOpts(conn, {
          pipelineRunId: RUN_ID,
          resumeCheckpoint: makeClaimingCheckpoint(),
        }),
      );

      // Claiming should NOT have been called
      expect(mGetClaimTxs).not.toHaveBeenCalled();
      expect(conn.getBalance).not.toHaveBeenCalled();

      // But swap, bridge should have been called
      expect(mSwapSolToUsdc).toHaveBeenCalled();
      expect(mCreateBridgeOrder).toHaveBeenCalled();

      // Restored claim data should be in result
      expect(result.txHashes.claim).toEqual(['claim-sig-restored']);
      expect(result.amountClaimed).toBe('1000000');
      expect(result.txHashes.swap).toBe('swap-sig-resume');
    });

    it('does not create a new pipeline run when resuming', async () => {
      const conn = createMockConnection();

      mGetFundById.mockResolvedValue(makeFund() as any);
      mGetFundWallets.mockResolvedValue(makeWallets() as any);
      mUpdatePipelineRun.mockResolvedValue(makePipelineRun() as any);
      mRecordTx.mockResolvedValue(makeTxRecord() as any);
      mSwapSolToUsdc.mockResolvedValue({
        signature: 'swap-sig-1',
        inAmount: '990000',
        outAmount: '1000000',
      });
      setupBridgePhase();

      await runOutboundPipeline(
        makeOpts(conn, {
          pipelineRunId: RUN_ID,
          resumeCheckpoint: makeClaimingCheckpoint(),
        }),
      );

      // createPipelineRun should NOT have been called
      expect(mCreatePipelineRun).not.toHaveBeenCalled();

      // But updatePipelineRun should have been called to set status=running
      const resumeCall = mUpdatePipelineRun.mock.calls.find(
        (c) => c[2]?.status === 'running',
      );
      expect(resumeCall).toBeDefined();
    });
  });

  // ── Resume after bridging ─────────────────────────────────────────

  describe('resume after bridging — skips claim→swap→fee→bridge, runs invest only', () => {
    it('skips first 4 phases and restores all checkpoint data', async () => {
      const conn = createMockConnection();

      mGetFundById.mockResolvedValue(makeFund() as any);
      mGetFundWallets.mockResolvedValue(makeWallets() as any);
      mUpdatePipelineRun.mockResolvedValue(makePipelineRun() as any);
      mRecordTx.mockResolvedValue(makeTxRecord() as any);

      const result = await runOutboundPipeline(
        makeOpts(conn, {
          pipelineRunId: RUN_ID,
          resumeCheckpoint: makeBridgingCheckpoint(),
        }),
      );

      // None of the first 4 phases should have been called
      expect(mGetClaimTxs).not.toHaveBeenCalled();
      expect(mSwapSolToUsdc).not.toHaveBeenCalled();
      expect(mCreateBridgeOrder).not.toHaveBeenCalled();
      expect(conn.sendRawTransaction).not.toHaveBeenCalled();

      // All restored data correct
      expect(result.txHashes.claim).toEqual(['claim-sig-restored']);
      expect(result.txHashes.swap).toBe('swap-sig-restored');
      expect(result.txHashes.feeTransfer).toBe('fee-sig-restored');
      expect(result.txHashes.bridgeSend).toBe('bridge-sig-restored');
      expect(result.txHashes.bridgeReceive).toBe('0xfulfill-restored');
      expect(result.amountClaimed).toBe('1000000');
      expect(result.amountSwapped).toBe('1000000');
      expect(result.feeDeducted).toBe('50000');
      expect(result.amountBridged).toBe('950000');
      expect(result.bridgeOrderId).toBe('bridge-order-restored');
    });
  });

  // ── Resume with all phases complete ───────────────────────────────

  describe('resume with all phases complete — returns immediately', () => {
    it('returns reconstructed result without calling any external service', async () => {
      const conn = createMockConnection();

      mGetPipelineRunById.mockResolvedValue(
        makePipelineRun({
          metadata: { checkpoint: makeAllPhasesCheckpoint() },
        }) as any,
      );

      const result = await resumeOutboundPipeline({
        ...makeOpts(conn),
        pipelineRunId: RUN_ID,
      });

      // No external calls
      expect(mGetClaimTxs).not.toHaveBeenCalled();
      expect(mSwapSolToUsdc).not.toHaveBeenCalled();
      expect(mCreateBridgeOrder).not.toHaveBeenCalled();
      expect(mGetFundById).not.toHaveBeenCalled();

      // Result reconstructed from checkpoint
      expect(result.pipelineRunId).toBe(RUN_ID);
      expect(result.txHashes.claim).toEqual(['claim-sig-all']);
      expect(result.txHashes.swap).toBe('swap-sig-all');
      expect(result.txHashes.investTxHash).toBe('0xcontribute-all');
      expect(result.amountInvested).toBe('400000000000000');
      expect(result.durationMs).toBe(0);
    });
  });

  // ── Checkpoint data correctly restores tx hashes and amounts ──────

  describe('checkpoint data correctly restores txHashes and amounts', () => {
    it('restores all claim signatures from checkpoint', async () => {
      const conn = createMockConnection();

      mGetFundById.mockResolvedValue(makeFund() as any);
      mGetFundWallets.mockResolvedValue(makeWallets() as any);
      mUpdatePipelineRun.mockResolvedValue(makePipelineRun() as any);
      mRecordTx.mockResolvedValue(makeTxRecord() as any);
      mSwapSolToUsdc.mockResolvedValue({
        signature: 'swap-sig-1',
        inAmount: '990000',
        outAmount: '1000000',
      });
      setupBridgePhase();

      const multiSigCheckpoint: PipelineCheckpoint = {
        completedPhases: ['claiming'],
        phaseData: {
          claiming: {
            claimedLamports: 2_000_000,
            signatures: ['claim-sig-a', 'claim-sig-b', 'claim-sig-c'],
          },
        },
      };

      const result = await runOutboundPipeline(
        makeOpts(conn, {
          pipelineRunId: RUN_ID,
          resumeCheckpoint: multiSigCheckpoint,
        }),
      );

      expect(result.txHashes.claim).toEqual(['claim-sig-a', 'claim-sig-b', 'claim-sig-c']);
      expect(result.amountClaimed).toBe('2000000');
    });
  });

  // ── Resume with empty/missing checkpoint runs full pipeline ────────

  describe('resume with empty/missing checkpoint runs full pipeline', () => {
    it('runs all phases when resumeCheckpoint is empty', async () => {
      const conn = setupHappyPath();

      const result = await runOutboundPipeline(
        makeOpts(conn, {
          resumeCheckpoint: { completedPhases: [], phaseData: {} },
        }),
      );

      // All phases should have been called
      expect(mGetClaimTxs).toHaveBeenCalled();
      expect(mSwapSolToUsdc).toHaveBeenCalled();
      expect(mCreateBridgeOrder).toHaveBeenCalled();

      expect(result.txHashes.claim).toEqual(['claim-sig-1']);
      expect(result.txHashes.swap).toBe('swap-sig-1');
    });

    it('resumeOutboundPipeline runs full pipeline when DB metadata has no checkpoint', async () => {
      const conn = setupHappyPath();

      // Pipeline run exists but with null metadata
      mGetPipelineRunById.mockResolvedValue(
        makePipelineRun({ metadata: null }) as any,
      );

      const result = await resumeOutboundPipeline({
        ...makeOpts(conn),
        pipelineRunId: RUN_ID,
      });

      expect(mGetClaimTxs).toHaveBeenCalled();
      expect(result.txHashes.claim).toEqual(['claim-sig-1']);
    });
  });

  // ── Negative tests ────────────────────────────────────────────────

  describe('negative tests', () => {
    it('resume with corrupt/malformed checkpoint data runs full pipeline', async () => {
      const conn = setupHappyPath();

      const corruptCheckpoint = {
        completedPhases: 'not-an-array',
        phaseData: 42,
      } as any;

      mGetPipelineRunById.mockResolvedValue(
        makePipelineRun({ metadata: { checkpoint: corruptCheckpoint } }) as any,
      );

      const result = await resumeOutboundPipeline({
        ...makeOpts(conn),
        pipelineRunId: RUN_ID,
      });

      // Should have run full pipeline because parseCheckpoint returned empty
      expect(mGetClaimTxs).toHaveBeenCalled();
      expect(mSwapSolToUsdc).toHaveBeenCalled();
      expect(result.txHashes.claim).toEqual(['claim-sig-1']);
    });

    it('resume with unknown phases in completedPhases ignores them', async () => {
      const conn = createMockConnection();

      mGetFundById.mockResolvedValue(makeFund() as any);
      mGetFundWallets.mockResolvedValue(makeWallets() as any);
      mUpdatePipelineRun.mockResolvedValue(makePipelineRun() as any);
      mRecordTx.mockResolvedValue(makeTxRecord() as any);
      mSwapSolToUsdc.mockResolvedValue({
        signature: 'swap-sig-1',
        inAmount: '990000',
        outAmount: '1000000',
      });
      setupBridgePhase();

      // Checkpoint with unknown phases — they should be stripped
      const weirdCheckpoint: PipelineCheckpoint = {
        completedPhases: ['claiming', 'nonexistent_phase', 'alien_step'],
        phaseData: {
          claiming: {
            claimedLamports: 1_000_000,
            signatures: ['claim-sig-1'],
          },
        },
      };

      // parseCheckpoint filters to known phases only, so when used via
      // resumeOutboundPipeline (which calls parseCheckpoint), only 'claiming' remains
      mGetPipelineRunById.mockResolvedValue(
        makePipelineRun({ metadata: { checkpoint: weirdCheckpoint } }) as any,
      );

      const result = await resumeOutboundPipeline({
        ...makeOpts(conn),
        pipelineRunId: RUN_ID,
      });

      // Claiming should be skipped (it's known + in checkpoint)
      expect(mGetClaimTxs).not.toHaveBeenCalled();

      // But swap should still run (unknown phases were stripped)
      expect(mSwapSolToUsdc).toHaveBeenCalled();
      expect(result.txHashes.swap).toBe('swap-sig-1');
    });

    it('checkpoint write failure does not abort the pipeline phase', async () => {
      const conn = createMockConnection();

      mGetFundById.mockResolvedValue(makeFund() as any);
      mGetFundWallets.mockResolvedValue(makeWallets() as any);
      mCreatePipelineRun.mockResolvedValue(makePipelineRun() as any);
      mRecordTx.mockResolvedValue(makeTxRecord() as any);
      mGetClaimTxs.mockResolvedValue([createDummyTx()] as any);
      mSwapSolToUsdc.mockResolvedValue({
        signature: 'swap-sig-1',
        inAmount: '990000',
        outAmount: '1000000',
      });
      setupBridgePhase();

      // Make updatePipelineRun fail when writing checkpoint metadata
      // but succeed for phase updates. Use a counter to fail selectively.
      let callCount = 0;
      mUpdatePipelineRun.mockImplementation(async (_db: any, _id: any, updates: any) => {
        callCount++;
        if (updates?.metadata?.checkpoint) {
          throw new Error('DB write failed — checkpoint');
        }
        return makePipelineRun() as any;
      });

      // Pipeline should still complete despite checkpoint write failures
      const result = await runOutboundPipeline(makeOpts(conn));

      expect(result.txHashes.claim).toEqual(['claim-sig-1']);
      expect(result.txHashes.swap).toBe('swap-sig-1');
      expect(result.txHashes.bridgeSend).toBe('bridge-sig-1');
      expect(result.pipelineRunId).toBe(RUN_ID);
    });
  });

  // ── parseCheckpoint unit tests ────────────────────────────────────

  describe('parseCheckpoint', () => {
    it('returns empty checkpoint for null', () => {
      const cp = parseCheckpoint(null);
      expect(cp).toEqual({ completedPhases: [], phaseData: {} });
    });

    it('returns empty checkpoint for non-object', () => {
      expect(parseCheckpoint('string')).toEqual({ completedPhases: [], phaseData: {} });
      expect(parseCheckpoint(42)).toEqual({ completedPhases: [], phaseData: {} });
    });

    it('returns empty checkpoint for object without checkpoint key', () => {
      expect(parseCheckpoint({ earlyExit: true })).toEqual({
        completedPhases: [],
        phaseData: {},
      });
    });

    it('filters unknown phases from completedPhases', () => {
      const cp = parseCheckpoint({
        checkpoint: {
          completedPhases: ['claiming', 'bogus', 'swapping', 'unknown'],
          phaseData: {},
        },
      });
      expect(cp.completedPhases).toEqual(['claiming', 'swapping']);
    });

    it('returns empty when completedPhases is not an array', () => {
      expect(
        parseCheckpoint({
          checkpoint: { completedPhases: 'claiming', phaseData: {} },
        }),
      ).toEqual({ completedPhases: [], phaseData: {} });
    });

    it('returns empty when phaseData is not an object', () => {
      expect(
        parseCheckpoint({
          checkpoint: { completedPhases: ['claiming'], phaseData: null },
        }),
      ).toEqual({ completedPhases: [], phaseData: {} });
    });

    it('preserves valid phase data', () => {
      const cp = parseCheckpoint({
        checkpoint: {
          completedPhases: ['claiming'],
          phaseData: {
            claiming: { claimedLamports: 500, signatures: ['sig1'] },
          },
        },
      });
      expect(cp.phaseData.claiming).toEqual({
        claimedLamports: 500,
        signatures: ['sig1'],
      });
    });
  });
});

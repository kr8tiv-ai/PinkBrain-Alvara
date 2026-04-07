/**
 * Unit tests for the outbound pipeline orchestrator.
 * All subsystem functions mocked — no network, no DB, no crypto dependencies
 * except @solana/web3.js primitives (Keypair, Transaction, PublicKey).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type VersionedTransaction,
} from '@solana/web3.js';

// ── Mock subsystem modules (hoisted before imports) ─────────────────────

vi.mock('../src/bags/fee-claim.js', () => ({
  getClaimTransactions: vi.fn(),
  signAndSendClaimTransactions: vi.fn(),
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
}));

// ── Imports (receive mocked versions) ───────────────────────────────────

import { runOutboundPipeline } from '../src/pipeline/outbound.js';
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
} from '../src/db/fund-repository.js';

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

// ── Fixtures ────────────────────────────────────────────────────────────

const FUND_ID = 'fund-001';
const RUN_ID = 'run-001';
const BASE_WALLET_ADDR = '0x1234567890abcdef1234567890abcdef12345678';

const testWallet = Keypair.generate();
const treasuryKeypair = Keypair.generate();
const MOCK_BLOCKHASH = Keypair.generate().publicKey.toBase58();

// ── Factory helpers ─────────────────────────────────────────────────────

function makeFund(overrides: Record<string, unknown> = {}) {
  return {
    id: FUND_ID,
    name: 'Test Fund',
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

function makePipelineRun() {
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

  return connection;
}

function makeOpts(connection: any): OutboundPipelineOptions {
  return {
    fundId: FUND_ID,
    sdk: {} as any,
    wallet: testWallet,
    connection,
    db: {} as any,
    platformTreasuryWallet: treasuryKeypair.publicKey.toBase58(),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('runOutboundPipeline', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  // ── Fund validation ─────────────────────────────────────────────────

  describe('fund validation', () => {
    it('throws when fund not found', async () => {
      mGetFundById.mockResolvedValue(null as any);
      const conn = createMockConnection();

      await expect(runOutboundPipeline(makeOpts(conn))).rejects.toThrow(
        /fund fund-001 not found/,
      );
    });

    it('throws when fund status is not active', async () => {
      mGetFundById.mockResolvedValue(makeFund({ status: 'paused' }) as any);
      const conn = createMockConnection();

      await expect(runOutboundPipeline(makeOpts(conn))).rejects.toThrow(
        /status is 'paused', expected 'active'/,
      );
    });

    it('throws when fund has no Base wallet', async () => {
      mGetFundById.mockResolvedValue(makeFund() as any);
      mGetFundWallets.mockResolvedValue([
        {
          id: 'w1',
          fundId: FUND_ID,
          chain: 'solana' as const,
          address: testWallet.publicKey.toBase58(),
          walletType: 'treasury',
          createdAt: new Date(),
        },
      ] as any);
      const conn = createMockConnection();

      await expect(runOutboundPipeline(makeOpts(conn))).rejects.toThrow(
        /no Base wallet/,
      );
    });
  });

  // ── Happy path ──────────────────────────────────────────────────────

  describe('happy path', () => {
    it('completes full pipeline and returns all tx hashes', async () => {
      const conn = setupHappyPath();
      const result = await runOutboundPipeline(makeOpts(conn));

      expect(result.pipelineRunId).toBe(RUN_ID);
      expect(result.txHashes.claim).toEqual(['claim-sig-1']);
      expect(result.txHashes.swap).toBe('swap-sig-1');
      expect(result.txHashes.feeTransfer).toBe('fee-sig-1');
      expect(result.txHashes.bridgeSend).toBe('bridge-sig-1');
      expect(result.txHashes.bridgeReceive).toBe('0xfulfill123');
      expect(result.bridgeOrderId).toBe('bridge-order-1');
      expect(typeof result.durationMs).toBe('number');
    });

    it('reports correct claimed amount from balance delta', async () => {
      const conn = setupHappyPath();
      const result = await runOutboundPipeline(makeOpts(conn));

      // balance delta: 1_100_000 - 100_000 = 1_000_000 lamports
      expect(result.amountClaimed).toBe('1000000');
    });

    it('reports correct swap output amount', async () => {
      const conn = setupHappyPath();
      const result = await runOutboundPipeline(makeOpts(conn));

      expect(result.amountSwapped).toBe('1000000');
    });
  });

  // ── Protocol fee calculation ────────────────────────────────────────

  describe('protocol fee calculation', () => {
    it('calculates 5% fee (500 bps) correctly', async () => {
      const conn = setupHappyPath(500);
      const result = await runOutboundPipeline(makeOpts(conn));

      // outAmount=1_000_000, fee = 1_000_000 * 500 / 10_000 = 50_000
      expect(result.feeDeducted).toBe('50000');
      expect(result.amountBridged).toBe('950000');
    });

    it('calculates 10% fee (1000 bps) correctly', async () => {
      const conn = setupHappyPath(1000);
      const result = await runOutboundPipeline(makeOpts(conn));

      // fee = 1_000_000 * 1000 / 10_000 = 100_000
      expect(result.feeDeducted).toBe('100000');
      expect(result.amountBridged).toBe('900000');
    });

    it('handles 0% fee (0 bps) — no fee transfer, full amount bridged', async () => {
      const conn = setupHappyPath(0);
      const result = await runOutboundPipeline(makeOpts(conn));

      expect(result.feeDeducted).toBe('0');
      expect(result.amountBridged).toBe('1000000');
      expect(result.txHashes.feeTransfer).toBeNull();
    });

    it('does not send fee transfer transaction when bps is 0', async () => {
      const conn = setupHappyPath(0);
      await runOutboundPipeline(makeOpts(conn));

      // With 0 fee, sendRawTransaction should only be called once (claim),
      // not a second time for the fee transfer.
      // The fee transfer is skipped, so the only sendRawTransaction is the claim tx.
      expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    });
  });

  // ── Pipeline phase transitions (updatePipelineRun) ──────────────────

  describe('pipeline run phase progression', () => {
    it('updates phases: claiming → swapping → bridging → completed', async () => {
      const conn = setupHappyPath();
      await runOutboundPipeline(makeOpts(conn));

      // updatePipelineRun(db, runId, updates) — filter to phase/status updates,
      // ignoring checkpoint metadata writes
      const calls = mUpdatePipelineRun.mock.calls;
      const phaseCalls = calls.filter((c) => c[2]?.phase || c[2]?.status);

      // Phase transitions: swapping → bridging → completed
      expect(phaseCalls[0][2]).toMatchObject({ phase: 'swapping' });
      expect(phaseCalls[1][2]).toMatchObject({ phase: 'bridging' });

      const completedCall = phaseCalls.find((c) => c[2]?.status === 'completed');
      expect(completedCall).toBeDefined();
      expect(completedCall![2]).toHaveProperty('completedAt');
    });

    it('creates initial pipeline run with claiming phase', async () => {
      const conn = setupHappyPath();
      await runOutboundPipeline(makeOpts(conn));

      expect(mCreatePipelineRun).toHaveBeenCalledWith(expect.anything(), {
        fundId: FUND_ID,
        direction: 'outbound',
        phase: 'claiming',
        status: 'running',
        startedAt: expect.any(Date),
      });
    });
  });

  // ── Transaction recording ───────────────────────────────────────────

  describe('transaction recording', () => {
    it('records claim, swap, fee, bridge_send, and bridge_receive transactions', async () => {
      const conn = setupHappyPath();
      await runOutboundPipeline(makeOpts(conn));

      // With fee > 0 and fulfilled bridge: 5 recordTransaction calls
      //   1. claim  2. swap  3. fee_claim  4. bridge_send  5. bridge_receive
      expect(mRecordTx).toHaveBeenCalledTimes(5);

      const operations = mRecordTx.mock.calls.map((c) => c[1].operation);
      expect(operations).toEqual([
        'fee_claim',
        'swap',
        'fee_claim',
        'bridge_send',
        'bridge_receive',
      ]);
    });

    it('records 4 transactions when fee is 0 (no fee transfer)', async () => {
      const conn = setupHappyPath(0);
      await runOutboundPipeline(makeOpts(conn));

      // claim + swap + bridge_send + bridge_receive = 4
      expect(mRecordTx).toHaveBeenCalledTimes(4);

      const operations = mRecordTx.mock.calls.map((c) => c[1].operation);
      expect(operations).toEqual([
        'fee_claim',
        'swap',
        'bridge_send',
        'bridge_receive',
      ]);
    });

    it('records bridge_receive on base chain', async () => {
      const conn = setupHappyPath();
      await runOutboundPipeline(makeOpts(conn));

      const lastCall = mRecordTx.mock.calls[mRecordTx.mock.calls.length - 1];
      expect(lastCall[1].chain).toBe('base');
      expect(lastCall[1].operation).toBe('bridge_receive');
    });
  });

  // ── Claim phase error ───────────────────────────────────────────────

  describe('claim phase error', () => {
    it('marks pipeline as failed when getClaimTransactions throws', async () => {
      mGetFundById.mockResolvedValue(makeFund() as any);
      mGetFundWallets.mockResolvedValue(makeWallets() as any);
      mCreatePipelineRun.mockResolvedValue(makePipelineRun() as any);
      mUpdatePipelineRun.mockResolvedValue(makePipelineRun() as any);

      const conn = createMockConnection();
      mGetClaimTxs.mockRejectedValue(new Error('Bags SDK timeout'));

      await expect(runOutboundPipeline(makeOpts(conn))).rejects.toThrow(
        /Bags SDK timeout/,
      );

      // Pipeline should be marked failed
      const failCall = mUpdatePipelineRun.mock.calls.find(
        (c) => c[2]?.status === 'failed',
      );
      expect(failCall).toBeDefined();
      expect(failCall![2].error).toContain('Bags SDK timeout');
    });
  });

  // ── Swap phase error ────────────────────────────────────────────────

  describe('swap phase error', () => {
    it('marks pipeline as failed when swapSolToUsdc throws', async () => {
      const conn = createMockConnection();

      mGetFundById.mockResolvedValue(makeFund() as any);
      mGetFundWallets.mockResolvedValue(makeWallets() as any);
      mCreatePipelineRun.mockResolvedValue(makePipelineRun() as any);
      mUpdatePipelineRun.mockResolvedValue(makePipelineRun() as any);
      mRecordTx.mockResolvedValue(makeTxRecord() as any);
      mGetClaimTxs.mockResolvedValue([createDummyTx()] as any);
      mSwapSolToUsdc.mockRejectedValue(new Error('Jupiter 503'));

      await expect(runOutboundPipeline(makeOpts(conn))).rejects.toThrow(
        /Jupiter 503/,
      );

      // Check pipeline was updated to swapping phase before failure
      const swapPhaseCall = mUpdatePipelineRun.mock.calls.find(
        (c) => c[2]?.phase === 'swapping',
      );
      expect(swapPhaseCall).toBeDefined();

      // Check pipeline was marked failed
      const failCall = mUpdatePipelineRun.mock.calls.find(
        (c) => c[2]?.status === 'failed',
      );
      expect(failCall).toBeDefined();
      expect(failCall![2].error).toContain('Jupiter 503');
    });
  });

  // ── Bridge phase error ──────────────────────────────────────────────

  describe('bridge phase error', () => {
    it('marks pipeline as failed when sendAndConfirmBridgeTransaction throws', async () => {
      const conn = createMockConnection();

      mGetFundById.mockResolvedValue(makeFund() as any);
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
      mCreateBridgeOrder.mockResolvedValue({
        tx: { data: '0xabc', to: '0x0', value: '0' },
        estimation: {} as any,
        orderId: 'order-1',
        fixFee: '0',
        userPoints: 0,
        integratorPoints: 0,
      });
      mPrepareSolanaTx.mockResolvedValue({} as VersionedTransaction);
      mSendAndConfirmBridge.mockRejectedValue(
        new Error('Transaction simulation failed'),
      );

      await expect(runOutboundPipeline(makeOpts(conn))).rejects.toThrow(
        /Transaction simulation failed/,
      );

      // Bridge phase should have been set before the error
      const bridgePhaseCall = mUpdatePipelineRun.mock.calls.find(
        (c) => c[2]?.phase === 'bridging',
      );
      expect(bridgePhaseCall).toBeDefined();

      // Pipeline marked failed
      const failCall = mUpdatePipelineRun.mock.calls.find(
        (c) => c[2]?.status === 'failed',
      );
      expect(failCall).toBeDefined();
    });
  });

  // ── Early exit (claim too small) ────────────────────────────────────

  describe('early exit on insufficient claim', () => {
    it('completes early when claimed lamports <= TX_FEE_BUFFER (10_000)', async () => {
      const conn = {
        getBalance: vi.fn()
          .mockResolvedValueOnce(100_000)     // before
          .mockResolvedValueOnce(105_000),    // after → delta = 5_000 (< 10_000 buffer)
        getLatestBlockhash: vi.fn().mockResolvedValue({
          blockhash: MOCK_BLOCKHASH,
          lastValidBlockHeight: 200_000,
        }),
        sendRawTransaction: vi.fn().mockResolvedValue('claim-sig-1'),
        confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      } as any;

      mGetFundById.mockResolvedValue(makeFund() as any);
      mGetFundWallets.mockResolvedValue(makeWallets() as any);
      mCreatePipelineRun.mockResolvedValue(makePipelineRun() as any);
      mUpdatePipelineRun.mockResolvedValue(makePipelineRun() as any);
      mRecordTx.mockResolvedValue(makeTxRecord() as any);
      mGetClaimTxs.mockResolvedValue([createDummyTx()] as any);

      const result = await runOutboundPipeline(makeOpts(conn));

      // Should exit early — no swap, no bridge
      expect(result.amountSwapped).toBe('0');
      expect(result.amountBridged).toBe('0');
      expect(result.feeDeducted).toBe('0');
      expect(result.bridgeOrderId).toBe('');

      // Swap should never be called
      expect(mSwapSolToUsdc).not.toHaveBeenCalled();

      // Pipeline marked completed (early exit)
      const completedCall = mUpdatePipelineRun.mock.calls.find(
        (c) => c[2]?.status === 'completed',
      );
      expect(completedCall).toBeDefined();
      expect(completedCall![2].metadata).toMatchObject({
        earlyExit: 'insufficient_claim',
      });
    });

    it('skips all phases when no claim transactions returned', async () => {
      const conn = {
        getBalance: vi.fn()
          .mockResolvedValueOnce(100_000)
          .mockResolvedValueOnce(100_000), // no change
        getLatestBlockhash: vi.fn().mockResolvedValue({
          blockhash: MOCK_BLOCKHASH,
          lastValidBlockHeight: 200_000,
        }),
        sendRawTransaction: vi.fn(),
        confirmTransaction: vi.fn(),
      } as any;

      mGetFundById.mockResolvedValue(makeFund() as any);
      mGetFundWallets.mockResolvedValue(makeWallets() as any);
      mCreatePipelineRun.mockResolvedValue(makePipelineRun() as any);
      mUpdatePipelineRun.mockResolvedValue(makePipelineRun() as any);
      mGetClaimTxs.mockResolvedValue([] as any);

      const result = await runOutboundPipeline(makeOpts(conn));

      expect(result.amountClaimed).toBe('0');
      expect(result.txHashes.claim).toEqual([]);
      expect(mSwapSolToUsdc).not.toHaveBeenCalled();
    });
  });
});

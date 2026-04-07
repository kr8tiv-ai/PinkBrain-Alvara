/**
 * Unit tests for the accumulation scheduler worker.
 *
 * Mocks: fund-repository, @solana/web3.js Connection.getBalance,
 * pipeline/outbound. Tests cover dispatch, skip conditions, error isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey, Connection } from '@solana/web3.js';

// ── Mock modules (hoisted before imports) ───────────────────────────────

vi.mock('../src/db/fund-repository.js', () => ({
  listFunds: vi.fn(),
  getFundWallets: vi.fn(),
  getActivePipelineRuns: vi.fn(),
  updateFundLastPipelineRun: vi.fn(),
}));

vi.mock('../src/pipeline/outbound.js', () => ({
  runOutboundPipeline: vi.fn(),
  resumeOutboundPipeline: vi.fn(),
}));

// ── Imports (receive mocked versions) ───────────────────────────────────

import { createAccumulationWorker } from '../src/scheduler/accumulation-worker.js';
import {
  listFunds,
  getFundWallets,
  getActivePipelineRuns,
  updateFundLastPipelineRun,
} from '../src/db/fund-repository.js';
import {
  runOutboundPipeline,
  resumeOutboundPipeline,
} from '../src/pipeline/outbound.js';

// ── Typed mock aliases ──────────────────────────────────────────────────

const mListFunds = vi.mocked(listFunds);
const mGetFundWallets = vi.mocked(getFundWallets);
const mGetActivePipelineRuns = vi.mocked(getActivePipelineRuns);
const mUpdateFundLastPipelineRun = vi.mocked(updateFundLastPipelineRun);
const mRunOutboundPipeline = vi.mocked(runOutboundPipeline);

// ── Fixtures ────────────────────────────────────────────────────────────

const FUND_ID = 'fund-sched-001';
const SOL_WALLET = Keypair.generate().publicKey.toBase58();

function makeFund(overrides: Record<string, unknown> = {}) {
  return {
    id: FUND_ID,
    name: 'Scheduler Test Fund',
    tokenMint: 'So11111111111111111111111111111111111111112',
    creatorWallet: SOL_WALLET,
    status: 'active' as const,
    targetChain: 'base' as const,
    protocolFeeBps: 500,
    bsktAddress: null,
    accumulationThresholdLamports: '5000000000', // 5 SOL
    lastPipelineRunAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeWallets(fundId: string = FUND_ID) {
  return [
    {
      id: 'w-sol-1',
      fundId,
      chain: 'solana' as const,
      address: SOL_WALLET,
      walletType: 'treasury',
      createdAt: new Date(),
    },
    {
      id: 'w-base-1',
      fundId,
      chain: 'base' as const,
      address: '0xdeadbeef',
      walletType: 'treasury',
      createdAt: new Date(),
    },
  ];
}

const fakeDb = {} as any;
const fakeRedis = {
  // BullMQ Worker just needs a Redis-like object with specific methods
  // We don't actually start the real worker — we extract and call the processor
} as any;
const fakeSolConnection = {
  getBalance: vi.fn(),
} as unknown as Connection;
const fakeWallet = Keypair.generate();

const basePipelineDeps = {
  sdk: {} as any,
  wallet: fakeWallet,
  platformTreasuryWallet: 'TreasuryXXX',
};

// ── Helper: extract the job processor from createAccumulationWorker ──────
//
// BullMQ Worker constructor takes (queueName, processor, opts).
// We mock the Worker class to capture the processor function, then call it
// directly in tests. This avoids needing a real Redis connection.

let capturedProcessor: ((job: any) => Promise<void>) | null = null;

vi.mock('bullmq', () => {
  return {
    Worker: vi.fn().mockImplementation((_name: string, processor: any, _opts: any) => {
      capturedProcessor = processor;
      return {
        close: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
      };
    }),
    Queue: vi.fn().mockImplementation(() => ({
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('accumulation-worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProcessor = null;

    // Create worker to capture processor
    createAccumulationWorker({
      db: fakeDb,
      redisConnection: fakeRedis,
      solanaConnection: fakeSolConnection,
      pipelineDeps: basePipelineDeps,
    });
  });

  async function runJob() {
    expect(capturedProcessor).not.toBeNull();
    await capturedProcessor!({ id: 'test-job-1' } as any);
  }

  it('dispatches pipeline when fund balance > threshold and no active runs', async () => {
    const fund = makeFund();
    mListFunds.mockResolvedValue([fund] as any);
    mGetFundWallets.mockResolvedValue(makeWallets() as any);
    mGetActivePipelineRuns.mockResolvedValue([]);
    (fakeSolConnection.getBalance as ReturnType<typeof vi.fn>).mockResolvedValue(
      10_000_000_000, // 10 SOL — above 5 SOL threshold
    );
    mRunOutboundPipeline.mockResolvedValue({
      pipelineRunId: 'run-1',
      txHashes: { claim: [], swap: null, feeTransfer: null, bridgeSend: null, bridgeReceive: null, usdcToEthTxHash: null, investTxHash: null },
      amountClaimed: '0',
      amountSwapped: '0',
      feeDeducted: '0',
      amountBridged: '0',
      bridgeOrderId: '',
      amountInvested: '0',
      durationMs: 100,
    });
    mUpdateFundLastPipelineRun.mockResolvedValue(fund as any);

    await runJob();

    expect(mRunOutboundPipeline).toHaveBeenCalledOnce();
    expect(mRunOutboundPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        fundId: FUND_ID,
        db: fakeDb,
        connection: fakeSolConnection,
      }),
    );
    expect(mUpdateFundLastPipelineRun).toHaveBeenCalledWith(fakeDb, FUND_ID);
  });

  it('skips fund when balance < threshold', async () => {
    const fund = makeFund();
    mListFunds.mockResolvedValue([fund] as any);
    mGetFundWallets.mockResolvedValue(makeWallets() as any);
    (fakeSolConnection.getBalance as ReturnType<typeof vi.fn>).mockResolvedValue(
      1_000_000_000, // 1 SOL — below 5 SOL threshold
    );

    await runJob();

    expect(mRunOutboundPipeline).not.toHaveBeenCalled();
    expect(mUpdateFundLastPipelineRun).not.toHaveBeenCalled();
  });

  it('skips fund when active pipeline run exists (concurrency guard)', async () => {
    const fund = makeFund();
    mListFunds.mockResolvedValue([fund] as any);
    mGetFundWallets.mockResolvedValue(makeWallets() as any);
    mGetActivePipelineRuns.mockResolvedValue([
      { id: 'active-run', fundId: FUND_ID, status: 'running' },
    ] as any);
    (fakeSolConnection.getBalance as ReturnType<typeof vi.fn>).mockResolvedValue(
      10_000_000_000,
    );

    await runJob();

    expect(mRunOutboundPipeline).not.toHaveBeenCalled();
  });

  it('skips fund with no Solana treasury wallet', async () => {
    const fund = makeFund();
    mListFunds.mockResolvedValue([fund] as any);
    // Return only a Base wallet, no Solana treasury
    mGetFundWallets.mockResolvedValue([
      {
        id: 'w-base-only',
        fundId: FUND_ID,
        chain: 'base' as const,
        address: '0xdeadbeef',
        walletType: 'treasury',
        createdAt: new Date(),
      },
    ] as any);

    await runJob();

    expect(mRunOutboundPipeline).not.toHaveBeenCalled();
    // Should not throw — just skip
  });

  it('per-fund error does not crash the worker (other funds still processed)', async () => {
    const fund1 = makeFund({ id: 'fund-1' });
    const fund2 = makeFund({ id: 'fund-2' });

    mListFunds.mockResolvedValue([fund1, fund2] as any);

    // fund-1: getBalance throws
    mGetFundWallets.mockImplementation(async (_db: any, fundId: string) => {
      return makeWallets(fundId) as any;
    });

    (fakeSolConnection.getBalance as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValueOnce(10_000_000_000);

    mGetActivePipelineRuns.mockResolvedValue([]);
    mRunOutboundPipeline.mockResolvedValue({
      pipelineRunId: 'run-2',
      txHashes: { claim: [], swap: null, feeTransfer: null, bridgeSend: null, bridgeReceive: null, usdcToEthTxHash: null, investTxHash: null },
      amountClaimed: '0',
      amountSwapped: '0',
      feeDeducted: '0',
      amountBridged: '0',
      bridgeOrderId: '',
      amountInvested: '0',
      durationMs: 100,
    });
    mUpdateFundLastPipelineRun.mockResolvedValue(fund2 as any);

    // Should not throw
    await runJob();

    // fund-2 should still get dispatched despite fund-1 error
    expect(mRunOutboundPipeline).toHaveBeenCalledOnce();
    expect(mRunOutboundPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ fundId: 'fund-2' }),
    );
  });

  it('calls updateFundLastPipelineRun after successful dispatch', async () => {
    const fund = makeFund();
    mListFunds.mockResolvedValue([fund] as any);
    mGetFundWallets.mockResolvedValue(makeWallets() as any);
    mGetActivePipelineRuns.mockResolvedValue([]);
    (fakeSolConnection.getBalance as ReturnType<typeof vi.fn>).mockResolvedValue(
      10_000_000_000,
    );
    mRunOutboundPipeline.mockResolvedValue({
      pipelineRunId: 'run-1',
      txHashes: { claim: [], swap: null, feeTransfer: null, bridgeSend: null, bridgeReceive: null, usdcToEthTxHash: null, investTxHash: null },
      amountClaimed: '0',
      amountSwapped: '0',
      feeDeducted: '0',
      amountBridged: '0',
      bridgeOrderId: '',
      amountInvested: '0',
      durationMs: 100,
    });
    mUpdateFundLastPipelineRun.mockResolvedValue(fund as any);

    await runJob();

    expect(mUpdateFundLastPipelineRun).toHaveBeenCalledWith(fakeDb, FUND_ID);
    // Verify it was called AFTER pipeline dispatch
    const pipelineCallOrder = mRunOutboundPipeline.mock.invocationCallOrder[0];
    const updateCallOrder = mUpdateFundLastPipelineRun.mock.invocationCallOrder[0];
    expect(updateCallOrder).toBeGreaterThan(pipelineCallOrder);
  });

  it('skips fund with no accumulationThresholdLamports set', async () => {
    const fund = makeFund({ accumulationThresholdLamports: null });
    mListFunds.mockResolvedValue([fund] as any);

    await runJob();

    expect(mGetFundWallets).not.toHaveBeenCalled();
    expect(mRunOutboundPipeline).not.toHaveBeenCalled();
  });

  // ── Negative tests ──────────────────────────────────────────────────

  it('empty fund list → job completes with no errors', async () => {
    mListFunds.mockResolvedValue([]);

    await runJob();

    expect(mGetFundWallets).not.toHaveBeenCalled();
    expect(mRunOutboundPipeline).not.toHaveBeenCalled();
  });

  it('all funds below threshold → job completes, no dispatch', async () => {
    const fund1 = makeFund({ id: 'fund-low-1' });
    const fund2 = makeFund({ id: 'fund-low-2' });

    mListFunds.mockResolvedValue([fund1, fund2] as any);
    mGetFundWallets.mockImplementation(async (_db: any, fundId: string) => {
      return makeWallets(fundId) as any;
    });
    (fakeSolConnection.getBalance as ReturnType<typeof vi.fn>).mockResolvedValue(
      1_000_000, // Way below threshold
    );

    await runJob();

    expect(mRunOutboundPipeline).not.toHaveBeenCalled();
  });
});

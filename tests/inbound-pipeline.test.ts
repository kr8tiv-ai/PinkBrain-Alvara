/**
 * Unit tests for the inbound pipeline orchestrator.
 *
 * All subsystem functions mocked — no network, no DB, no crypto.
 * Tests: happy path, checkpoint resume, phase failure, fund validation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock subsystem modules (hoisted before imports) ─────────────────────

vi.mock('../src/alvara/redeem.js', () => ({
  redeemBSKTForETH: vi.fn(),
}));

vi.mock('../src/evm/swap.js', () => ({
  swapEthToUsdc: vi.fn(),
}));

vi.mock('../src/debridge/api.js', () => ({
  createBridgeOrder: vi.fn(),
  waitForFulfillment: vi.fn(),
}));

vi.mock('../src/debridge/evm-tx.js', () => ({
  submitEvmBridgeTransaction: vi.fn(),
}));

vi.mock('../src/db/fund-repository.js', () => ({
  getFundById: vi.fn(),
  getFundWallets: vi.fn(),
  createPipelineRun: vi.fn(),
  updatePipelineRun: vi.fn(),
  recordTransaction: vi.fn(),
  getPipelineRunById: vi.fn(),
}));

// ── Imports (receive mocked versions) ───────────────────────────────────

import {
  runInboundPipeline,
  resumeInboundPipeline,
  parseInboundCheckpoint,
} from '../src/pipeline/inbound.js';
import type { InboundPipelineOptions, InboundPipelineCheckpoint } from '../src/pipeline/types.js';
import { redeemBSKTForETH } from '../src/alvara/redeem.js';
import { swapEthToUsdc } from '../src/evm/swap.js';
import { createBridgeOrder, waitForFulfillment } from '../src/debridge/api.js';
import { submitEvmBridgeTransaction } from '../src/debridge/evm-tx.js';
import {
  getFundById,
  getFundWallets,
  createPipelineRun,
  updatePipelineRun,
  recordTransaction,
  getPipelineRunById,
} from '../src/db/fund-repository.js';

// ── Typed mock aliases ──────────────────────────────────────────────────

const mGetFundById = vi.mocked(getFundById);
const mGetFundWallets = vi.mocked(getFundWallets);
const mCreatePipelineRun = vi.mocked(createPipelineRun);
const mUpdatePipelineRun = vi.mocked(updatePipelineRun);
const mRecordTx = vi.mocked(recordTransaction);
const mGetPipelineRunById = vi.mocked(getPipelineRunById);
const mRedeemBSKT = vi.mocked(redeemBSKTForETH);
const mSwapEthToUsdc = vi.mocked(swapEthToUsdc);
const mCreateBridgeOrder = vi.mocked(createBridgeOrder);
const mWaitForFulfillment = vi.mocked(waitForFulfillment);
const mSubmitEvmBridge = vi.mocked(submitEvmBridgeTransaction);

// Suppress structured JSON logs during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

// ── Fixtures ────────────────────────────────────────────────────────────

const FUND_ID = 'fund-001';
const RUN_ID = 'run-001';
const BSKT_ADDR = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as const;
const SOLANA_RECIPIENT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

function makeFund(overrides: Record<string, unknown> = {}) {
  return {
    id: FUND_ID,
    name: 'Test Fund',
    tokenMint: 'So11111111111111111111111111111111111111112',
    creatorWallet: '0x1234',
    status: 'active' as const,
    targetChain: 'base' as const,
    protocolFeeBps: 500,
    bsktAddress: BSKT_ADDR,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeOpts(overrides: Partial<InboundPipelineOptions> = {}): InboundPipelineOptions {
  return {
    fundId: FUND_ID,
    db: {} as any,
    evmPublicClient: {} as any,
    evmWalletClient: {} as any,
    solanaRecipientAddress: SOLANA_RECIPIENT,
    bsktAddress: BSKT_ADDR,
    ...overrides,
  };
}

function setupHappyPath() {
  mGetFundById.mockResolvedValue(makeFund() as any);
  mGetFundWallets.mockResolvedValue([] as any);
  mCreatePipelineRun.mockResolvedValue({ id: RUN_ID } as any);
  mUpdatePipelineRun.mockResolvedValue({} as any);
  mRecordTx.mockResolvedValue({} as any);

  mRedeemBSKT.mockResolvedValue({
    txHash: '0xredeem_hash',
    receipt: {} as any,
    lpBalanceBefore: 1000n,
    lpBalanceAfter: 0n,
    ethReceived: 500000000000000000n, // 0.5 ETH
    gasUsed: 200000n,
    gasEstimate: 180000n,
    routeData: {} as any,
  });

  mSwapEthToUsdc.mockResolvedValue({
    txHash: '0xswap_hash' as any,
    usdcReceived: 1200000000n, // 1200 USDC (6 dec)
  });

  mCreateBridgeOrder.mockResolvedValue({
    orderId: 'order-abc',
    tx: { to: '0xDlnSource', data: '0xbridgedata', value: '0' },
    estimation: {} as any,
    fixFee: '0',
    userPoints: 0,
    integratorPoints: 0,
  });

  mSubmitEvmBridge.mockResolvedValue({ txHash: '0xbridge_send_hash' as any });

  mWaitForFulfillment.mockResolvedValue({
    orderId: 'order-abc',
    status: 'Fulfilled',
    fulfillTransactionHash: 'solana_bridge_receive_sig',
    sourceChainId: 8453,
    destinationChainId: 7565164,
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('runInboundPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes all 3 phases, collects tx hashes, and records transactions', async () => {
    setupHappyPath();

    const result = await runInboundPipeline(makeOpts());

    expect(result.pipelineRunId).toBe(RUN_ID);
    expect(result.txHashes.redeemTx).toBe('0xredeem_hash');
    expect(result.txHashes.swapTx).toBe('0xswap_hash');
    expect(result.txHashes.bridgeSendTx).toBe('0xbridge_send_hash');
    expect(result.txHashes.bridgeReceiveTx).toBe('solana_bridge_receive_sig');
    expect(result.amountRedeemed).toBe(String(500000000000000000n));
    expect(result.amountSwapped).toBe(String(1200000000n));
    expect(result.amountBridged).toBe(String(1200000000n));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Pipeline run created with correct direction
    expect(mCreatePipelineRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fundId: FUND_ID, direction: 'inbound', phase: 'divesting' }),
    );

    // Transactions recorded for each phase
    expect(mRecordTx).toHaveBeenCalledTimes(4); // redeem, swap, bridge_send, bridge_receive

    // Phase updates — updatePipelineRun(db, id, updates) → 3rd arg
    const phaseUpdates = mUpdatePipelineRun.mock.calls
      .map(([, , updates]: any[]) => updates)
      .filter((u: any) => u?.phase);
    expect(phaseUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'swapping' }),
        expect.objectContaining({ phase: 'bridging' }),
      ]),
    );

    // Completed
    expect(mUpdatePipelineRun).toHaveBeenCalledWith(
      expect.anything(),
      RUN_ID,
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('resumes from checkpoint, skipping completed phases', async () => {
    mGetFundById.mockResolvedValue(makeFund() as any);
    mGetFundWallets.mockResolvedValue([] as any);
    mUpdatePipelineRun.mockResolvedValue({} as any);
    mRecordTx.mockResolvedValue({} as any);

    // Bridging phase mocks
    mCreateBridgeOrder.mockResolvedValue({
      orderId: 'order-resumed',
      tx: { to: '0xDlnSource', data: '0xresumedata', value: '0' },
      estimation: {} as any,
      fixFee: '0',
      userPoints: 0,
      integratorPoints: 0,
    });
    mSubmitEvmBridge.mockResolvedValue({ txHash: '0xbridge_resumed' as any });
    mWaitForFulfillment.mockResolvedValue({
      orderId: 'order-resumed',
      status: 'Fulfilled',
      fulfillTransactionHash: 'solana_resumed_sig',
      sourceChainId: 8453,
      destinationChainId: 7565164,
    });

    const checkpoint: InboundPipelineCheckpoint = {
      completedPhases: ['redeeming', 'swapping'],
      phaseData: {
        redeeming: { txHash: '0xold_redeem', ethReceived: '500000000000000000' },
        swapping: { txHash: '0xold_swap', usdcReceived: '1200000000' },
      },
    };

    const result = await runInboundPipeline(
      makeOpts({ pipelineRunId: RUN_ID, resumeCheckpoint: checkpoint }),
    );

    // Redeem and swap NOT called — they were checkpointed
    expect(mRedeemBSKT).not.toHaveBeenCalled();
    expect(mSwapEthToUsdc).not.toHaveBeenCalled();

    // Bridge phase executed
    expect(mCreateBridgeOrder).toHaveBeenCalledTimes(1);
    expect(mSubmitEvmBridge).toHaveBeenCalledTimes(1);

    // Tx hashes restored + new
    expect(result.txHashes.redeemTx).toBe('0xold_redeem');
    expect(result.txHashes.swapTx).toBe('0xold_swap');
    expect(result.txHashes.bridgeSendTx).toBe('0xbridge_resumed');
    expect(result.txHashes.bridgeReceiveTx).toBe('solana_resumed_sig');
  });

  it('marks pipeline as failed and re-throws on redeem error', async () => {
    mGetFundById.mockResolvedValue(makeFund() as any);
    mGetFundWallets.mockResolvedValue([] as any);
    mCreatePipelineRun.mockResolvedValue({ id: RUN_ID } as any);
    mUpdatePipelineRun.mockResolvedValue({} as any);

    mRedeemBSKT.mockRejectedValue(new Error('Redeem failed: insufficient LP'));

    await expect(runInboundPipeline(makeOpts())).rejects.toThrow(
      `Inbound pipeline failed [run=${RUN_ID}]: Redeem failed: insufficient LP`,
    );

    // Pipeline marked failed
    expect(mUpdatePipelineRun).toHaveBeenCalledWith(
      expect.anything(),
      RUN_ID,
      expect.objectContaining({ status: 'failed', error: 'Redeem failed: insufficient LP' }),
    );
  });

  it('marks pipeline as failed on swap error', async () => {
    mGetFundById.mockResolvedValue(makeFund() as any);
    mGetFundWallets.mockResolvedValue([] as any);
    mCreatePipelineRun.mockResolvedValue({ id: RUN_ID } as any);
    mUpdatePipelineRun.mockResolvedValue({} as any);
    mRecordTx.mockResolvedValue({} as any);

    mRedeemBSKT.mockResolvedValue({
      txHash: '0xredeem',
      receipt: {} as any,
      lpBalanceBefore: 1000n,
      lpBalanceAfter: 0n,
      ethReceived: 500000000000000000n,
      gasUsed: 200000n,
      gasEstimate: 180000n,
      routeData: {} as any,
    });

    mSwapEthToUsdc.mockRejectedValue(new Error('1inch API timeout'));

    await expect(runInboundPipeline(makeOpts())).rejects.toThrow(
      'Inbound pipeline failed',
    );
  });

  it('throws when fund is not found', async () => {
    mGetFundById.mockResolvedValue(null as any);

    await expect(runInboundPipeline(makeOpts())).rejects.toThrow(
      `Inbound pipeline: fund ${FUND_ID} not found`,
    );
  });

  it('throws when fund has wrong status', async () => {
    mGetFundById.mockResolvedValue(makeFund({ status: 'closed' }) as any);

    await expect(runInboundPipeline(makeOpts())).rejects.toThrow(
      `expected 'active' or 'divesting'`,
    );
  });

  it('allows divesting status for inbound pipeline', async () => {
    setupHappyPath();
    mGetFundById.mockResolvedValue(makeFund({ status: 'divesting' }) as any);

    const result = await runInboundPipeline(makeOpts());
    expect(result.pipelineRunId).toBe(RUN_ID);
  });

  it('exits early when zero ETH redeemed', async () => {
    mGetFundById.mockResolvedValue(makeFund() as any);
    mGetFundWallets.mockResolvedValue([] as any);
    mCreatePipelineRun.mockResolvedValue({ id: RUN_ID } as any);
    mUpdatePipelineRun.mockResolvedValue({} as any);
    mRecordTx.mockResolvedValue({} as any);

    mRedeemBSKT.mockResolvedValue({
      txHash: '0xredeem_zero',
      receipt: {} as any,
      lpBalanceBefore: 0n,
      lpBalanceAfter: 0n,
      ethReceived: 0n,
      gasUsed: 100000n,
      gasEstimate: 90000n,
      routeData: {} as any,
    });

    const result = await runInboundPipeline(makeOpts());

    expect(result.amountRedeemed).toBe('0');
    expect(result.amountSwapped).toBe('0');
    expect(result.amountBridged).toBe('0');

    // Swap and bridge NOT called
    expect(mSwapEthToUsdc).not.toHaveBeenCalled();
    expect(mCreateBridgeOrder).not.toHaveBeenCalled();
  });

  it('throws when bridge order returns no tx.data', async () => {
    mGetFundById.mockResolvedValue(makeFund() as any);
    mGetFundWallets.mockResolvedValue([] as any);
    mCreatePipelineRun.mockResolvedValue({ id: RUN_ID } as any);
    mUpdatePipelineRun.mockResolvedValue({} as any);
    mRecordTx.mockResolvedValue({} as any);

    mRedeemBSKT.mockResolvedValue({
      txHash: '0xredeem',
      receipt: {} as any,
      lpBalanceBefore: 1000n,
      lpBalanceAfter: 0n,
      ethReceived: 500000000000000000n,
      gasUsed: 200000n,
      gasEstimate: 180000n,
      routeData: {} as any,
    });

    mSwapEthToUsdc.mockResolvedValue({
      txHash: '0xswap' as any,
      usdcReceived: 1200000000n,
    });

    mCreateBridgeOrder.mockResolvedValue({
      orderId: 'order-bad',
      tx: { to: '0xDln', data: '', value: '0' },
      estimation: {} as any,
      fixFee: '0',
      userPoints: 0,
      integratorPoints: 0,
    });

    await expect(runInboundPipeline(makeOpts())).rejects.toThrow(
      'no tx.data',
    );
  });
});

describe('resumeInboundPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when pipeline run not found', async () => {
    mGetPipelineRunById.mockResolvedValue(null);

    await expect(
      resumeInboundPipeline({ ...makeOpts(), pipelineRunId: 'missing-run' }),
    ).rejects.toThrow('pipeline run missing-run not found');
  });

  it('returns reconstructed result when all phases complete', async () => {
    mGetPipelineRunById.mockResolvedValue({
      id: RUN_ID,
      metadata: {
        checkpoint: {
          completedPhases: ['redeeming', 'swapping', 'bridging'],
          phaseData: {
            redeeming: { txHash: '0xredeem', ethReceived: '500' },
            swapping: { txHash: '0xswap', usdcReceived: '1200' },
            bridging: {
              orderId: 'order-123',
              bridgeSendTxHash: '0xbridge',
              bridgeReceiveTxHash: 'sol_fulfill',
              bridgeAmount: '1200',
            },
          },
        },
      },
    } as any);

    const result = await resumeInboundPipeline({ ...makeOpts(), pipelineRunId: RUN_ID });

    expect(result.pipelineRunId).toBe(RUN_ID);
    expect(result.txHashes.redeemTx).toBe('0xredeem');
    expect(result.txHashes.swapTx).toBe('0xswap');
    expect(result.txHashes.bridgeSendTx).toBe('0xbridge');
    expect(result.txHashes.bridgeReceiveTx).toBe('sol_fulfill');
    expect(result.durationMs).toBe(0);

    // No subsystem functions called — all from checkpoint
    expect(mRedeemBSKT).not.toHaveBeenCalled();
    expect(mSwapEthToUsdc).not.toHaveBeenCalled();
    expect(mCreateBridgeOrder).not.toHaveBeenCalled();
  });
});

describe('parseInboundCheckpoint', () => {
  it('returns empty checkpoint for null/undefined metadata', () => {
    expect(parseInboundCheckpoint(null)).toEqual({ completedPhases: [], phaseData: {} });
    expect(parseInboundCheckpoint(undefined)).toEqual({ completedPhases: [], phaseData: {} });
  });

  it('returns empty checkpoint for missing checkpoint key', () => {
    expect(parseInboundCheckpoint({ foo: 'bar' })).toEqual({ completedPhases: [], phaseData: {} });
  });

  it('filters unknown phases', () => {
    const result = parseInboundCheckpoint({
      checkpoint: {
        completedPhases: ['redeeming', 'unknownPhase', 'bridging'],
        phaseData: {},
      },
    });
    expect(result.completedPhases).toEqual(['redeeming', 'bridging']);
  });

  it('parses valid checkpoint data', () => {
    const metadata = {
      checkpoint: {
        completedPhases: ['redeeming', 'swapping'],
        phaseData: {
          redeeming: { txHash: '0x1', ethReceived: '100' },
          swapping: { txHash: '0x2', usdcReceived: '200' },
        },
      },
    };
    const result = parseInboundCheckpoint(metadata);
    expect(result.completedPhases).toEqual(['redeeming', 'swapping']);
    expect(result.phaseData.redeeming?.txHash).toBe('0x1');
    expect(result.phaseData.swapping?.usdcReceived).toBe('200');
  });
});

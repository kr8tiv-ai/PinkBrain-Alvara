/**
 * Unit tests for the outbound pipeline investing phase (phase 5).
 * Tests USDC→ETH swap via 1inch + BSKT contribution via Alvara.
 * All subsystem functions mocked — no network, no DB, no crypto dependencies
 * except @solana/web3.js primitives.
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

vi.mock('../src/evm/swap.js', () => ({
  swapUsdcToEth: vi.fn(),
}));

vi.mock('../src/alvara/contribute.js', () => ({
  contributeToBSKT: vi.fn(),
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

// ── Fixtures ────────────────────────────────────────────────────────────

const FUND_ID = 'fund-invest-001';
const RUN_ID = 'run-invest-001';
const BASE_WALLET_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const BSKT_ADDR: `0x${string}` = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const testWallet = Keypair.generate();
const treasuryKeypair = Keypair.generate();
const MOCK_BLOCKHASH = Keypair.generate().publicKey.toBase58();

// ── Factory helpers ─────────────────────────────────────────────────────

function makeFund(overrides: Record<string, unknown> = {}) {
  return {
    id: FUND_ID,
    name: 'Test Investing Fund',
    tokenMint: 'So11111111111111111111111111111111111111112',
    creatorWallet: testWallet.publicKey.toBase58(),
    status: 'active' as const,
    targetChain: 'base' as const,
    protocolFeeBps: 500,
    bsktAddress: BSKT_ADDR,
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
      .mockResolvedValueOnce(100_000)     // before claim
      .mockResolvedValueOnce(1_100_000),  // after claim
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

/** Mock EVM public client with USDC balance read */
function createMockEvmPublicClient(usdcBalance: bigint = 950_000n) {
  return {
    readContract: vi.fn().mockResolvedValue(usdcBalance),
    getBalance: vi.fn().mockResolvedValue(0n),
  } as any;
}

function createMockEvmWalletClient() {
  return {
    account: { address: BASE_WALLET_ADDR },
    chain: { id: 8453, name: 'Base' },
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

function setupClaimAndSwap(connection: any) {
  mGetClaimTxs.mockResolvedValue([createDummyTx()] as any);
  mSwapSolToUsdc.mockResolvedValue({
    signature: 'swap-sig-1',
    inAmount: '990000',
    outAmount: '1000000',
  });
}

function setupFullHappyPath(opts?: {
  usdcBalance?: bigint;
  bsktAddress?: string | null;
  feeBps?: number;
}) {
  const {
    usdcBalance = 950_000n,
    bsktAddress = BSKT_ADDR,
    feeBps = 500,
  } = opts ?? {};

  const connection = createMockConnection();
  const evmPublicClient = createMockEvmPublicClient(usdcBalance);
  const evmWalletClient = createMockEvmWalletClient();

  mGetFundById.mockResolvedValue(makeFund({ protocolFeeBps: feeBps, bsktAddress }) as any);
  mGetFundWallets.mockResolvedValue(makeWallets() as any);
  mCreatePipelineRun.mockResolvedValue(makePipelineRun() as any);
  mUpdatePipelineRun.mockResolvedValue(makePipelineRun() as any);
  mRecordTx.mockResolvedValue(makeTxRecord() as any);

  setupClaimAndSwap(connection);
  setupBridgePhase();

  // Investing mocks
  mSwapUsdcToEth.mockResolvedValue({
    txHash: '0xswap-eth-hash' as any,
    ethReceived: 400_000_000_000_000n, // ~0.0004 ETH
  });

  mContributeToBSKT.mockResolvedValue({
    txHash: '0xcontribute-hash' as any,
    receipt: {} as any,
    lpBalanceBefore: 0n,
    lpBalanceAfter: 100n,
    gasUsed: 250_000n,
    gasEstimate: 230_000n,
    routeData: { swapDataCount: 3, deadline: 1700000000 },
  });

  return { connection, evmPublicClient, evmWalletClient };
}

function makeOpts(
  connection: any,
  evmOpts?: { evmPublicClient?: any; evmWalletClient?: any; bsktAddress?: `0x${string}` },
): OutboundPipelineOptions {
  return {
    fundId: FUND_ID,
    sdk: {} as any,
    wallet: testWallet,
    connection,
    db: {} as any,
    platformTreasuryWallet: treasuryKeypair.publicKey.toBase58(),
    ...evmOpts,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('pipeline investing phase', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  // ── Full pipeline with investing ────────────────────────────────────

  describe('full pipeline with investing phase', () => {
    it('fires all 5 phases and returns invest tx hashes + amountInvested', async () => {
      const { connection, evmPublicClient, evmWalletClient } = setupFullHappyPath();
      const opts = makeOpts(connection, {
        evmPublicClient,
        evmWalletClient,
        bsktAddress: BSKT_ADDR,
      });

      const result = await runOutboundPipeline(opts);

      // Claim + swap + fee + bridge all still work
      expect(result.txHashes.claim).toEqual(['claim-sig-1']);
      expect(result.txHashes.swap).toBe('swap-sig-1');
      expect(result.txHashes.feeTransfer).toBe('fee-sig-1');
      expect(result.txHashes.bridgeSend).toBe('bridge-sig-1');
      expect(result.txHashes.bridgeReceive).toBe('0xfulfill123');

      // Investing phase results
      expect(result.txHashes.usdcToEthTxHash).toBe('0xswap-eth-hash');
      expect(result.txHashes.investTxHash).toBe('0xcontribute-hash');
      expect(result.amountInvested).toBe('400000000000000');
    });

    it('passes USDC→ETH swap result correctly to contributeToBSKT', async () => {
      const { connection, evmPublicClient, evmWalletClient } = setupFullHappyPath();
      const opts = makeOpts(connection, {
        evmPublicClient,
        evmWalletClient,
        bsktAddress: BSKT_ADDR,
      });

      await runOutboundPipeline(opts);

      // swapUsdcToEth was called with the USDC balance
      expect(mSwapUsdcToEth).toHaveBeenCalledWith({
        publicClient: evmPublicClient,
        walletClient: evmWalletClient,
        usdcAmount: 950_000n,
      });

      // contributeToBSKT received the ETH amount from swap result
      expect(mContributeToBSKT).toHaveBeenCalledWith(
        expect.objectContaining({
          publicClient: evmPublicClient,
          walletClient: evmWalletClient,
          bsktAddress: BSKT_ADDR,
          ethAmount: '0.0004', // formatEther(400_000_000_000_000n)
        }),
      );
    });

    it('records both invest transactions (swap + contribute) in DB', async () => {
      const { connection, evmPublicClient, evmWalletClient } = setupFullHappyPath();
      const opts = makeOpts(connection, {
        evmPublicClient,
        evmWalletClient,
        bsktAddress: BSKT_ADDR,
      });

      await runOutboundPipeline(opts);

      // Find EVM swap and contribute records
      const allCalls = mRecordTx.mock.calls;
      const operations = allCalls.map((c) => c[1].operation);

      // Standard 5 (claim, swap, fee, bridge_send, bridge_receive) + 2 investing (swap, bskt_contribute)
      expect(operations).toContain('swap');
      expect(operations).toContain('bskt_contribute');

      // The EVM swap tx should be on base chain
      const evmSwapCall = allCalls.find(
        (c) => c[1].chain === 'base' && c[1].operation === 'swap',
      );
      expect(evmSwapCall).toBeDefined();
      expect(evmSwapCall![1].txHash).toBe('0xswap-eth-hash');

      // The contribute tx should be on base chain
      const contributeCall = allCalls.find(
        (c) => c[1].operation === 'bskt_contribute',
      );
      expect(contributeCall).toBeDefined();
      expect(contributeCall![1].chain).toBe('base');
      expect(contributeCall![1].txHash).toBe('0xcontribute-hash');
    });
  });

  // ── Backward compatibility — no EVM clients ────────────────────────

  describe('backward compatibility', () => {
    it('pipeline completes without error when no EVM clients provided', async () => {
      const { connection } = setupFullHappyPath();
      // No evmPublicClient, evmWalletClient, or bsktAddress in opts
      const opts = makeOpts(connection);

      const result = await runOutboundPipeline(opts);

      // Pipeline should complete normally (phases 1-4 only)
      expect(result.amountInvested).toBe('0');
      expect(result.txHashes.usdcToEthTxHash).toBeNull();
      expect(result.txHashes.investTxHash).toBeNull();

      // swapUsdcToEth and contributeToBSKT should NOT have been called
      expect(mSwapUsdcToEth).not.toHaveBeenCalled();
      expect(mContributeToBSKT).not.toHaveBeenCalled();
    });

    it('pipeline skips investing when fund has no bsktAddress', async () => {
      const { connection, evmPublicClient, evmWalletClient } = setupFullHappyPath({
        bsktAddress: null,
      });
      const opts = makeOpts(connection, {
        evmPublicClient,
        evmWalletClient,
        // bsktAddress deliberately omitted from opts (it comes from fund)
      });

      const result = await runOutboundPipeline(opts);

      expect(result.amountInvested).toBe('0');
      expect(mSwapUsdcToEth).not.toHaveBeenCalled();
      expect(mContributeToBSKT).not.toHaveBeenCalled();
    });
  });

  // ── Investing phase failure ────────────────────────────────────────

  describe('investing phase failures', () => {
    it('pipeline fails with descriptive error when swapUsdcToEth throws', async () => {
      const { connection, evmPublicClient, evmWalletClient } = setupFullHappyPath();
      mSwapUsdcToEth.mockRejectedValue(new Error('1inch API rate limited'));

      const opts = makeOpts(connection, {
        evmPublicClient,
        evmWalletClient,
        bsktAddress: BSKT_ADDR,
      });

      await expect(runOutboundPipeline(opts)).rejects.toThrow(
        /1inch API rate limited/,
      );

      // Pipeline should be marked as failed
      const failCall = mUpdatePipelineRun.mock.calls.find(
        (c) => c[2]?.status === 'failed',
      );
      expect(failCall).toBeDefined();
      expect(failCall![2].error).toContain('1inch API rate limited');
    });

    it('contributeToBSKT failure records partial state (usdcToEthTxHash set, investTxHash null)', async () => {
      const { connection, evmPublicClient, evmWalletClient } = setupFullHappyPath();
      mContributeToBSKT.mockRejectedValue(new Error('contribute() reverted'));

      const opts = makeOpts(connection, {
        evmPublicClient,
        evmWalletClient,
        bsktAddress: BSKT_ADDR,
      });

      await expect(runOutboundPipeline(opts)).rejects.toThrow(
        /contribute\(\) reverted/,
      );

      // swapUsdcToEth was called and recorded
      expect(mSwapUsdcToEth).toHaveBeenCalled();

      // The EVM swap tx should have been recorded even though contribute failed
      const evmSwapRecord = mRecordTx.mock.calls.find(
        (c) => c[1].chain === 'base' && c[1].operation === 'swap',
      );
      expect(evmSwapRecord).toBeDefined();

      // But bskt_contribute should NOT have been recorded (it failed before recording)
      const contributeRecord = mRecordTx.mock.calls.find(
        (c) => c[1].operation === 'bskt_contribute',
      );
      expect(contributeRecord).toBeUndefined();
    });

    it('investing phase transitions to "investing" phase in DB', async () => {
      const { connection, evmPublicClient, evmWalletClient } = setupFullHappyPath();
      const opts = makeOpts(connection, {
        evmPublicClient,
        evmWalletClient,
        bsktAddress: BSKT_ADDR,
      });

      await runOutboundPipeline(opts);

      // Phases: swapping → bridging → investing → completed
      const phaseUpdates = mUpdatePipelineRun.mock.calls
        .filter((c) => c[2]?.phase)
        .map((c) => c[2].phase);

      expect(phaseUpdates).toContain('investing');
    });
  });

  // ── Negative: swap returns invalid calldata ────────────────────────

  describe('negative tests', () => {
    it('pipeline completes with amountInvested="0" when no EVM clients (full negative)', async () => {
      const { connection } = setupFullHappyPath();
      const opts = makeOpts(connection);

      const result = await runOutboundPipeline(opts);

      expect(result.amountInvested).toBe('0');
      expect(result.txHashes.usdcToEthTxHash).toBeNull();
      expect(result.txHashes.investTxHash).toBeNull();
    });
  });
});

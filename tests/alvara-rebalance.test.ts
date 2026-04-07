/**
 * Unit tests for the rebalance-BSKT flow.
 *
 * Mocks the Alvara API client (getRebalanceRoutes), erc7621 reads
 * (getConstituents, getOwner), bskt-pair LP balance, fs (ABI loading),
 * and viem calls. No real network or blockchain calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type Address, type Hash, type TransactionReceipt } from 'viem';

// ── Mocks (must be before imports) ─────────────────────────────────────────

vi.mock('../src/alvara/api.js', () => ({
  getRebalanceRoutes: vi.fn(),
  getContributeRoutes: vi.fn(),
  getApiBaseUrl: vi.fn(() => 'https://test.alvara.xyz'),
  setApiBaseUrl: vi.fn(),
}));

vi.mock('../src/alvara/erc7621.js', () => ({
  getConstituents: vi.fn(),
  getOwner: vi.fn(),
}));

vi.mock('../src/alvara/bskt-pair.js', () => ({
  getLPBalance: vi.fn(),
  loadBSKTPairABI: vi.fn(() => []),
}));

// Mock fs for ABI loading — return the rebalance function + BSKTRebalanced event ABI
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn((path: string, encoding?: string) => {
      if (typeof path === 'string' && path.includes('bskt-logic-abi.json')) {
        return JSON.stringify([
          {
            inputs: [
              { name: '_newTokens', type: 'address[]' },
              { name: '_newWeights', type: 'uint256[]' },
              { name: '_amountIn', type: 'uint256[]' },
              { name: '_swapData', type: 'bytes[]' },
              { name: '_signature', type: 'bytes' },
              { name: '_deadline', type: 'uint256' },
              { name: '_mode', type: 'uint8' },
            ],
            name: 'rebalance',
            outputs: [],
            stateMutability: 'nonpayable',
            type: 'function',
          },
          {
            anonymous: false,
            inputs: [
              { indexed: true, name: 'bskt', type: 'address' },
              { indexed: false, name: 'oldTokens', type: 'address[]' },
              { indexed: false, name: 'oldWeights', type: 'uint256[]' },
              { indexed: false, name: 'newTokens', type: 'address[]' },
              { indexed: false, name: 'newWeights', type: 'uint256[]' },
              { indexed: true, name: 'mode', type: 'uint8' },
            ],
            name: 'BSKTRebalanced',
            type: 'event',
          },
        ]);
      }
      return actual.readFileSync(path, encoding as any);
    }),
  };
});

import {
  rebalanceBSKT,
  RebalanceMode,
  type RebalanceOptions,
} from '../src/alvara/rebalance.js';
import { getRebalanceRoutes } from '../src/alvara/api.js';
import { getConstituents, getOwner } from '../src/alvara/erc7621.js';
import { getLPBalance } from '../src/alvara/bskt-pair.js';
import { encodeEventTopics, encodeAbiParameters } from 'viem';

// Suppress structured log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

// ── Test Fixtures ──────────────────────────────────────────────────────────

const MOCK_BSKT = '0x1234567890123456789012345678901234567890' as Address;
const MOCK_PAIR = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01' as Address;
const MOCK_USER = '0x9876543210987654321098765432109876543210' as Address;
const MOCK_TX_HASH = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hash;

const TOKEN_A = '0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb' as Address; // ALVA
const TOKEN_B = '0x4200000000000000000000000000000000000006' as Address; // WETH
const TOKEN_C = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address; // USDC

// ABI for encoding test event logs
const BSKT_REBALANCED_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'bskt', type: 'address' },
      { indexed: false, name: 'oldTokens', type: 'address[]' },
      { indexed: false, name: 'oldWeights', type: 'uint256[]' },
      { indexed: false, name: 'newTokens', type: 'address[]' },
      { indexed: false, name: 'newWeights', type: 'uint256[]' },
      { indexed: true, name: 'mode', type: 'uint8' },
    ],
    name: 'BSKTRebalanced',
    type: 'event',
  },
] as const;

function mockRouteResponse() {
  return {
    swapData: ['0xaabb', '0xccdd'] as `0x${string}`[],
    signature: '0xee11ff22' as `0x${string}`,
    deadline: Math.floor(Date.now() / 1000) + 3600,
  };
}

function mockReceipt(
  status: 'success' | 'reverted' = 'success',
  logs: any[] = [],
): TransactionReceipt {
  return {
    status,
    gasUsed: 350_000n,
    blockNumber: 12345n,
    transactionHash: MOCK_TX_HASH,
    blockHash: '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`,
    contractAddress: null,
    cumulativeGasUsed: 700_000n,
    effectiveGasPrice: 1_000_000n,
    from: MOCK_USER,
    logs,
    logsBloom: '0x' as `0x${string}`,
    to: MOCK_BSKT,
    transactionIndex: 0,
    type: 'eip1559',
    root: undefined,
  } as unknown as TransactionReceipt;
}

/** Encode a BSKTRebalanced event log for testing event parsing */
function encodeBSKTRebalancedLog(params: {
  bskt: Address;
  oldTokens: Address[];
  oldWeights: bigint[];
  newTokens: Address[];
  newWeights: bigint[];
  mode: number;
}) {
  // Build topics: [event signature, indexed bskt, indexed mode]
  const topics = encodeEventTopics({
    abi: BSKT_REBALANCED_EVENT_ABI,
    eventName: 'BSKTRebalanced',
    args: {
      bskt: params.bskt,
      mode: params.mode,
    },
  }) as [`0x${string}`, ...`0x${string}`[]];

  // Encode non-indexed args as data
  const data = encodeAbiParameters(
    [
      { name: 'oldTokens', type: 'address[]' },
      { name: 'oldWeights', type: 'uint256[]' },
      { name: 'newTokens', type: 'address[]' },
      { name: 'newWeights', type: 'uint256[]' },
    ],
    [params.oldTokens, params.oldWeights, params.newTokens, params.newWeights],
  );

  return {
    address: MOCK_BSKT,
    topics,
    data,
    blockNumber: 12345n,
    transactionHash: MOCK_TX_HASH,
    logIndex: 0,
    blockHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
    transactionIndex: 0,
    removed: false,
  };
}

function mockPublicClient(overrides?: {
  estimateGas?: () => Promise<bigint>;
  waitForTransactionReceipt?: () => Promise<TransactionReceipt>;
}) {
  return {
    estimateGas: overrides?.estimateGas ?? vi.fn(async () => 300_000n),
    waitForTransactionReceipt: overrides?.waitForTransactionReceipt ?? vi.fn(async () => {
      const eventLog = encodeBSKTRebalancedLog({
        bskt: MOCK_BSKT,
        oldTokens: [TOKEN_A, TOKEN_B],
        oldWeights: [500n, 9500n],
        newTokens: [TOKEN_A, TOKEN_B, TOKEN_C],
        newWeights: [500n, 7000n, 2500n],
        mode: 0,
      });
      return mockReceipt('success', [eventLog]);
    }),
  };
}

function mockWalletClient() {
  return {
    account: { address: MOCK_USER },
    chain: { id: 8453, name: 'Base' },
    writeContract: vi.fn(async () => MOCK_TX_HASH),
  };
}

function makeOpts(overrides?: Partial<RebalanceOptions>): RebalanceOptions {
  return {
    publicClient: mockPublicClient(),
    walletClient: mockWalletClient() as any,
    bsktAddress: MOCK_BSKT,
    newTokens: [TOKEN_A, TOKEN_B, TOKEN_C],
    newWeights: [500, 7000, 2500],
    amountIn: ['100000', '200000', '0'],
    mode: RebalanceMode.STANDARD,
    bsktPairAddress: MOCK_PAIR,
    ...overrides,
  };
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  // Default: current composition is TOKEN_A (5%) + TOKEN_B (95%)
  vi.mocked(getConstituents).mockResolvedValue({
    tokens: [TOKEN_A, TOKEN_B],
    weights: [500n, 9500n],
  });

  // Default: wallet IS the owner
  vi.mocked(getOwner).mockResolvedValue(MOCK_USER);

  // Default: route response
  vi.mocked(getRebalanceRoutes).mockResolvedValue(mockRouteResponse() as any);

  // Default: LP balance stable (not destroyed)
  vi.mocked(getLPBalance)
    .mockResolvedValueOnce(1000n)  // before
    .mockResolvedValueOnce(1000n); // after
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('rebalanceBSKT', () => {
  describe('happy path', () => {
    it('should complete full rebalance flow and parse BSKTRebalanced event', async () => {
      const opts = makeOpts();
      const result = await rebalanceBSKT(opts);

      // Pre-checks
      expect(getConstituents).toHaveBeenCalledWith(opts.publicClient, MOCK_BSKT);
      expect(getOwner).toHaveBeenCalledWith(opts.publicClient, MOCK_BSKT);

      // API called with correct params
      expect(getRebalanceRoutes).toHaveBeenCalledWith({
        bsktAddress: MOCK_BSKT,
        newTokens: [TOKEN_A, TOKEN_B, TOKEN_C],
        newWeights: [500, 7000, 2500],
        amountIn: ['100000', '200000', '0'],
        chainId: 8453,
        userAddress: MOCK_USER,
        mode: RebalanceMode.STANDARD,
      });

      // Transaction was sent
      expect(opts.walletClient.writeContract).toHaveBeenCalledTimes(1);

      // Result shape
      expect(result.txHash).toBe(MOCK_TX_HASH);
      expect(result.receipt).toBeTruthy();
      expect(result.receipt!.status).toBe('success');
      expect(result.gasUsed).toBe(350_000n);
      expect(result.oldTokens).toEqual([TOKEN_A, TOKEN_B]);
      expect(result.oldWeights).toEqual([500n, 9500n]);
      expect(result.newTokens).toEqual([TOKEN_A, TOKEN_B, TOKEN_C]);
      expect(result.newWeights).toEqual([500, 7000, 2500]);
      expect(result.routeData.swapDataCount).toBe(2);

      // Event parsed
      expect(result.event).not.toBeNull();
      expect(result.event!.bskt).toBe(MOCK_BSKT);
      expect(result.event!.oldTokens).toEqual([TOKEN_A, TOKEN_B]);
      expect(result.event!.newTokens).toEqual([TOKEN_A, TOKEN_B, TOKEN_C]);
      expect(result.event!.mode).toBe(0);
    });

    it('should return old composition from on-chain read', async () => {
      vi.mocked(getConstituents).mockResolvedValue({
        tokens: [TOKEN_A, TOKEN_C],
        weights: [2000n, 8000n],
      });

      const opts = makeOpts();
      const result = await rebalanceBSKT(opts);

      expect(result.oldTokens).toEqual([TOKEN_A, TOKEN_C]);
      expect(result.oldWeights).toEqual([2000n, 8000n]);
    });
  });

  describe('dry run mode', () => {
    it('should fetch routes and estimate gas without sending transaction', async () => {
      vi.mocked(getLPBalance).mockReset();
      vi.mocked(getLPBalance).mockResolvedValue(500n);

      const opts = makeOpts({ dryRun: true });
      const result = await rebalanceBSKT(opts);

      // No transaction sent
      expect(opts.walletClient.writeContract).not.toHaveBeenCalled();

      // Routes were still fetched
      expect(getRebalanceRoutes).toHaveBeenCalledTimes(1);

      // Result indicates dry run
      expect(result.txHash).toBeNull();
      expect(result.receipt).toBeNull();
      expect(result.gasUsed).toBe(0n);
      expect(result.gasEstimate).toBeGreaterThan(0n);
      expect(result.event).toBeNull();
      expect(result.lpBalanceBefore).toBe(500n);
      expect(result.lpBalanceAfter).toBe(500n);
    });

    it('should still perform ownership check in dry run', async () => {
      vi.mocked(getOwner).mockResolvedValue('0x0000000000000000000000000000000000000001' as Address);
      vi.mocked(getLPBalance).mockReset();
      vi.mocked(getLPBalance).mockResolvedValue(0n);

      const opts = makeOpts({ dryRun: true });

      await expect(rebalanceBSKT(opts)).rejects.toThrow('not the BSKT owner');
      expect(getRebalanceRoutes).not.toHaveBeenCalled();
    });
  });

  describe('owner mismatch', () => {
    it('should throw before API call when wallet is not BSKT owner', async () => {
      const differentOwner = '0x1111111111111111111111111111111111111111' as Address;
      vi.mocked(getOwner).mockResolvedValue(differentOwner);

      const opts = makeOpts();

      await expect(rebalanceBSKT(opts)).rejects.toThrow('not the BSKT owner');
      await expect(rebalanceBSKT(opts)).rejects.toThrow(MOCK_USER);

      // API was NOT called — owner check happens first
      expect(getRebalanceRoutes).not.toHaveBeenCalled();
      // Gas was NOT estimated
      expect(opts.publicClient.estimateGas).not.toHaveBeenCalled();
      // Transaction was NOT sent
      expect(opts.walletClient.writeContract).not.toHaveBeenCalled();
    });
  });

  describe('API failure', () => {
    it('should throw when getRebalanceRoutes rejects', async () => {
      vi.mocked(getRebalanceRoutes).mockRejectedValue(
        new Error('Alvara API /rebalance failed: HTTP 500'),
      );

      const opts = makeOpts();
      await expect(rebalanceBSKT(opts)).rejects.toThrow('Alvara API /rebalance failed');
    });
  });

  describe('gas estimation failure', () => {
    it('should throw on gas estimation failure', async () => {
      const pubClient = mockPublicClient({
        estimateGas: vi.fn(async () => {
          throw new Error('execution reverted: InvalidSignature');
        }),
      });

      const opts = makeOpts({ publicClient: pubClient });
      await expect(rebalanceBSKT(opts)).rejects.toThrow('Gas estimation failed');

      // Transaction was NOT sent
      expect(opts.walletClient.writeContract).not.toHaveBeenCalled();
    });
  });

  describe('transaction revert', () => {
    it('should throw when transaction reverts', async () => {
      const pubClient = mockPublicClient({
        waitForTransactionReceipt: vi.fn(async () => mockReceipt('reverted')),
      });

      const opts = makeOpts({ publicClient: pubClient });
      await expect(rebalanceBSKT(opts)).rejects.toThrow('transaction reverted');
    });
  });

  describe('event not found in receipt logs', () => {
    it('should return null event without throwing when BSKTRebalanced is not in logs', async () => {
      const pubClient = mockPublicClient({
        waitForTransactionReceipt: vi.fn(async () => mockReceipt('success', [])),
      });

      const opts = makeOpts({ publicClient: pubClient });
      const result = await rebalanceBSKT(opts);

      // Should complete without error
      expect(result.txHash).toBe(MOCK_TX_HASH);
      expect(result.event).toBeNull();
    });
  });

  describe('gas buffer', () => {
    it('should apply 10% gas buffer to estimate', async () => {
      const gasEstimate = 300_000n;
      const pubClient = mockPublicClient({
        estimateGas: vi.fn(async () => gasEstimate),
      });

      const wallet = mockWalletClient();
      const opts = makeOpts({ publicClient: pubClient, walletClient: wallet as any });
      await rebalanceBSKT(opts);

      const expectedGas = gasEstimate + gasEstimate / 10n; // 330_000n
      const writeCall = wallet.writeContract.mock.calls[0][0] as any;
      expect(writeCall.gas).toBe(expectedGas);
    });
  });

  describe('LP balance verification', () => {
    it('should read LP balance before and after rebalance', async () => {
      const opts = makeOpts();
      await rebalanceBSKT(opts);

      expect(getLPBalance).toHaveBeenCalledTimes(2);
      expect(getLPBalance).toHaveBeenNthCalledWith(1,
        opts.publicClient, MOCK_PAIR, MOCK_USER);
      expect(getLPBalance).toHaveBeenNthCalledWith(2,
        opts.publicClient, MOCK_PAIR, MOCK_USER);
    });

    it('should not throw when LP drops to zero (warning only)', async () => {
      vi.mocked(getLPBalance).mockReset();
      vi.mocked(getLPBalance)
        .mockResolvedValueOnce(1000n) // before
        .mockResolvedValueOnce(0n);   // after — destroyed

      const opts = makeOpts();
      const result = await rebalanceBSKT(opts);

      // Should complete without error
      expect(result.lpBalanceBefore).toBe(1000n);
      expect(result.lpBalanceAfter).toBe(0n);
      expect(result.txHash).toBe(MOCK_TX_HASH);
    });
  });

  describe('RebalanceMode enum', () => {
    it('should default to STANDARD (0) mode', async () => {
      const opts = makeOpts({ mode: undefined });
      await rebalanceBSKT(opts);

      const routeCall = vi.mocked(getRebalanceRoutes).mock.calls[0][0];
      expect(routeCall.mode).toBe(0);
    });

    it('should pass EMERGENCY_STABLES (1) mode to API and contract', async () => {
      const wallet = mockWalletClient();
      const opts = makeOpts({
        walletClient: wallet as any,
        mode: RebalanceMode.EMERGENCY_STABLES,
      });
      await rebalanceBSKT(opts);

      const routeCall = vi.mocked(getRebalanceRoutes).mock.calls[0][0];
      expect(routeCall.mode).toBe(1);

      const writeCall = wallet.writeContract.mock.calls[0][0] as any;
      // mode is the last arg (index 6)
      expect(writeCall.args[6]).toBe(RebalanceMode.EMERGENCY_STABLES);
    });
  });
});

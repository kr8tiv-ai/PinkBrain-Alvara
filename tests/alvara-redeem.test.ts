/**
 * Unit tests for the redeem-from-BSKT flow (withdrawETH).
 *
 * Mocks the Alvara API client (getWithdrawETHRoutes), viem contract calls
 * (estimateGas, writeContract, waitForTransactionReceipt, getBalance), and
 * bskt-pair LP balance reads. No real network or blockchain calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatEther, type Address, type Hash, type TransactionReceipt } from 'viem';

// Mock the API module before importing redeem
vi.mock('../src/alvara/api.js', () => ({
  getWithdrawETHRoutes: vi.fn(),
  getApiBaseUrl: vi.fn(() => 'https://test.alvara.xyz'),
  setApiBaseUrl: vi.fn(),
}));

// Mock bskt-pair LP balance reads
vi.mock('../src/alvara/bskt-pair.js', () => ({
  getLPBalance: vi.fn(),
  loadBSKTPairABI: vi.fn(() => []),
}));

// Mock fs for ABI loading
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn((path: string, encoding?: string) => {
      if (typeof path === 'string' && path.includes('bskt-logic-abi.json')) {
        return JSON.stringify([
          {
            inputs: [
              { name: '_liquidity', type: 'uint256' },
              { name: '_swapData', type: 'bytes[]' },
              { name: '_signature', type: 'bytes' },
              { name: '_deadline', type: 'uint256' },
            ],
            name: 'withdrawETH',
            outputs: [],
            stateMutability: 'nonpayable',
            type: 'function',
          },
          {
            anonymous: false,
            inputs: [
              { indexed: false, internalType: 'address', name: 'bskt', type: 'address' },
              { indexed: true, internalType: 'address', name: 'sender', type: 'address' },
              { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
            ],
            name: 'WithdrawnETHFromBSKT',
            type: 'event',
          },
        ]);
      }
      return actual.readFileSync(path, encoding as any);
    }),
  };
});

import { redeemBSKTForETH, type RedeemOptions } from '../src/alvara/redeem.js';
import { getWithdrawETHRoutes } from '../src/alvara/api.js';
import { getLPBalance } from '../src/alvara/bskt-pair.js';

// Suppress structured log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

// -------------------------------------------------------------------
// Test Fixtures
// -------------------------------------------------------------------

const MOCK_BSKT_ADDRESS = '0x1234567890123456789012345678901234567890' as Address;
const MOCK_PAIR_ADDRESS = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01' as Address;
const MOCK_USER_ADDRESS = '0x9876543210987654321098765432109876543210' as Address;
const MOCK_TX_HASH = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hash;

const MOCK_LP_BALANCE = 1_000_000_000_000_000_000n; // 1.0 LP token
const MOCK_ETH_RECEIVED = 500_000_000_000_000_000n; // 0.5 ETH

function mockRouteResponse() {
  return {
    swapData: ['0xaabb', '0xccdd'] as `0x${string}`[],
    signature: '0xee11ff22' as `0x${string}`,
    deadline: Math.floor(Date.now() / 1000) + 3600,
  };
}

function mockReceipt(status: 'success' | 'reverted' = 'success'): TransactionReceipt {
  return {
    status,
    gasUsed: 350_000n,
    blockNumber: 12345n,
    transactionHash: MOCK_TX_HASH,
    blockHash: '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`,
    contractAddress: null,
    cumulativeGasUsed: 500_000n,
    effectiveGasPrice: 1_000_000n,
    from: MOCK_USER_ADDRESS,
    logs: [],
    logsBloom: '0x' as `0x${string}`,
    to: MOCK_BSKT_ADDRESS,
    transactionIndex: 0,
    type: 'eip1559',
    root: undefined,
  } as unknown as TransactionReceipt;
}

function mockReceiptWithEvent(ethAmount: bigint = MOCK_ETH_RECEIVED): TransactionReceipt {
  // Encode WithdrawnETHFromBSKT event log
  // Event: WithdrawnETHFromBSKT(address bskt, address indexed sender, uint256 amount)
  // topic0 = keccak256("WithdrawnETHFromBSKT(address,address,uint256)")
  const topic0 = '0xc37266ec9deff1378fe090bdd905a5dd26816731036ee0c294fb664059e1cf57';
  // topic1 = indexed sender padded to 32 bytes
  const topic1 = '0x000000000000000000000000' + MOCK_USER_ADDRESS.slice(2);
  // data = abi.encode(address bskt, uint256 amount) — non-indexed params
  const bsktPadded = '000000000000000000000000' + MOCK_BSKT_ADDRESS.slice(2);
  const amountHex = ethAmount.toString(16).padStart(64, '0');
  const data = ('0x' + bsktPadded + amountHex) as `0x${string}`;

  const receipt = mockReceipt('success');
  (receipt as any).logs = [
    {
      address: MOCK_BSKT_ADDRESS,
      topics: [topic0 as `0x${string}`, topic1 as `0x${string}`],
      data,
      blockNumber: 12345n,
      transactionHash: MOCK_TX_HASH,
      logIndex: 0,
      blockHash: '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`,
      transactionIndex: 0,
      removed: false,
    },
  ];
  return receipt;
}

/** Build mock public client */
function mockPublicClient(overrides?: {
  estimateGas?: () => Promise<bigint>;
  waitForTransactionReceipt?: () => Promise<TransactionReceipt>;
  getBalance?: () => Promise<bigint>;
}) {
  return {
    estimateGas: overrides?.estimateGas ?? vi.fn(async () => 300_000n),
    waitForTransactionReceipt: overrides?.waitForTransactionReceipt ??
      vi.fn(async () => mockReceiptWithEvent()),
    getBalance: overrides?.getBalance ??
      vi.fn()
        .mockResolvedValueOnce(1_000_000_000_000_000_000n)   // before
        .mockResolvedValueOnce(1_500_000_000_000_000_000n),  // after (0.5 ETH received)
  };
}

/** Build mock wallet client */
function mockWalletClient() {
  return {
    account: { address: MOCK_USER_ADDRESS },
    chain: { id: 8453, name: 'Base' },
    writeContract: vi.fn(async () => MOCK_TX_HASH),
  };
}

/** Standard options for most tests */
function makeOpts(overrides?: Partial<RedeemOptions>): RedeemOptions {
  return {
    publicClient: mockPublicClient(),
    walletClient: mockWalletClient() as any,
    bsktAddress: MOCK_BSKT_ADDRESS,
    bsktPairAddress: MOCK_PAIR_ADDRESS,
    ...overrides,
  };
}

// -------------------------------------------------------------------
// Setup / Teardown
// -------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(getWithdrawETHRoutes).mockResolvedValue(mockRouteResponse() as any);
  vi.mocked(getLPBalance)
    .mockResolvedValueOnce(MOCK_LP_BALANCE)  // before
    .mockResolvedValueOnce(0n);              // after — fully burned
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

describe('redeemBSKTForETH', () => {
  describe('happy path', () => {
    it('should complete full redeem flow — routes fetched, tx sent, LP burned, ETH received', async () => {
      const opts = makeOpts();
      const result = await redeemBSKTForETH(opts);

      // API was called with correct params
      expect(getWithdrawETHRoutes).toHaveBeenCalledWith({
        bsktAddress: MOCK_BSKT_ADDRESS,
        liquidity: String(MOCK_LP_BALANCE),
        chainId: 8453,
        userAddress: MOCK_USER_ADDRESS,
      });

      // Transaction was sent
      expect(opts.walletClient.writeContract).toHaveBeenCalledTimes(1);

      // Result shape
      expect(result.txHash).toBe(MOCK_TX_HASH);
      expect(result.receipt).toBeTruthy();
      expect(result.receipt!.status).toBe('success');
      expect(result.gasUsed).toBe(350_000n);
      expect(result.lpBalanceBefore).toBe(MOCK_LP_BALANCE);
      expect(result.lpBalanceAfter).toBe(0n);
      expect(result.ethReceived).toBe(MOCK_ETH_RECEIVED);
      expect(result.routeData.swapDataCount).toBe(2);
    });

    it('should call withdrawETH with correct args including full LP as liquidity', async () => {
      const routes = mockRouteResponse();
      vi.mocked(getWithdrawETHRoutes).mockResolvedValue(routes as any);

      const wallet = mockWalletClient();
      const opts = makeOpts({ walletClient: wallet as any });
      await redeemBSKTForETH(opts);

      const writeCall = wallet.writeContract.mock.calls[0][0] as any;
      expect(writeCall.address).toBe(MOCK_BSKT_ADDRESS);
      expect(writeCall.functionName).toBe('withdrawETH');
      // withdrawETH args: [liquidity, swapData, signature, deadline]
      expect(writeCall.args[0]).toBe(MOCK_LP_BALANCE);
      expect(writeCall.args[1]).toEqual(routes.swapData);
      expect(writeCall.args[2]).toBe(routes.signature);
      expect(writeCall.args[3]).toBe(BigInt(routes.deadline));
    });

    it('should apply 10% gas buffer', async () => {
      const gasEstimate = 300_000n;
      const pubClient = mockPublicClient({
        estimateGas: vi.fn(async () => gasEstimate),
      });

      const wallet = mockWalletClient();
      const opts = makeOpts({ publicClient: pubClient, walletClient: wallet as any });
      await redeemBSKTForETH(opts);

      const writeCall = wallet.writeContract.mock.calls[0][0] as any;
      const expectedGas = gasEstimate + gasEstimate / 10n; // 330_000n
      expect(writeCall.gas).toBe(expectedGas);
    });
  });

  describe('dry-run mode', () => {
    it('should not send transaction in dry run — routes fetched, gas estimated, no tx', async () => {
      vi.mocked(getLPBalance).mockReset();
      vi.mocked(getLPBalance).mockResolvedValue(MOCK_LP_BALANCE);

      const opts = makeOpts({ dryRun: true });
      const result = await redeemBSKTForETH(opts);

      // No transaction sent
      expect(opts.walletClient.writeContract).not.toHaveBeenCalled();

      // Result indicates dry run
      expect(result.txHash).toBeNull();
      expect(result.receipt).toBeNull();
      expect(result.ethReceived).toBe(0n);
      expect(result.gasUsed).toBe(0n);
      expect(result.gasEstimate).toBeGreaterThan(0n);
      expect(result.lpBalanceBefore).toBe(MOCK_LP_BALANCE);
      expect(result.lpBalanceAfter).toBe(MOCK_LP_BALANCE); // unchanged
    });

    it('should still estimate gas in dry run mode', async () => {
      vi.mocked(getLPBalance).mockReset();
      vi.mocked(getLPBalance).mockResolvedValue(MOCK_LP_BALANCE);

      const customGas = 450_000n;
      const pubClient = mockPublicClient({
        estimateGas: vi.fn(async () => customGas),
      });

      const opts = makeOpts({ publicClient: pubClient, dryRun: true });
      const result = await redeemBSKTForETH(opts);

      expect(result.gasEstimate).toBe(customGas);
    });
  });

  describe('error paths', () => {
    it('should throw on zero LP balance', async () => {
      vi.mocked(getLPBalance).mockReset();
      vi.mocked(getLPBalance).mockResolvedValue(0n);

      const opts = makeOpts();
      await expect(redeemBSKTForETH(opts)).rejects.toThrow('No LP balance to redeem');
    });

    it('should throw on API failure', async () => {
      vi.mocked(getWithdrawETHRoutes).mockRejectedValue(
        new Error('Alvara API /withdraw-eth failed: HTTP 500'),
      );

      const opts = makeOpts();
      await expect(redeemBSKTForETH(opts)).rejects.toThrow('Alvara API /withdraw-eth failed');
    });

    it('should throw on gas estimation failure', async () => {
      const pubClient = mockPublicClient({
        estimateGas: vi.fn(async () => { throw new Error('execution reverted: InvalidSignature'); }),
      });

      const opts = makeOpts({ publicClient: pubClient });
      await expect(redeemBSKTForETH(opts)).rejects.toThrow('Gas estimation failed');
      expect(opts.walletClient.writeContract).not.toHaveBeenCalled();
    });

    it('should throw on transaction revert with tx hash', async () => {
      const pubClient = mockPublicClient({
        waitForTransactionReceipt: vi.fn(async () => mockReceipt('reverted')),
      });

      const opts = makeOpts({ publicClient: pubClient });
      await expect(redeemBSKTForETH(opts)).rejects.toThrow('withdrawETH() transaction reverted');
    });
  });

  describe('LP balance verification', () => {
    it('should warn but not throw when LP balance does not decrease', async () => {
      vi.mocked(getLPBalance).mockReset();
      vi.mocked(getLPBalance)
        .mockResolvedValueOnce(MOCK_LP_BALANCE)   // before
        .mockResolvedValueOnce(MOCK_LP_BALANCE);   // after — no decrease

      const opts = makeOpts();
      // Should NOT throw — just log a warning
      const result = await redeemBSKTForETH(opts);
      expect(result.lpBalanceBefore).toBe(MOCK_LP_BALANCE);
      expect(result.lpBalanceAfter).toBe(MOCK_LP_BALANCE);
      expect(result.txHash).toBe(MOCK_TX_HASH);
    });

    it('should read LP balance before and after redeem', async () => {
      const opts = makeOpts();
      await redeemBSKTForETH(opts);

      // getLPBalance called twice: once before, once after
      expect(getLPBalance).toHaveBeenCalledTimes(2);
      expect(getLPBalance).toHaveBeenNthCalledWith(1,
        opts.publicClient, MOCK_PAIR_ADDRESS, MOCK_USER_ADDRESS);
      expect(getLPBalance).toHaveBeenNthCalledWith(2,
        opts.publicClient, MOCK_PAIR_ADDRESS, MOCK_USER_ADDRESS);
    });
  });

  describe('WithdrawnETHFromBSKT event parsing', () => {
    it('should use event amount when WithdrawnETHFromBSKT is present in logs', async () => {
      const eventETH = 750_000_000_000_000_000n; // 0.75 ETH from event
      const pubClient = mockPublicClient({
        waitForTransactionReceipt: vi.fn(async () => mockReceiptWithEvent(eventETH)),
      });

      const opts = makeOpts({ publicClient: pubClient });
      const result = await redeemBSKTForETH(opts);

      // Should use the event amount, not balance delta
      expect(result.ethReceived).toBe(eventETH);
    });

    it('should fall back to balance delta when event not found in logs', async () => {
      // Receipt with no matching logs
      const pubClient = mockPublicClient({
        waitForTransactionReceipt: vi.fn(async () => mockReceipt('success')),
        // getBalance returns 1 ETH before, 1.5 ETH after = 0.5 ETH delta
        getBalance: vi.fn()
          .mockResolvedValueOnce(1_000_000_000_000_000_000n)
          .mockResolvedValueOnce(1_500_000_000_000_000_000n),
      });

      const opts = makeOpts({ publicClient: pubClient });
      const result = await redeemBSKTForETH(opts);

      expect(result.ethReceived).toBe(500_000_000_000_000_000n);
    });
  });
});

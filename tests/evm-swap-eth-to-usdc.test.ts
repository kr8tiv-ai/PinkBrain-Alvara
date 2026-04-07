/**
 * Unit tests for the ETH → USDC swap flow (swapEthToUsdc).
 *
 * Mocks 1inch API fetch, viem wallet/public client.
 * No real network or blockchain calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type Address, type Hash, type TransactionReceipt, erc20Abi } from 'viem';

// Suppress structured log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

// Mock global fetch for 1inch API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  swapEthToUsdc,
  type SwapEthToUsdcOptions,
} from '../src/evm/swap.js';

// -------------------------------------------------------------------
// Test Fixtures
// -------------------------------------------------------------------

const MOCK_USER_ADDRESS = '0x9876543210987654321098765432109876543210' as Address;
const MOCK_TX_HASH = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hash;
const MOCK_ROUTER_ADDRESS = '0x111111125421cA6dc452d289314280a0f8842A65' as Address;

const MOCK_ETH_AMOUNT = 500_000_000_000_000_000n; // 0.5 ETH
const MOCK_USDC_RECEIVED = 1_250_000_000n; // 1250 USDC (6 decimals)

function mock1inchResponse(toAmount = String(MOCK_USDC_RECEIVED)) {
  return {
    tx: {
      from: MOCK_USER_ADDRESS,
      to: MOCK_ROUTER_ADDRESS,
      data: '0xabcdef',
      value: String(MOCK_ETH_AMOUNT),
      gas: 200_000,
      gasPrice: '1000000',
    },
    toAmount,
  };
}

function mockReceipt(status: 'success' | 'reverted' = 'success'): TransactionReceipt {
  return {
    status,
    gasUsed: 180_000n,
    blockNumber: 12345n,
    transactionHash: MOCK_TX_HASH,
    blockHash: '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`,
    contractAddress: null,
    cumulativeGasUsed: 500_000n,
    effectiveGasPrice: 1_000_000n,
    from: MOCK_USER_ADDRESS,
    logs: [],
    logsBloom: '0x' as `0x${string}`,
    to: MOCK_ROUTER_ADDRESS,
    transactionIndex: 0,
    type: 'eip1559',
    root: undefined,
  } as unknown as TransactionReceipt;
}

/** Build mock public client for ETH→USDC tests */
function mockPublicClient(overrides?: {
  readContract?: (...args: any[]) => Promise<any>;
  waitForTransactionReceipt?: () => Promise<TransactionReceipt>;
}) {
  let readCallCount = 0;
  const defaultReadContract = vi.fn(async (args: any) => {
    // USDC balanceOf — return before then after
    if (args.functionName === 'balanceOf') {
      return readCallCount++ === 0
        ? 5_000_000_000n   // before: 5000 USDC
        : 5_000_000_000n + MOCK_USDC_RECEIVED;  // after: 5000 + 1250 USDC
    }
    return 0n;
  });

  return {
    readContract: overrides?.readContract ?? defaultReadContract,
    waitForTransactionReceipt: overrides?.waitForTransactionReceipt ??
      vi.fn(async () => mockReceipt()),
  };
}

/** Build mock wallet client */
function mockWalletClient() {
  return {
    account: { address: MOCK_USER_ADDRESS },
    chain: { id: 8453, name: 'Base' },
    sendTransaction: vi.fn(async () => MOCK_TX_HASH),
  };
}

/** Standard options */
function makeOpts(overrides?: Partial<SwapEthToUsdcOptions>): SwapEthToUsdcOptions {
  return {
    publicClient: mockPublicClient(),
    walletClient: mockWalletClient() as any,
    ethAmount: MOCK_ETH_AMOUNT,
    ...overrides,
  };
}

// -------------------------------------------------------------------
// Setup / Teardown
// -------------------------------------------------------------------

beforeEach(() => {
  // Mock fetch to return 1inch swap response
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => mock1inchResponse(),
    text: async () => JSON.stringify(mock1inchResponse()),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mockFetch.mockReset();
});

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

describe('swapEthToUsdc', () => {
  describe('happy path', () => {
    it('should execute ETH→USDC swap and return USDC delta', async () => {
      const opts = makeOpts();
      const result = await swapEthToUsdc(opts);

      expect(result.txHash).toBe(MOCK_TX_HASH);
      expect(result.usdcReceived).toBe(MOCK_USDC_RECEIVED);

      // Transaction was sent with ETH value
      expect(opts.walletClient.sendTransaction).toHaveBeenCalledTimes(1);
      const txArgs = (opts.walletClient as any).sendTransaction.mock.calls[0][0];
      expect(BigInt(txArgs.value)).toBe(MOCK_ETH_AMOUNT);
    });

    it('should not perform any ERC-20 approval for native ETH', async () => {
      const opts = makeOpts();
      await swapEthToUsdc(opts);

      // readContract is only called for balanceOf (before + after), never for allowance/approve
      const readContractCalls = (opts.publicClient.readContract as any).mock?.calls || [];
      for (const call of readContractCalls) {
        expect(call[0].functionName).not.toBe('allowance');
        expect(call[0].functionName).not.toBe('approve');
      }
    });

    it('should call 1inch API with ETH as src and USDC as dst', async () => {
      const opts = makeOpts();
      await swapEthToUsdc(opts);

      // Check that fetch was called with correct params
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain('src=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
      expect(fetchUrl).toContain('dst=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
      expect(fetchUrl).toContain(`amount=${MOCK_ETH_AMOUNT.toString()}`);
    });

    it('should apply 10% gas buffer to swap transaction', async () => {
      const opts = makeOpts();
      await swapEthToUsdc(opts);

      const txArgs = (opts.walletClient as any).sendTransaction.mock.calls[0][0];
      // 200_000 + 20_000 = 220_000
      expect(BigInt(txArgs.gas)).toBe(220_000n);
    });
  });

  describe('input validation', () => {
    it('should reject zero ethAmount', async () => {
      const opts = makeOpts({ ethAmount: 0n });
      await expect(swapEthToUsdc(opts)).rejects.toThrow('ethAmount must be > 0');
    });

    it('should reject negative ethAmount', async () => {
      const opts = makeOpts({ ethAmount: -1n });
      await expect(swapEthToUsdc(opts)).rejects.toThrow('ethAmount must be > 0');
    });
  });

  describe('1inch API error handling', () => {
    it('should throw on 1inch API HTTP error with status and body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      });

      const opts = makeOpts();
      await expect(swapEthToUsdc(opts)).rejects.toThrow('1inch Swap API error 429');
    });

    it('should throw on 1inch API timeout', async () => {
      mockFetch.mockImplementation(async (_url: string, init: any) => {
        // Trigger abort
        const error = new Error('The operation was aborted');
        error.message = 'abort';
        throw error;
      });

      const opts = makeOpts();
      await expect(swapEthToUsdc(opts)).rejects.toThrow('timeout');
    });

    it('should throw on invalid 1inch response — missing tx.data', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ tx: { to: '0xabc' }, toAmount: '100' }),
      });

      const opts = makeOpts();
      await expect(swapEthToUsdc(opts)).rejects.toThrow('invalid response');
    });

    it('should throw on invalid 1inch response — missing toAmount', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          tx: { from: MOCK_USER_ADDRESS, to: MOCK_ROUTER_ADDRESS, data: '0xabc', value: '0', gas: 200000 },
        }),
      });

      const opts = makeOpts();
      await expect(swapEthToUsdc(opts)).rejects.toThrow('invalid response');
    });
  });

  describe('transaction error handling', () => {
    it('should throw on swap transaction revert', async () => {
      const pubClient = mockPublicClient({
        waitForTransactionReceipt: vi.fn(async () => mockReceipt('reverted')),
      });

      const opts = makeOpts({ publicClient: pubClient });
      await expect(swapEthToUsdc(opts)).rejects.toThrow('ETH→USDC swap transaction reverted');
    });
  });
});

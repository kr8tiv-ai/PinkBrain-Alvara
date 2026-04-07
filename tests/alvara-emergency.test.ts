/**
 * Unit tests for the emergency stables and revert module.
 *
 * Mocks rebalanceBSKT() and getConstituents() — no real network/chain calls.
 * Covers: happy path emergency + revert, empty snapshot validation,
 * dry-run propagation, error propagation, token mismatch warning,
 * snapshot length mismatch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Address, Hash, TransactionReceipt } from 'viem';

// ── Mocks (must be before imports) ─────────────────────────────────────────

vi.mock('../src/alvara/rebalance.js', () => ({
  rebalanceBSKT: vi.fn(),
  RebalanceMode: {
    STANDARD: 0,
    EMERGENCY_STABLES: 1,
    REVERT_EMERGENCY: 2,
  },
}));

vi.mock('../src/alvara/erc7621.js', () => ({
  getConstituents: vi.fn(),
  getOwner: vi.fn(),
}));

import {
  emergencyStables,
  emergencyRevert,
  EMERGENCY_USDT_WEIGHT,
  EMERGENCY_ALVA_WEIGHT,
  type EmergencyStablesOptions,
  type EmergencyRevertOptions,
} from '../src/alvara/emergency.js';
import { rebalanceBSKT, RebalanceMode } from '../src/alvara/rebalance.js';
import { getConstituents } from '../src/alvara/erc7621.js';
import { KNOWN_ADDRESSES } from '../src/config/chains.js';

// Suppress structured log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

// ── Test Fixtures ──────────────────────────────────────────────────────────

const MOCK_BSKT = '0x1234567890123456789012345678901234567890' as Address;
const MOCK_PAIR = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01' as Address;
const MOCK_USER = '0x9876543210987654321098765432109876543210' as Address;
const MOCK_TX_HASH = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hash;

const TOKEN_ALVA = KNOWN_ADDRESSES.ALVA;
const TOKEN_WETH = KNOWN_ADDRESSES.WETH;
const TOKEN_USDC = KNOWN_ADDRESSES.USDC;
const TOKEN_USDT = KNOWN_ADDRESSES.USDT;

/** Standard 3-token composition for snapshot testing */
const ORIGINAL_COMPOSITION = {
  tokens: [TOKEN_ALVA, TOKEN_WETH, TOKEN_USDC] as Address[],
  weights: [500n, 6000n, 3500n],
};

function mockRebalanceResult(overrides: Record<string, unknown> = {}) {
  return {
    txHash: MOCK_TX_HASH,
    receipt: { status: 'success', gasUsed: 400_000n } as unknown as TransactionReceipt,
    oldTokens: ORIGINAL_COMPOSITION.tokens,
    oldWeights: ORIGINAL_COMPOSITION.weights,
    newTokens: [TOKEN_USDT, TOKEN_ALVA] as Address[],
    newWeights: [EMERGENCY_USDT_WEIGHT, EMERGENCY_ALVA_WEIGHT],
    gasUsed: 400_000n,
    gasEstimate: 350_000n,
    event: {
      bskt: MOCK_BSKT,
      oldTokens: ORIGINAL_COMPOSITION.tokens,
      oldWeights: ORIGINAL_COMPOSITION.weights.map(w => w),
      newTokens: [TOKEN_USDT, TOKEN_ALVA] as Address[],
      newWeights: [9500n, 500n],
      mode: RebalanceMode.EMERGENCY_STABLES,
    },
    lpBalanceBefore: 1000n,
    lpBalanceAfter: 1000n,
    routeData: { swapDataCount: 2, deadline: Math.floor(Date.now() / 1000) + 3600 },
    ...overrides,
  };
}

function mockDryRunResult() {
  return {
    txHash: null,
    receipt: null,
    oldTokens: ORIGINAL_COMPOSITION.tokens,
    oldWeights: ORIGINAL_COMPOSITION.weights,
    newTokens: [TOKEN_USDT, TOKEN_ALVA] as Address[],
    newWeights: [EMERGENCY_USDT_WEIGHT, EMERGENCY_ALVA_WEIGHT],
    gasUsed: 0n,
    gasEstimate: 350_000n,
    event: null,
    lpBalanceBefore: 1000n,
    lpBalanceAfter: 1000n,
    routeData: { swapDataCount: 2, deadline: Math.floor(Date.now() / 1000) + 3600 },
  };
}

function mockPublicClient() {
  return { readContract: vi.fn() } as any;
}

function mockWalletClient() {
  return {
    account: { address: MOCK_USER },
    chain: { id: 8453, name: 'Base' },
  } as any;
}

function makeEmergencyOpts(overrides?: Partial<EmergencyStablesOptions>): EmergencyStablesOptions {
  return {
    publicClient: mockPublicClient(),
    walletClient: mockWalletClient(),
    bsktAddress: MOCK_BSKT,
    bsktPairAddress: MOCK_PAIR,
    ...overrides,
  };
}

function makeRevertOpts(overrides?: Partial<EmergencyRevertOptions>): EmergencyRevertOptions {
  return {
    publicClient: mockPublicClient(),
    walletClient: mockWalletClient(),
    bsktAddress: MOCK_BSKT,
    snapshot: { ...ORIGINAL_COMPOSITION },
    bsktPairAddress: MOCK_PAIR,
    ...overrides,
  };
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  // Default: BSKT has the original 3-token composition
  vi.mocked(getConstituents).mockResolvedValue({ ...ORIGINAL_COMPOSITION });

  // Default: rebalanceBSKT succeeds with emergency result
  vi.mocked(rebalanceBSKT).mockResolvedValue(mockRebalanceResult() as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('emergencyStables', () => {
  describe('happy path', () => {
    it('should read composition, snapshot it, and rebalance to USDT+ALVA', async () => {
      const opts = makeEmergencyOpts();
      const result = await emergencyStables(opts);

      // Snapshot is the original composition
      expect(result.snapshot.tokens).toEqual(ORIGINAL_COMPOSITION.tokens);
      expect(result.snapshot.weights).toEqual(ORIGINAL_COMPOSITION.weights);

      // rebalanceBSKT was called with correct emergency targets
      expect(rebalanceBSKT).toHaveBeenCalledTimes(1);
      const rebalanceCall = vi.mocked(rebalanceBSKT).mock.calls[0][0];
      expect(rebalanceCall.newTokens).toEqual([TOKEN_USDT, TOKEN_ALVA]);
      expect(rebalanceCall.newWeights).toEqual([EMERGENCY_USDT_WEIGHT, EMERGENCY_ALVA_WEIGHT]);
      expect(rebalanceCall.mode).toBe(RebalanceMode.EMERGENCY_STABLES);
      expect(rebalanceCall.bsktAddress).toBe(MOCK_BSKT);

      // Result contains rebalance data
      expect(result.rebalanceResult.txHash).toBe(MOCK_TX_HASH);
      expect(result.rebalanceResult.event).not.toBeNull();
    });

    it('should use default amountIn of ["0","0"] when not provided', async () => {
      const opts = makeEmergencyOpts();
      await emergencyStables(opts);

      const rebalanceCall = vi.mocked(rebalanceBSKT).mock.calls[0][0];
      expect(rebalanceCall.amountIn).toEqual(['0', '0']);
    });

    it('should pass custom amountIn when provided', async () => {
      const opts = makeEmergencyOpts({ amountIn: ['100000', '50000'] });
      await emergencyStables(opts);

      const rebalanceCall = vi.mocked(rebalanceBSKT).mock.calls[0][0];
      expect(rebalanceCall.amountIn).toEqual(['100000', '50000']);
    });
  });

  describe('validation', () => {
    it('should throw when BSKT has empty composition', async () => {
      vi.mocked(getConstituents).mockResolvedValue({ tokens: [], weights: [] });

      const opts = makeEmergencyOpts();
      await expect(emergencyStables(opts)).rejects.toThrow('no constituents');

      // rebalanceBSKT was NOT called
      expect(rebalanceBSKT).not.toHaveBeenCalled();
    });
  });

  describe('dry run', () => {
    it('should propagate dryRun to rebalanceBSKT', async () => {
      vi.mocked(rebalanceBSKT).mockResolvedValue(mockDryRunResult() as any);

      const opts = makeEmergencyOpts({ dryRun: true });
      const result = await emergencyStables(opts);

      const rebalanceCall = vi.mocked(rebalanceBSKT).mock.calls[0][0];
      expect(rebalanceCall.dryRun).toBe(true);

      // Still returns snapshot
      expect(result.snapshot.tokens).toEqual(ORIGINAL_COMPOSITION.tokens);
      expect(result.rebalanceResult.txHash).toBeNull();
    });
  });

  describe('error propagation', () => {
    it('should surface rebalanceBSKT failure', async () => {
      vi.mocked(rebalanceBSKT).mockRejectedValue(
        new Error('Gas estimation failed for rebalance(): execution reverted'),
      );

      const opts = makeEmergencyOpts();
      await expect(emergencyStables(opts)).rejects.toThrow('Gas estimation failed');
    });

    it('should surface getConstituents failure', async () => {
      vi.mocked(getConstituents).mockRejectedValue(
        new Error('Contract read error: network timeout'),
      );

      const opts = makeEmergencyOpts();
      await expect(emergencyStables(opts)).rejects.toThrow('network timeout');
      expect(rebalanceBSKT).not.toHaveBeenCalled();
    });
  });

  describe('constants', () => {
    it('should export correct emergency weight constants', () => {
      expect(EMERGENCY_USDT_WEIGHT).toBe(9500);
      expect(EMERGENCY_ALVA_WEIGHT).toBe(500);
      expect(EMERGENCY_USDT_WEIGHT + EMERGENCY_ALVA_WEIGHT).toBe(10000);
    });
  });
});

describe('emergencyRevert', () => {
  describe('happy path', () => {
    it('should call rebalanceBSKT with original snapshot composition', async () => {
      const revertResult = mockRebalanceResult({
        newTokens: ORIGINAL_COMPOSITION.tokens,
        newWeights: ORIGINAL_COMPOSITION.weights.map(w => Number(w)),
        event: {
          bskt: MOCK_BSKT,
          oldTokens: [TOKEN_USDT, TOKEN_ALVA],
          oldWeights: [9500n, 500n],
          newTokens: ORIGINAL_COMPOSITION.tokens,
          newWeights: ORIGINAL_COMPOSITION.weights,
          mode: RebalanceMode.REVERT_EMERGENCY,
        },
      });
      vi.mocked(rebalanceBSKT).mockResolvedValue(revertResult as any);

      const opts = makeRevertOpts();
      const result = await emergencyRevert(opts);

      // rebalanceBSKT was called with original tokens/weights
      const rebalanceCall = vi.mocked(rebalanceBSKT).mock.calls[0][0];
      expect(rebalanceCall.newTokens).toEqual(ORIGINAL_COMPOSITION.tokens);
      expect(rebalanceCall.newWeights).toEqual([500, 6000, 3500]); // bigint → number
      expect(rebalanceCall.mode).toBe(RebalanceMode.REVERT_EMERGENCY);

      expect(result.txHash).toBe(MOCK_TX_HASH);
    });

    it('should default amountIn to zeros matching snapshot length', async () => {
      vi.mocked(rebalanceBSKT).mockResolvedValue(mockRebalanceResult() as any);

      const opts = makeRevertOpts(); // no amountIn
      await emergencyRevert(opts);

      const rebalanceCall = vi.mocked(rebalanceBSKT).mock.calls[0][0];
      expect(rebalanceCall.amountIn).toEqual(['0', '0', '0']); // 3 tokens in snapshot
    });

    it('should pass custom amountIn when provided', async () => {
      vi.mocked(rebalanceBSKT).mockResolvedValue(mockRebalanceResult() as any);

      const opts = makeRevertOpts({ amountIn: ['1000', '2000', '3000'] });
      await emergencyRevert(opts);

      const rebalanceCall = vi.mocked(rebalanceBSKT).mock.calls[0][0];
      expect(rebalanceCall.amountIn).toEqual(['1000', '2000', '3000']);
    });
  });

  describe('validation', () => {
    it('should throw when snapshot has no tokens', async () => {
      const opts = makeRevertOpts({
        snapshot: { tokens: [], weights: [] },
      });

      await expect(emergencyRevert(opts)).rejects.toThrow('snapshot has no tokens');
      expect(rebalanceBSKT).not.toHaveBeenCalled();
    });

    it('should throw when snapshot is null-ish', async () => {
      const opts = makeRevertOpts({
        snapshot: null as any,
      });

      await expect(emergencyRevert(opts)).rejects.toThrow('snapshot has no tokens');
      expect(rebalanceBSKT).not.toHaveBeenCalled();
    });

    it('should throw when snapshot tokens/weights length mismatch', async () => {
      const opts = makeRevertOpts({
        snapshot: {
          tokens: [TOKEN_ALVA, TOKEN_WETH] as Address[],
          weights: [500n], // mismatch — 2 tokens but 1 weight
        },
      });

      await expect(emergencyRevert(opts)).rejects.toThrow('length mismatch');
      expect(rebalanceBSKT).not.toHaveBeenCalled();
    });
  });

  describe('dry run', () => {
    it('should propagate dryRun to rebalanceBSKT', async () => {
      vi.mocked(rebalanceBSKT).mockResolvedValue(mockDryRunResult() as any);

      const opts = makeRevertOpts({ dryRun: true });
      const result = await emergencyRevert(opts);

      const rebalanceCall = vi.mocked(rebalanceBSKT).mock.calls[0][0];
      expect(rebalanceCall.dryRun).toBe(true);

      expect(result.txHash).toBeNull();
    });
  });

  describe('error propagation', () => {
    it('should surface rebalanceBSKT failure on revert', async () => {
      vi.mocked(rebalanceBSKT).mockRejectedValue(
        new Error('rebalance() transaction reverted: 0xdead'),
      );

      const opts = makeRevertOpts();
      await expect(emergencyRevert(opts)).rejects.toThrow('transaction reverted');
    });
  });
});

/**
 * Unit tests for the DivestmentRegistry TypeScript client.
 *
 * Mocks viem contract calls and fs (ABI loading) — no real network or chain calls.
 * Tests: fundIdToBytes32, encode/decodeTriggerParams, registerConfig, getConfig.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type Address, type Hex, keccak256, toHex } from 'viem';

// ── Mock fs for ABI loading ─────────────────────────────────────────────

const MOCK_ABI = [
  {
    type: 'function',
    name: 'registerConfig',
    inputs: [
      { name: 'fundId', type: 'bytes32' },
      { name: 'holderSplitBps', type: 'uint16' },
      { name: 'ownerSplitBps', type: 'uint16' },
      { name: 'triggerType', type: 'uint8' },
      { name: 'triggerParams', type: 'bytes' },
      { name: 'distributionCurrency', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getConfig',
    inputs: [{ name: 'fundId', type: 'bytes32' }],
    outputs: [
      {
        name: 'config',
        type: 'tuple',
        components: [
          { name: 'holderSplitBps', type: 'uint16' },
          { name: 'ownerSplitBps', type: 'uint16' },
          { name: 'triggerType', type: 'uint8' },
          { name: 'triggerParams', type: 'bytes' },
          { name: 'distributionCurrency', type: 'address' },
          { name: 'creator', type: 'address' },
          { name: 'registeredAt', type: 'uint64' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'registered',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
];

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn((path: string, encoding?: string) => {
      if (typeof path === 'string' && path.includes('divestment-registry-abi.json')) {
        return JSON.stringify(MOCK_ABI);
      }
      return actual.readFileSync(path, encoding as any);
    }),
  };
});

// ── Imports (after mocks) ───────────────────────────────────────────────

import {
  fundIdToBytes32,
  encodeTriggerParams,
  decodeTriggerParams,
  registerConfig,
  getConfig,
} from '../src/registry/client.js';
import { TriggerType } from '../src/registry/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────

const TEST_UUID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_UUID_2 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TEST_REGISTRY: Address = '0x1234567890abcdef1234567890abcdef12345678';
const TEST_USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TEST_CREATOR: Address = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function makeMockWalletClient(txHash: Hex = '0xabc123') {
  return {
    writeContract: vi.fn().mockResolvedValue(txHash),
    chain: { id: 8453 },
    account: { address: TEST_CREATOR },
  } as any;
}

function makeMockPublicClient(overrides: {
  registered?: boolean;
  config?: any;
  receiptStatus?: 'success' | 'reverted';
} = {}) {
  const { registered = true, config, receiptStatus = 'success' } = overrides;

  const defaultConfig = {
    holderSplitBps: 7000,
    ownerSplitBps: 3000,
    triggerType: 0,
    triggerParams: '0x' as Hex,
    distributionCurrency: TEST_USDC,
    creator: TEST_CREATOR,
    registeredAt: 1700000000n,
  };

  return {
    readContract: vi.fn().mockImplementation(({ functionName }: any) => {
      if (functionName === 'registered') return Promise.resolve(registered);
      if (functionName === 'getConfig') return Promise.resolve(config ?? defaultConfig);
      return Promise.resolve(null);
    }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: receiptStatus,
      gasUsed: 150_000n,
      blockNumber: 12345n,
    }),
  } as any;
}

// Suppress structured log output during tests
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('fundIdToBytes32', () => {
  it('produces deterministic bytes32 for a known UUID', () => {
    const result1 = fundIdToBytes32(TEST_UUID);
    const result2 = fundIdToBytes32(TEST_UUID);
    expect(result1).toBe(result2);
    expect(result1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('matches manual keccak256(toHex(uuid))', () => {
    const expected = keccak256(toHex(TEST_UUID));
    expect(fundIdToBytes32(TEST_UUID)).toBe(expected);
  });

  it('produces different bytes32 for different UUIDs', () => {
    const a = fundIdToBytes32(TEST_UUID);
    const b = fundIdToBytes32(TEST_UUID_2);
    expect(a).not.toBe(b);
  });
});

describe('encodeTriggerParams / decodeTriggerParams', () => {
  it('roundtrips Time trigger params', () => {
    const original = { timeMs: 1700000000000 };
    const encoded = encodeTriggerParams(TriggerType.Time, original);
    const decoded = decodeTriggerParams(TriggerType.Time, encoded);
    expect(decoded.timeMs).toBe(BigInt(original.timeMs));
  });

  it('roundtrips Threshold trigger params', () => {
    const original = { thresholdUsd: 50000 };
    const encoded = encodeTriggerParams(TriggerType.Threshold, original);
    const decoded = decodeTriggerParams(TriggerType.Threshold, encoded);
    expect(decoded.thresholdUsd).toBe(BigInt(original.thresholdUsd));
  });

  it('roundtrips Both trigger params', () => {
    const original = { timeMs: 1700000000000, thresholdUsd: 50000 };
    const encoded = encodeTriggerParams(TriggerType.Both, original);
    const decoded = decodeTriggerParams(TriggerType.Both, encoded);
    expect(decoded.timeMs).toBe(BigInt(original.timeMs));
    expect(decoded.thresholdUsd).toBe(BigInt(original.thresholdUsd));
  });

  it('throws on unknown trigger type for encode', () => {
    expect(() => encodeTriggerParams(99 as TriggerType, {})).toThrow('Unknown trigger type');
  });

  it('throws on unknown trigger type for decode', () => {
    expect(() => decodeTriggerParams(99, '0x' as Hex)).toThrow('Unknown trigger type');
  });
});

describe('registerConfig', () => {
  it('calls writeContract with correct args and returns txHash + gasUsed', async () => {
    const txHash = '0x1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd' as Hex;
    const walletClient = makeMockWalletClient(txHash);
    const publicClient = makeMockPublicClient();

    const triggerParams = encodeTriggerParams(TriggerType.Time, { timeMs: 1700000000000 });

    const result = await registerConfig(walletClient, publicClient, TEST_REGISTRY, {
      fundId: TEST_UUID,
      holderSplitBps: 7000,
      ownerSplitBps: 3000,
      triggerType: TriggerType.Time,
      triggerParams,
      distributionCurrency: TEST_USDC,
    });

    expect(result.txHash).toBe(txHash);
    expect(result.gasUsed).toBe(150_000n);

    // Verify writeContract was called with correct args
    expect(walletClient.writeContract).toHaveBeenCalledOnce();
    const call = walletClient.writeContract.mock.calls[0][0];
    expect(call.address).toBe(TEST_REGISTRY);
    expect(call.functionName).toBe('registerConfig');
    expect(call.args[0]).toBe(fundIdToBytes32(TEST_UUID)); // fundId key
    expect(call.args[1]).toBe(7000); // holderSplitBps
    expect(call.args[2]).toBe(3000); // ownerSplitBps
    expect(call.args[3]).toBe(TriggerType.Time); // triggerType
    expect(call.args[4]).toBe(triggerParams); // encoded trigger params
    expect(call.args[5]).toBe(TEST_USDC); // distributionCurrency
  });

  it('throws when transaction reverts', async () => {
    const walletClient = makeMockWalletClient();
    const publicClient = makeMockPublicClient({ receiptStatus: 'reverted' });

    const triggerParams = encodeTriggerParams(TriggerType.Threshold, { thresholdUsd: 50000 });

    await expect(
      registerConfig(walletClient, publicClient, TEST_REGISTRY, {
        fundId: TEST_UUID,
        holderSplitBps: 7000,
        ownerSplitBps: 3000,
        triggerType: TriggerType.Threshold,
        triggerParams,
        distributionCurrency: TEST_USDC,
      }),
    ).rejects.toThrow('registerConfig() transaction reverted');
  });

  it('waits for transaction receipt with 60s timeout', async () => {
    const walletClient = makeMockWalletClient();
    const publicClient = makeMockPublicClient();

    const triggerParams = encodeTriggerParams(TriggerType.Time, { timeMs: 1700000000000 });

    await registerConfig(walletClient, publicClient, TEST_REGISTRY, {
      fundId: TEST_UUID,
      holderSplitBps: 7000,
      ownerSplitBps: 3000,
      triggerType: TriggerType.Time,
      triggerParams,
      distributionCurrency: TEST_USDC,
    });

    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: expect.any(String),
      timeout: 60_000,
    });
  });
});

describe('getConfig', () => {
  it('returns config for a registered fund', async () => {
    const publicClient = makeMockPublicClient({ registered: true });

    const result = await getConfig(publicClient, TEST_REGISTRY, TEST_UUID);

    expect(result).not.toBeNull();
    expect(result!.holderSplitBps).toBe(7000);
    expect(result!.ownerSplitBps).toBe(3000);
    expect(result!.triggerType).toBe(0);
    expect(result!.distributionCurrency).toBe(TEST_USDC);
    expect(result!.creator).toBe(TEST_CREATOR);
    expect(result!.registeredAt).toBe(1700000000n);
  });

  it('returns null for unregistered fund', async () => {
    const publicClient = makeMockPublicClient({ registered: false });

    const result = await getConfig(publicClient, TEST_REGISTRY, TEST_UUID);

    expect(result).toBeNull();
    // Should have called registered() but NOT getConfig()
    expect(publicClient.readContract).toHaveBeenCalledOnce();
  });

  it('calls readContract with correct fundId key', async () => {
    const publicClient = makeMockPublicClient({ registered: true });

    await getConfig(publicClient, TEST_REGISTRY, TEST_UUID);

    const expectedKey = fundIdToBytes32(TEST_UUID);
    // First call is registered(), second is getConfig()
    const registeredCall = publicClient.readContract.mock.calls[0][0];
    expect(registeredCall.functionName).toBe('registered');
    expect(registeredCall.args[0]).toBe(expectedKey);

    const getConfigCall = publicClient.readContract.mock.calls[1][0];
    expect(getConfigCall.functionName).toBe('getConfig');
    expect(getConfigCall.args[0]).toBe(expectedKey);
  });
});

describe('client-side validation', () => {
  it('InvalidSplitBps: contract enforces holderSplitBps + ownerSplitBps == 10000', () => {
    // This is enforced on-chain, not in the client.
    // Verify the ABI includes the InvalidSplitBps error so the client can decode reverts.
    const fullAbi = JSON.parse(
      require('fs').readFileSync(
        require('path').resolve(__dirname, '../src/config/divestment-registry-abi.json'),
        'utf-8',
      ),
    );
    const invalidSplitError = fullAbi.find(
      (item: any) => item.type === 'error' && item.name === 'InvalidSplitBps',
    );
    expect(invalidSplitError).toBeDefined();
    expect(invalidSplitError.inputs).toHaveLength(2);
  });
});

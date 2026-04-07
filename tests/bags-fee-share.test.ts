/**
 * Unit tests for fee-share and fee-claim modules.
 * SDK services are mocked — no real Solana connections or API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Connection, Keypair, MessageV0, PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  getAdminTokenList,
  getClaimablePositions,
  buildUpdateConfigTransaction,
} from '../src/bags/fee-share.js';
import {
  getClaimTransactions,
  signAndSendClaimTransactions,
} from '../src/bags/fee-claim.js';
import type { BagsSDK } from '@bagsfm/bags-sdk';

// Suppress structured log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

// -------------------------------------------------------------------
// Test fixtures
// -------------------------------------------------------------------

/** Valid base58 wallet (44-char Ed25519 pubkey) */
const VALID_WALLET = '11111111111111111111111111111111';
const VALID_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const VALID_PAYER = '5ZWj7a1f8tWkjBESHKgrLmXGcFP9WLXAR4P9qBTa3Jn2';

function createMockSdk(overrides: Partial<{
  getAdminTokenMints: ReturnType<typeof vi.fn>;
  getAllClaimablePositions: ReturnType<typeof vi.fn>;
  getUpdateConfigTransactions: ReturnType<typeof vi.fn>;
  getClaimTransactions: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    feeShareAdmin: {
      getAdminTokenMints: overrides.getAdminTokenMints ?? vi.fn().mockResolvedValue([]),
      getUpdateConfigTransactions: overrides.getUpdateConfigTransactions ?? vi.fn().mockResolvedValue([]),
      getTransferAdminTransaction: vi.fn(),
      getUpdateConfigLookupTableTransactions: vi.fn(),
    },
    fee: {
      getAllClaimablePositions: overrides.getAllClaimablePositions ?? vi.fn().mockResolvedValue([]),
      getClaimTransactions: overrides.getClaimTransactions ?? vi.fn().mockResolvedValue([]),
    },
  } as unknown as BagsSDK;
}

// -------------------------------------------------------------------
// getAdminTokenList
// -------------------------------------------------------------------

describe('getAdminTokenList', () => {
  it('returns mint array on success', async () => {
    const sdk = createMockSdk({
      getAdminTokenMints: vi.fn().mockResolvedValue([VALID_MINT, 'mint2abc']),
    });

    const result = await getAdminTokenList(sdk, VALID_WALLET);
    expect(result).toEqual([VALID_MINT, 'mint2abc']);
    expect(sdk.feeShareAdmin.getAdminTokenMints).toHaveBeenCalledOnce();
  });

  it('returns empty array when wallet admins nothing', async () => {
    const sdk = createMockSdk({
      getAdminTokenMints: vi.fn().mockResolvedValue([]),
    });

    const result = await getAdminTokenList(sdk, VALID_WALLET);
    expect(result).toEqual([]);
  });

  it('throws on empty wallet', async () => {
    const sdk = createMockSdk();
    await expect(getAdminTokenList(sdk, '')).rejects.toThrow(
      /wallet address is required/
    );
  });

  it('throws on invalid wallet format', async () => {
    const sdk = createMockSdk();
    await expect(getAdminTokenList(sdk, 'not-base58!!')).rejects.toThrow(
      /invalid wallet address format/
    );
  });

  it('wraps SDK errors with context', async () => {
    const sdk = createMockSdk({
      getAdminTokenMints: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    await expect(getAdminTokenList(sdk, VALID_WALLET)).rejects.toThrow(
      /getAdminTokenList failed.*Network error/
    );
  });
});

// -------------------------------------------------------------------
// getClaimablePositions
// -------------------------------------------------------------------

describe('getClaimablePositions', () => {
  it('returns positions array on success', async () => {
    const mockPositions = [
      { baseMint: VALID_MINT, totalClaimableLamportsUserShare: 1000, isCustomFeeVault: false },
    ];
    const sdk = createMockSdk({
      getAllClaimablePositions: vi.fn().mockResolvedValue(mockPositions),
    });

    const result = await getClaimablePositions(sdk, VALID_WALLET);
    expect(result).toEqual(mockPositions);
    expect(result).toHaveLength(1);
  });

  it('returns empty array when no positions', async () => {
    const sdk = createMockSdk({
      getAllClaimablePositions: vi.fn().mockResolvedValue([]),
    });

    const result = await getClaimablePositions(sdk, VALID_WALLET);
    expect(result).toEqual([]);
  });

  it('throws on empty wallet', async () => {
    const sdk = createMockSdk();
    await expect(getClaimablePositions(sdk, '')).rejects.toThrow(
      /wallet address is required/
    );
  });

  it('wraps SDK errors with wallet context', async () => {
    const sdk = createMockSdk({
      getAllClaimablePositions: vi
        .fn()
        .mockRejectedValue(new Error('RPC timeout')),
    });

    await expect(
      getClaimablePositions(sdk, VALID_WALLET)
    ).rejects.toThrow(/getClaimablePositions failed.*RPC timeout/);
  });
});

// -------------------------------------------------------------------
// buildUpdateConfigTransaction
// -------------------------------------------------------------------

describe('buildUpdateConfigTransaction', () => {
  const validConfig = {
    baseMint: VALID_MINT,
    claimersArray: [VALID_WALLET, VALID_PAYER],
    basisPointsArray: [7000, 3000],
    payer: VALID_PAYER,
  };

  it('returns transactions on success', async () => {
    const mockResult = [{ transaction: {}, blockhash: {} }];
    const sdk = createMockSdk({
      getUpdateConfigTransactions: vi.fn().mockResolvedValue(mockResult),
    });

    const result = await buildUpdateConfigTransaction(sdk, validConfig);
    expect(result).toEqual(mockResult);
    expect(sdk.feeShareAdmin.getUpdateConfigTransactions).toHaveBeenCalledOnce();
  });

  it('passes PublicKey objects to SDK', async () => {
    const sdk = createMockSdk({
      getUpdateConfigTransactions: vi.fn().mockResolvedValue([]),
    });

    await buildUpdateConfigTransaction(sdk, validConfig);

    const callArgs = (sdk.feeShareAdmin.getUpdateConfigTransactions as any).mock.calls[0][0];
    expect(callArgs.baseMint).toBeInstanceOf(PublicKey);
    expect(callArgs.payer).toBeInstanceOf(PublicKey);
    expect(callArgs.feeClaimers[0].user).toBeInstanceOf(PublicKey);
    expect(callArgs.feeClaimers[0].userBps).toBe(7000);
  });

  it('throws when basisPointsArray does not sum to 10000', async () => {
    const sdk = createMockSdk();
    const config = { ...validConfig, basisPointsArray: [5000, 3000] };

    await expect(
      buildUpdateConfigTransaction(sdk, config)
    ).rejects.toThrow(/must sum to 10000, got 8000/);

    // Verify SDK was NOT called — validation is client-side
    expect(
      sdk.feeShareAdmin.getUpdateConfigTransactions
    ).not.toHaveBeenCalled();
  });

  it('throws on empty claimersArray', async () => {
    const sdk = createMockSdk();
    const config = { ...validConfig, claimersArray: [], basisPointsArray: [] };

    await expect(
      buildUpdateConfigTransaction(sdk, config)
    ).rejects.toThrow(/claimersArray must not be empty/);
  });

  it('throws when claimersArray/basisPointsArray length mismatch', async () => {
    const sdk = createMockSdk();
    const config = {
      ...validConfig,
      claimersArray: [VALID_WALLET],
      basisPointsArray: [5000, 5000],
    };

    await expect(
      buildUpdateConfigTransaction(sdk, config)
    ).rejects.toThrow(/length.*must match/);
  });

  it('throws on invalid baseMint', async () => {
    const sdk = createMockSdk();
    const config = { ...validConfig, baseMint: '' };

    await expect(
      buildUpdateConfigTransaction(sdk, config)
    ).rejects.toThrow(/token mint address is required/);
  });

  it('throws on invalid payer', async () => {
    const sdk = createMockSdk();
    const config = { ...validConfig, payer: 'bad!address' };

    await expect(
      buildUpdateConfigTransaction(sdk, config)
    ).rejects.toThrow(/invalid wallet address format/);
  });

  it('throws on invalid claimer address', async () => {
    const sdk = createMockSdk();
    const config = {
      ...validConfig,
      claimersArray: ['invalid!!', VALID_PAYER],
    };

    await expect(
      buildUpdateConfigTransaction(sdk, config)
    ).rejects.toThrow(/invalid wallet address format/);
  });

  it('passes additionalLookupTables as PublicKeys when provided', async () => {
    const sdk = createMockSdk({
      getUpdateConfigTransactions: vi.fn().mockResolvedValue([]),
    });

    const config = {
      ...validConfig,
      additionalLookupTables: [VALID_WALLET],
    };
    await buildUpdateConfigTransaction(sdk, config);

    const callArgs = (sdk.feeShareAdmin.getUpdateConfigTransactions as any).mock.calls[0][0];
    expect(callArgs.additionalLookupTables).toHaveLength(1);
    expect(callArgs.additionalLookupTables[0]).toBeInstanceOf(PublicKey);
  });

  it('wraps SDK errors with context', async () => {
    const sdk = createMockSdk({
      getUpdateConfigTransactions: vi
        .fn()
        .mockRejectedValue(new Error('Insufficient SOL')),
    });

    await expect(
      buildUpdateConfigTransaction(sdk, validConfig)
    ).rejects.toThrow(/buildUpdateConfigTransaction failed.*Insufficient SOL/);
  });
});

// -------------------------------------------------------------------
// getClaimTransactions
// -------------------------------------------------------------------

describe('getClaimTransactions', () => {
  it('returns transactions on success', async () => {
    const mockTxs = [{ serialize: () => Buffer.alloc(10) }];
    const sdk = createMockSdk({
      getClaimTransactions: vi.fn().mockResolvedValue(mockTxs),
    });

    const result = await getClaimTransactions(sdk, VALID_WALLET, VALID_MINT);
    expect(result).toEqual(mockTxs);
    expect(sdk.fee.getClaimTransactions).toHaveBeenCalledOnce();
  });

  it('returns empty array when no claims', async () => {
    const sdk = createMockSdk({
      getClaimTransactions: vi.fn().mockResolvedValue([]),
    });

    const result = await getClaimTransactions(sdk, VALID_WALLET, VALID_MINT);
    expect(result).toEqual([]);
  });

  it('throws on empty wallet', async () => {
    const sdk = createMockSdk();
    await expect(
      getClaimTransactions(sdk, '', VALID_MINT)
    ).rejects.toThrow(/wallet address is required/);
  });

  it('throws on empty token mint', async () => {
    const sdk = createMockSdk();
    await expect(
      getClaimTransactions(sdk, VALID_WALLET, '')
    ).rejects.toThrow(/token mint address is required/);
  });

  it('throws on invalid wallet format', async () => {
    const sdk = createMockSdk();
    await expect(
      getClaimTransactions(sdk, '0xInvalidEth', VALID_MINT)
    ).rejects.toThrow(/invalid wallet address format/);
  });

  it('wraps SDK errors with wallet + mint context', async () => {
    const sdk = createMockSdk({
      getClaimTransactions: vi
        .fn()
        .mockRejectedValue(new Error('position not found')),
    });

    await expect(
      getClaimTransactions(sdk, VALID_WALLET, VALID_MINT)
    ).rejects.toThrow(/getClaimTransactions failed.*position not found/);
  });
});

// -------------------------------------------------------------------
// signAndSendClaimTransactions
// -------------------------------------------------------------------

describe('signAndSendClaimTransactions', () => {
  let mockConnection: Connection;
  let testKeypair: Keypair;

  beforeEach(() => {
    testKeypair = Keypair.generate();

    mockConnection = {
      sendRawTransaction: vi.fn().mockResolvedValue('mockSignature123'),
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: 'mockBlockhash',
        lastValidBlockHeight: 999999,
      }),
      confirmTransaction: vi.fn().mockResolvedValue({
        value: { err: null },
      }),
    } as unknown as Connection;
  });

  it('returns empty array for empty input', async () => {
    const result = await signAndSendClaimTransactions(
      mockConnection,
      testKeypair,
      []
    );
    expect(result).toEqual([]);
  });

  /** Helper: build a minimal valid base64-encoded VersionedMessage */
  function buildSerializedMessage(payer: Keypair): string {
    const msg = MessageV0.compile({
      payerKey: payer.publicKey,
      instructions: [],
      recentBlockhash: '11111111111111111111111111111111',
      addressTableLookups: [],
    });
    return Buffer.from(msg.serialize()).toString('base64');
  }

  it('signs, sends, and confirms a transaction', async () => {
    const serialized = buildSerializedMessage(testKeypair);

    const result = await signAndSendClaimTransactions(
      mockConnection,
      testKeypair,
      [serialized]
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toBe('mockSignature123');
    expect(mockConnection.sendRawTransaction).toHaveBeenCalledOnce();
    expect(mockConnection.confirmTransaction).toHaveBeenCalledOnce();
  });

  it('throws when on-chain confirmation has error', async () => {
    (mockConnection.confirmTransaction as any).mockResolvedValueOnce({
      value: { err: { InstructionError: [0, 'Custom'] } },
    });

    const serialized = buildSerializedMessage(testKeypair);

    await expect(
      signAndSendClaimTransactions(mockConnection, testKeypair, [serialized])
    ).rejects.toThrow(/Transaction 0 failed on-chain/);
  });
});

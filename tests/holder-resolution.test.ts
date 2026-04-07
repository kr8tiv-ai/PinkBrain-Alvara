/**
 * Unit tests for SPL token holder resolution.
 * All RPC calls are mocked — no real network requests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  resolveHoldersViaProgramAccounts,
  resolveHoldersViaHelius,
  getTopHolders,
  isHeliusRpc,
  validateMint,
  validateCount,
} from '../src/holders/resolve.js';

// Suppress structured log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockedFetch(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as ReturnType<typeof vi.fn>;
}

/**
 * Build a 165-byte SPL Token account buffer with given mint, owner, and amount.
 */
function buildTokenAccountBuffer(
  mintPubkey: PublicKey,
  ownerPubkey: PublicKey,
  amount: bigint,
): Buffer {
  const buf = Buffer.alloc(165);
  // Mint at offset 0 (32 bytes)
  mintPubkey.toBuffer().copy(buf, 0);
  // Owner at offset 32 (32 bytes)
  ownerPubkey.toBuffer().copy(buf, 32);
  // Amount at offset 64 (8 bytes, u64 LE)
  buf.writeBigUInt64LE(amount, 64);
  return buf;
}

/** Create a mock Connection that returns given accounts from getProgramAccounts */
function mockConnection(
  accounts: { pubkey: PublicKey; account: { data: Buffer; executable: boolean; lamports: number; owner: PublicKey } }[],
  rpcUrl = 'https://api.mainnet-beta.solana.com',
): Connection {
  const conn = new Connection(rpcUrl);
  vi.spyOn(conn, 'getProgramAccounts').mockResolvedValue(
    accounts.map(a => ({
      pubkey: a.pubkey,
      account: {
        data: a.account.data,
        executable: a.account.executable,
        lamports: a.account.lamports,
        owner: a.account.owner,
      },
    })),
  );
  return conn;
}

/** Generate a deterministic keypair for testing */
function testOwner(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  bytes[31] = 1; // Ensure it's on the curve-ish for PublicKey
  return new PublicKey(bytes);
}

/** Helper to build account entries for mockConnection */
function makeAccount(mint: PublicKey, owner: PublicKey, amount: bigint) {
  return {
    pubkey: PublicKey.unique(),
    account: {
      data: buildTokenAccountBuffer(mint, owner, amount),
      executable: false,
      lamports: 2_039_280,
      owner: new PublicKey(SPL_TOKEN_PROGRAM),
    },
  };
}

// ---------------------------------------------------------------------------
// isHeliusRpc detection
// ---------------------------------------------------------------------------

describe('isHeliusRpc', () => {
  it('detects helius.dev URL', () => {
    expect(isHeliusRpc('https://mainnet.helius-rpc.com/?api-key=abc123')).toBe(true);
  });

  it('detects helius in subdomain', () => {
    expect(isHeliusRpc('https://rpc.helius.xyz/?api-key=abc')).toBe(true);
  });

  it('rejects non-helius URL', () => {
    expect(isHeliusRpc('https://api.mainnet-beta.solana.com')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isHeliusRpc('')).toBe(false);
  });

  it('case insensitive', () => {
    expect(isHeliusRpc('https://HELIUS-RPC.COM/abc')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('validateMint', () => {
  it('accepts valid USDC mint', () => {
    expect(() => validateMint(USDC_MINT)).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => validateMint('')).toThrow('mint address is required');
  });

  it('rejects whitespace-only string', () => {
    expect(() => validateMint('   ')).toThrow('mint address is required');
  });

  it('rejects too-short address', () => {
    expect(() => validateMint('abc123')).toThrow('32-44 characters');
  });

  it('rejects too-long address', () => {
    expect(() => validateMint('A'.repeat(50))).toThrow('32-44 characters');
  });

  it('rejects invalid base58 characters', () => {
    // 0, O, I, l are not in base58
    expect(() => validateMint('0' + 'A'.repeat(35))).toThrow('invalid base58');
  });
});

describe('validateCount', () => {
  it('accepts count of 1', () => {
    expect(() => validateCount(1)).not.toThrow();
  });

  it('accepts count of 10000', () => {
    expect(() => validateCount(10_000)).not.toThrow();
  });

  it('rejects count of 0', () => {
    expect(() => validateCount(0)).toThrow('count must be >= 1');
  });

  it('rejects negative count', () => {
    expect(() => validateCount(-5)).toThrow('count must be >= 1');
  });

  it('rejects count > 10000', () => {
    expect(() => validateCount(10_001)).toThrow('count must be <= 10000');
  });

  it('rejects NaN', () => {
    expect(() => validateCount(NaN)).toThrow('count must be >= 1');
  });

  it('rejects Infinity', () => {
    expect(() => validateCount(Infinity)).toThrow('count must be >= 1');
  });
});

// ---------------------------------------------------------------------------
// resolveHoldersViaProgramAccounts
// ---------------------------------------------------------------------------

describe('resolveHoldersViaProgramAccounts', () => {
  const mintPk = new PublicKey(USDC_MINT);
  const owner1 = testOwner(1);
  const owner2 = testOwner(2);
  const owner3 = testOwner(3);

  it('parses account data correctly and sorts descending', async () => {
    const conn = mockConnection([
      makeAccount(mintPk, owner1, 1000n),
      makeAccount(mintPk, owner2, 5000n),
      makeAccount(mintPk, owner3, 3000n),
    ]);

    const result = await resolveHoldersViaProgramAccounts(conn, USDC_MINT, 10);

    expect(result.strategy).toBe('getProgramAccounts');
    expect(result.mint).toBe(USDC_MINT);
    expect(result.holders).toHaveLength(3);

    // Descending order
    expect(result.holders[0].amount).toBe(5000n);
    expect(result.holders[0].owner).toBe(owner2.toBase58());
    expect(result.holders[1].amount).toBe(3000n);
    expect(result.holders[2].amount).toBe(1000n);
  });

  it('calculates percentage shares that sum to ~100%', async () => {
    const conn = mockConnection([
      makeAccount(mintPk, owner1, 500n),
      makeAccount(mintPk, owner2, 300n),
      makeAccount(mintPk, owner3, 200n),
    ]);

    const result = await resolveHoldersViaProgramAccounts(conn, USDC_MINT, 10);

    // 500/1000 = 50%, 300/1000 = 30%, 200/1000 = 20%
    expect(result.holders[0].percentage).toBeCloseTo(50, 0);
    expect(result.holders[1].percentage).toBeCloseTo(30, 0);
    expect(result.holders[2].percentage).toBeCloseTo(20, 0);

    const totalPct = result.holders.reduce((s, h) => s + h.percentage, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });

  it('filters zero-balance accounts', async () => {
    const conn = mockConnection([
      makeAccount(mintPk, owner1, 1000n),
      makeAccount(mintPk, owner2, 0n),  // zero balance
      makeAccount(mintPk, owner3, 500n),
    ]);

    const result = await resolveHoldersViaProgramAccounts(conn, USDC_MINT, 10);
    expect(result.holders).toHaveLength(2);
    expect(result.holders.every(h => h.amount > 0n)).toBe(true);
  });

  it('limits to requested count', async () => {
    const accounts = [];
    for (let i = 1; i <= 10; i++) {
      accounts.push(makeAccount(mintPk, testOwner(i), BigInt(i * 100)));
    }
    const conn = mockConnection(accounts);

    const result = await resolveHoldersViaProgramAccounts(conn, USDC_MINT, 5);
    expect(result.holders).toHaveLength(5);
    // Top 5 should be amounts 1000, 900, 800, 700, 600
    expect(result.holders[0].amount).toBe(1000n);
    expect(result.holders[4].amount).toBe(600n);
  });

  it('handles token with 0 holders', async () => {
    const conn = mockConnection([]);

    const result = await resolveHoldersViaProgramAccounts(conn, USDC_MINT, 10);
    expect(result.holders).toHaveLength(0);
    expect(result.totalSupplyHeld).toBe(0n);
  });

  it('handles fewer holders than requested count', async () => {
    const conn = mockConnection([
      makeAccount(mintPk, owner1, 1000n),
      makeAccount(mintPk, owner2, 500n),
    ]);

    const result = await resolveHoldersViaProgramAccounts(conn, USDC_MINT, 100);
    expect(result.holders).toHaveLength(2);
  });

  it('count=1 returns only top holder', async () => {
    const conn = mockConnection([
      makeAccount(mintPk, owner1, 100n),
      makeAccount(mintPk, owner2, 5000n),
    ]);

    const result = await resolveHoldersViaProgramAccounts(conn, USDC_MINT, 1);
    expect(result.holders).toHaveLength(1);
    expect(result.holders[0].amount).toBe(5000n);
  });

  it('skips malformed accounts (< 165 bytes) with warning', async () => {
    const shortBuf = Buffer.alloc(100); // Too short
    const conn = new Connection('https://api.mainnet-beta.solana.com');
    vi.spyOn(conn, 'getProgramAccounts').mockResolvedValue([
      {
        pubkey: PublicKey.unique(),
        account: {
          data: shortBuf,
          executable: false,
          lamports: 0,
          owner: new PublicKey(SPL_TOKEN_PROGRAM),
        },
      },
      makeAccount(mintPk, owner1, 1000n),
    ]);

    const result = await resolveHoldersViaProgramAccounts(conn, USDC_MINT, 10);
    expect(result.holders).toHaveLength(1);
    expect(result.holders[0].amount).toBe(1000n);
  });

  it('propagates RPC errors', async () => {
    const conn = new Connection('https://api.mainnet-beta.solana.com');
    vi.spyOn(conn, 'getProgramAccounts').mockRejectedValue(
      new Error('403 Forbidden — getProgramAccounts disabled'),
    );

    await expect(
      resolveHoldersViaProgramAccounts(conn, USDC_MINT, 10),
    ).rejects.toThrow('getProgramAccounts disabled');
  });
});

// ---------------------------------------------------------------------------
// resolveHoldersViaHelius
// ---------------------------------------------------------------------------

describe('resolveHoldersViaHelius', () => {
  const heliusUrl = 'https://mainnet.helius-rpc.com/?api-key=test';

  function heliusResponse(accounts: { owner: string; amount: number }[], cursor?: string) {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'holders-0',
        result: {
          token_accounts: accounts,
          ...(cursor ? { cursor } : {}),
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  it('parses Helius response and sorts descending', async () => {
    mockedFetch().mockResolvedValueOnce(
      heliusResponse([
        { owner: 'OwnerA11111111111111111111111111111111111111', amount: 500 },
        { owner: 'OwnerB11111111111111111111111111111111111111', amount: 2000 },
        { owner: 'OwnerC11111111111111111111111111111111111111', amount: 100 },
      ]),
    );

    const result = await resolveHoldersViaHelius(heliusUrl, USDC_MINT, 10);

    expect(result.strategy).toBe('helius-das');
    expect(result.holders).toHaveLength(3);
    expect(result.holders[0].amount).toBe(2000n);
    expect(result.holders[1].amount).toBe(500n);
    expect(result.holders[2].amount).toBe(100n);
  });

  it('filters zero-balance accounts', async () => {
    mockedFetch().mockResolvedValueOnce(
      heliusResponse([
        { owner: 'OwnerA11111111111111111111111111111111111111', amount: 1000 },
        { owner: 'OwnerB11111111111111111111111111111111111111', amount: 0 },
      ]),
    );

    const result = await resolveHoldersViaHelius(heliusUrl, USDC_MINT, 10);
    expect(result.holders).toHaveLength(1);
  });

  it('throws on HTTP error', async () => {
    mockedFetch().mockResolvedValueOnce(
      new Response('Rate limit exceeded', { status: 429 }),
    );

    await expect(
      resolveHoldersViaHelius(heliusUrl, USDC_MINT, 10),
    ).rejects.toThrow('HTTP 429');
  });

  it('throws on DAS error response', async () => {
    mockedFetch().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', error: { message: 'Invalid mint' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      resolveHoldersViaHelius(heliusUrl, USDC_MINT, 10),
    ).rejects.toThrow('Invalid mint');
  });

  it('throws on malformed response (missing token_accounts)', async () => {
    mockedFetch().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      resolveHoldersViaHelius(heliusUrl, USDC_MINT, 10),
    ).rejects.toThrow('missing token_accounts');
  });

  it('paginates with cursor', async () => {
    // count=1000 → maxPages = ceil(min(2000,10000)/1000) = 2
    // Page 1: 1000 accounts with a cursor
    const page1Accounts = Array.from({ length: 1000 }, (_, i) => ({
      owner: `Owner${String(i).padStart(40, '1')}`,
      amount: 2000 - i,
    }));
    // Page 2: 50 accounts, no cursor (last page)
    const page2Accounts = Array.from({ length: 50 }, (_, i) => ({
      owner: `OwnerX${String(i).padStart(39, '1')}`,
      amount: 50 - i,
    }));

    mockedFetch()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            result: { token_accounts: page1Accounts, cursor: 'page2cursor' },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            result: { token_accounts: page2Accounts },
          }),
          { status: 200 },
        ),
      );

    const result = await resolveHoldersViaHelius(heliusUrl, USDC_MINT, 1000);
    // Should have fetched both pages
    expect(result.holders).toHaveLength(1000);
    expect(result.holders[0].amount).toBe(2000n);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// getTopHolders — integration of strategies + fallback
// ---------------------------------------------------------------------------

describe('getTopHolders', () => {
  it('rejects empty mint', async () => {
    await expect(getTopHolders('')).rejects.toThrow('mint address is required');
  });

  it('rejects invalid base58 mint', async () => {
    await expect(getTopHolders('0xNotBase58ButLongEnoughToPass12345678')).rejects.toThrow('invalid base58');
  });

  it('rejects count of 0', async () => {
    await expect(getTopHolders(USDC_MINT, 0)).rejects.toThrow('count must be >= 1');
  });

  it('rejects count > 10000', async () => {
    await expect(getTopHolders(USDC_MINT, 10_001)).rejects.toThrow('count must be <= 10000');
  });

  it('uses getProgramAccounts for non-Helius RPC', async () => {
    const mintPk = new PublicKey(USDC_MINT);
    const owner1 = testOwner(10);
    const conn = mockConnection(
      [makeAccount(mintPk, owner1, 999n)],
      'https://api.mainnet-beta.solana.com',
    );

    const result = await getTopHolders(USDC_MINT, 10, conn);
    expect(result.strategy).toBe('getProgramAccounts');
    expect(result.holders).toHaveLength(1);
  });

  it('falls back from Helius to getProgramAccounts on error', async () => {
    // Create a connection with Helius URL
    const conn = new Connection('https://mainnet.helius-rpc.com/?api-key=test');

    // Mock fetch to fail (Helius DAS)
    mockedFetch().mockRejectedValueOnce(new Error('Helius rate limited'));

    // Mock getProgramAccounts to succeed
    const mintPk = new PublicKey(USDC_MINT);
    const owner1 = testOwner(20);
    vi.spyOn(conn, 'getProgramAccounts').mockResolvedValue([
      {
        pubkey: PublicKey.unique(),
        account: {
          data: buildTokenAccountBuffer(mintPk, owner1, 500n),
          executable: false,
          lamports: 2_039_280,
          owner: new PublicKey(SPL_TOKEN_PROGRAM),
        },
      },
    ]);

    const result = await getTopHolders(USDC_MINT, 10, conn);
    expect(result.strategy).toBe('getProgramAccounts');
    expect(result.holders).toHaveLength(1);
    expect(result.holders[0].amount).toBe(500n);
  });

  it('uses Helius DAS when Helius RPC detected and succeeds', async () => {
    const conn = new Connection('https://mainnet.helius-rpc.com/?api-key=test');

    mockedFetch().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          result: {
            token_accounts: [
              { owner: 'OwnerA11111111111111111111111111111111111111', amount: 7777 },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await getTopHolders(USDC_MINT, 10, conn);
    expect(result.strategy).toBe('helius-das');
    expect(result.holders).toHaveLength(1);
    expect(result.holders[0].amount).toBe(7777n);
  });
});

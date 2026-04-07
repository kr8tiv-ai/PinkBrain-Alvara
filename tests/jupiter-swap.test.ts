/**
 * Unit tests for the Jupiter Ultra V3 swap client.
 * All fetch calls are mocked — no real network requests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, VersionedTransaction, MessageV0, PublicKey } from '@solana/web3.js';
import { getSwapOrder, executeSwap, swapSolToUsdc } from '../src/jupiter/swap.js';

// Suppress structured log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mocked(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as ReturnType<typeof vi.fn>;
}

/** Build a mock Response */
function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A valid Jupiter order response for testing */
function fakeOrderResponse(overrides?: Record<string, unknown>) {
  return {
    transaction: 'dGVzdC10cmFuc2FjdGlvbg==', // base64("test-transaction")
    requestId: 'req-abc-123',
    type: 'Ultra',
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    inAmount: '10000000',
    outAmount: '1500000',
    ...overrides,
  };
}

/** A valid Jupiter execute response for testing */
function fakeExecuteResponse(overrides?: Record<string, unknown>) {
  return {
    status: 'Success',
    signature: '5K8Fz...mockSig',
    ...overrides,
  };
}

// Stable test keypair (do not use in production)
const TEST_KEYPAIR = Keypair.generate();
const TEST_TAKER = TEST_KEYPAIR.publicKey.toBase58();

// -------------------------------------------------------------------
// getSwapOrder
// -------------------------------------------------------------------

describe('getSwapOrder', () => {
  it('builds correct URL with query params and parses response', async () => {
    mocked().mockResolvedValueOnce(mockResponse(fakeOrderResponse()));

    const result = await getSwapOrder(
      'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      10_000_000,
      TEST_TAKER
    );

    // Verify fetch was called correctly
    expect(mocked()).toHaveBeenCalledOnce();
    const [url, init] = mocked().mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('GET');

    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/ultra/v1/order');
    expect(parsed.searchParams.get('inputMint')).toBe('So11111111111111111111111111111111111111112');
    expect(parsed.searchParams.get('outputMint')).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(parsed.searchParams.get('amount')).toBe('10000000');
    expect(parsed.searchParams.get('taker')).toBe(TEST_TAKER);

    // Verify response mapping
    expect(result.transaction).toBe('dGVzdC10cmFuc2FjdGlvbg==');
    expect(result.requestId).toBe('req-abc-123');
    expect(result.type).toBe('Ultra');
    expect(result.inAmount).toBe('10000000');
    expect(result.outAmount).toBe('1500000');
  });

  // --- Negative: malformed inputs ---

  it('throws on zero amount', async () => {
    await expect(
      getSwapOrder('So111...', 'EPjF...', 0, TEST_TAKER)
    ).rejects.toThrow(/amount must be positive/);
  });

  it('throws on negative amount', async () => {
    await expect(
      getSwapOrder('So111...', 'EPjF...', -100, TEST_TAKER)
    ).rejects.toThrow(/amount must be positive/);
  });

  it('throws on empty inputMint', async () => {
    await expect(
      getSwapOrder('', 'EPjF...', 10_000_000, TEST_TAKER)
    ).rejects.toThrow(/inputMint is required/);
  });

  it('throws on empty outputMint', async () => {
    await expect(
      getSwapOrder('So111...', '', 10_000_000, TEST_TAKER)
    ).rejects.toThrow(/outputMint is required/);
  });

  it('throws on empty taker', async () => {
    await expect(
      getSwapOrder('So111...', 'EPjF...', 10_000_000, '')
    ).rejects.toThrow(/taker is required/);
  });

  it('throws on NaN amount', async () => {
    await expect(
      getSwapOrder('So111...', 'EPjF...', NaN, TEST_TAKER)
    ).rejects.toThrow(/amount must be a finite number/);
  });

  // --- Error paths ---

  it('throws on HTTP 400 with response body', async () => {
    mocked().mockResolvedValueOnce(
      new Response('{"error":"Invalid input mint"}', { status: 400 })
    );

    await expect(
      getSwapOrder('bad-mint', 'EPjF...', 10_000_000, TEST_TAKER)
    ).rejects.toThrow(/HTTP 400.*Invalid input mint/);
  });

  it('throws on HTTP 429 rate limit', async () => {
    mocked().mockResolvedValueOnce(
      new Response('Rate limit exceeded', { status: 429 })
    );

    await expect(
      getSwapOrder('So111...', 'EPjF...', 10_000_000, TEST_TAKER)
    ).rejects.toThrow(/HTTP 429/);
  });

  it('throws on HTTP 500 server error', async () => {
    mocked().mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 })
    );

    await expect(
      getSwapOrder('So111...', 'EPjF...', 10_000_000, TEST_TAKER)
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws on network timeout', async () => {
    mocked().mockRejectedValueOnce(
      Object.assign(new DOMException('The operation was aborted', 'AbortError'))
    );

    await expect(
      getSwapOrder('So111...', 'EPjF...', 10_000_000, TEST_TAKER)
    ).rejects.toThrow(/timed out/);
  });

  it('accepts response with inAmount but no transaction (estimate mode)', async () => {
    mocked().mockResolvedValueOnce(
      mockResponse({ requestId: 'req-1', inAmount: '100', outAmount: '50', transaction: '' })
    );

    const result = await getSwapOrder('So111...', 'EPjF...', 10_000_000, TEST_TAKER);
    expect(result.requestId).toBe('req-1');
    expect(result.inAmount).toBe('100');
  });

  it('throws on response missing both transaction and inAmount', async () => {
    mocked().mockResolvedValueOnce(
      mockResponse({ requestId: 'req-1' })
    );

    await expect(
      getSwapOrder('So111...', 'EPjF...', 10_000_000, TEST_TAKER)
    ).rejects.toThrow(/missing both "transaction" and "inAmount"/);
  });

  it('throws on response missing "requestId" field', async () => {
    mocked().mockResolvedValueOnce(
      mockResponse({ transaction: 'abc123', inAmount: '100' })
    );

    await expect(
      getSwapOrder('So111...', 'EPjF...', 10_000_000, TEST_TAKER)
    ).rejects.toThrow(/missing "requestId" field/);
  });
});

// -------------------------------------------------------------------
// executeSwap
// -------------------------------------------------------------------

describe('executeSwap', () => {
  it('sends correct POST body and parses response', async () => {
    mocked().mockResolvedValueOnce(mockResponse(fakeExecuteResponse()));

    const result = await executeSwap('signed-tx-base64', 'req-abc-123');

    // Verify fetch was called with POST + JSON body
    expect(mocked()).toHaveBeenCalledOnce();
    const [url, init] = mocked().mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/ultra/v1/execute');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });

    const body = JSON.parse(init.body as string);
    expect(body.signedTransaction).toBe('signed-tx-base64');
    expect(body.requestId).toBe('req-abc-123');

    // Verify response
    expect(result.status).toBe('Success');
    expect(result.signature).toBe('5K8Fz...mockSig');
  });

  it('throws on empty signedTransaction', async () => {
    await expect(
      executeSwap('', 'req-123')
    ).rejects.toThrow(/signedTransaction is required/);
  });

  it('throws on empty requestId', async () => {
    await expect(
      executeSwap('signed-tx', '')
    ).rejects.toThrow(/requestId is required/);
  });

  it('throws on HTTP 400', async () => {
    mocked().mockResolvedValueOnce(
      new Response('{"error":"Invalid transaction"}', { status: 400 })
    );

    await expect(
      executeSwap('bad-tx', 'req-123')
    ).rejects.toThrow(/HTTP 400/);
  });

  it('throws on HTTP 500', async () => {
    mocked().mockResolvedValueOnce(
      new Response('Server error', { status: 500 })
    );

    await expect(
      executeSwap('tx', 'req-123')
    ).rejects.toThrow(/HTTP 500/);
  });

  it('returns error field when execution fails', async () => {
    mocked().mockResolvedValueOnce(
      mockResponse(fakeExecuteResponse({ status: 'Failed', error: 'Slippage exceeded' }))
    );

    const result = await executeSwap('tx', 'req-123');
    expect(result.status).toBe('Failed');
    expect(result.error).toBe('Slippage exceeded');
  });
});

// -------------------------------------------------------------------
// swapSolToUsdc — orchestration tests
// -------------------------------------------------------------------

describe('swapSolToUsdc', () => {
  /**
   * Build a minimal real VersionedTransaction for mocking.
   * Jupiter returns base64-encoded VersionedTransactions, so our mock
   * needs to produce one that can be deserialized and signed.
   */
  function buildMockTransaction(): string {
    const message = new MessageV0({
      header: {
        numRequiredSignatures: 1,
        numReadonlySignedAccounts: 0,
        numReadonlyUnsignedAccounts: 0,
      },
      staticAccountKeys: [TEST_KEYPAIR.publicKey],
      recentBlockhash: PublicKey.default.toBase58(), // dummy blockhash
      compiledInstructions: [],
      addressTableLookups: [],
    });
    const tx = new VersionedTransaction(message);
    return Buffer.from(tx.serialize()).toString('base64');
  }

  it('orchestrates getOrder → sign → execute flow', async () => {
    const mockTxBase64 = buildMockTransaction();

    // First call: getSwapOrder
    mocked().mockResolvedValueOnce(
      mockResponse(fakeOrderResponse({ transaction: mockTxBase64 }))
    );
    // Second call: executeSwap
    mocked().mockResolvedValueOnce(
      mockResponse(fakeExecuteResponse())
    );

    const { Connection } = await import('@solana/web3.js');
    const connection = new Connection('https://api.mainnet-beta.solana.com');

    const result = await swapSolToUsdc(10_000_000, TEST_KEYPAIR, connection);

    expect(result.signature).toBe('5K8Fz...mockSig');
    expect(result.inAmount).toBe('10000000');
    expect(result.outAmount).toBe('1500000');

    // Verify two fetch calls: GET order + POST execute
    expect(mocked()).toHaveBeenCalledTimes(2);
    const [orderUrl] = mocked().mock.calls[0] as [string];
    expect(orderUrl).toContain('/ultra/v1/order');
    const [executeUrl] = mocked().mock.calls[1] as [string];
    expect(executeUrl).toContain('/ultra/v1/execute');
  });

  it('throws when execute returns non-Success status', async () => {
    const mockTxBase64 = buildMockTransaction();

    mocked().mockResolvedValueOnce(
      mockResponse(fakeOrderResponse({ transaction: mockTxBase64 }))
    );
    mocked().mockResolvedValueOnce(
      mockResponse(fakeExecuteResponse({ status: 'Failed', error: 'Slippage exceeded' }))
    );

    const { Connection } = await import('@solana/web3.js');
    const connection = new Connection('https://api.mainnet-beta.solana.com');

    await expect(
      swapSolToUsdc(10_000_000, TEST_KEYPAIR, connection)
    ).rejects.toThrow(/swap execution failed.*Slippage exceeded/);
  });

  it('throws on zero amountLamports', async () => {
    const { Connection } = await import('@solana/web3.js');
    const connection = new Connection('https://api.mainnet-beta.solana.com');

    await expect(
      swapSolToUsdc(0, TEST_KEYPAIR, connection)
    ).rejects.toThrow(/amountLamports must be positive/);
  });

  it('throws on negative amountLamports', async () => {
    const { Connection } = await import('@solana/web3.js');
    const connection = new Connection('https://api.mainnet-beta.solana.com');

    await expect(
      swapSolToUsdc(-5000, TEST_KEYPAIR, connection)
    ).rejects.toThrow(/amountLamports must be positive/);
  });
});

/**
 * Unit tests for the deBridge DLN API client.
 * All fetch calls are mocked — no real network requests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeBridgeChainId } from '../src/debridge/types.js';
import {
  createBridgeOrder,
  getOrderIdByTxHash,
  getOrderStatus,
} from '../src/debridge/api.js';
import type { DeBridgeOrderInput } from '../src/debridge/types.js';

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

/** A valid order input for testing */
function validOrderInput(overrides?: Partial<DeBridgeOrderInput>): DeBridgeOrderInput {
  return {
    srcChainId: DeBridgeChainId.SOLANA,
    srcChainTokenIn: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    srcChainTokenInAmount: '1000000', // 1 USDC in atomic
    dstChainId: DeBridgeChainId.BASE,
    dstChainTokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    prependOperatingExpenses: true,
    ...overrides,
  };
}

/** Build a mock Response */
function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// -------------------------------------------------------------------
// Chain ID constants
// -------------------------------------------------------------------

describe('DeBridgeChainId constants', () => {
  it('has correct Solana chain ID', () => {
    expect(DeBridgeChainId.SOLANA).toBe(7565164);
  });

  it('has correct Base chain ID', () => {
    expect(DeBridgeChainId.BASE).toBe(8453);
  });

  it('has correct Ethereum chain ID', () => {
    expect(DeBridgeChainId.ETHEREUM).toBe(1);
  });
});

// -------------------------------------------------------------------
// createBridgeOrder
// -------------------------------------------------------------------

describe('createBridgeOrder', () => {
  it('builds correct URL and params from input', async () => {
    const fakeResponse = {
      tx: { data: '0xabc', to: '0x123', value: '0' },
      estimation: {
        srcChainTokenIn: { address: 'x', amount: '1000000', decimals: 6, name: 'USDC', symbol: 'USDC' },
        srcChainTokenOut: { address: 'y', amount: '900000', decimals: 6, name: 'USDC', symbol: 'USDC' },
        dstChainTokenOut: { address: 'z', amount: '900000', decimals: 6, name: 'USDC', symbol: 'USDC', recommendedAmount: '890000' },
        recommendedSlippage: 0.5,
        costsDetails: [],
      },
      orderId: 'order-abc-123',
      fixFee: '0',
      userPoints: 10,
      integratorPoints: 5,
    };

    mocked().mockResolvedValueOnce(mockResponse(fakeResponse));

    const input = validOrderInput();
    const result = await createBridgeOrder(input);

    // Verify fetch was called with correct URL (GET with query params)
    expect(mocked()).toHaveBeenCalledOnce();
    const [url, init] = mocked().mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('GET');

    // Verify params are in the URL query string
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe('/v1.0/dln/order/create-tx');
    expect(parsedUrl.searchParams.get('srcChainId')).toBe(String(DeBridgeChainId.SOLANA));
    expect(parsedUrl.searchParams.get('srcChainTokenIn')).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(parsedUrl.searchParams.get('srcChainTokenInAmount')).toBe('1000000');
    expect(parsedUrl.searchParams.get('dstChainId')).toBe(String(DeBridgeChainId.BASE));
    expect(parsedUrl.searchParams.get('prependOperatingExpenses')).toBe('true');
    expect(parsedUrl.searchParams.get('dstChainTokenOutAmount')).toBe('auto');

    // Verify response is typed correctly
    expect(result.orderId).toBe('order-abc-123');
    expect(result.tx.data).toBe('0xabc');
  });

  it('throws on non-200 response with status and body', async () => {
    mocked().mockResolvedValueOnce(
      new Response('{"errorCode":"INSUFFICIENT_LIQUIDITY"}', {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(createBridgeOrder(validOrderInput())).rejects.toThrow(/HTTP 400/);
  });

  it('throws on response missing tx.data and estimation', async () => {
    mocked().mockResolvedValueOnce(mockResponse({ orderId: 'x' }));

    await expect(createBridgeOrder(validOrderInput())).rejects.toThrow(
      /missing both tx\.data and estimation/
    );
  });

  // --- Negative: malformed inputs ---

  it('throws on empty srcChainTokenInAmount', async () => {
    await expect(
      createBridgeOrder(validOrderInput({ srcChainTokenInAmount: '' }))
    ).rejects.toThrow(/srcChainTokenInAmount must be a non-zero/);
  });

  it('throws on zero srcChainTokenInAmount', async () => {
    await expect(
      createBridgeOrder(validOrderInput({ srcChainTokenInAmount: '0' }))
    ).rejects.toThrow(/srcChainTokenInAmount must be a non-zero/);
  });

  it('throws on missing srcChainTokenIn', async () => {
    await expect(
      createBridgeOrder(validOrderInput({ srcChainTokenIn: '' }))
    ).rejects.toThrow(/srcChainTokenIn is required/);
  });

  it('throws on missing dstChainTokenOut', async () => {
    await expect(
      createBridgeOrder(validOrderInput({ dstChainTokenOut: '' }))
    ).rejects.toThrow(/dstChainTokenOut is required/);
  });

  it('throws on missing srcChainId', async () => {
    await expect(
      createBridgeOrder(validOrderInput({ srcChainId: 0 }))
    ).rejects.toThrow(/srcChainId is required/);
  });
});

// -------------------------------------------------------------------
// getOrderIdByTxHash
// -------------------------------------------------------------------

describe('getOrderIdByTxHash', () => {
  it('returns null on 404 (order not indexed yet)', async () => {
    mocked().mockResolvedValueOnce(
      new Response('Not Found', { status: 404 })
    );

    const result = await getOrderIdByTxHash('0xdeadbeef');
    expect(result).toBeNull();
  });

  it('returns first order ID from array response', async () => {
    mocked().mockResolvedValueOnce(mockResponse(['order-1', 'order-2']));

    const result = await getOrderIdByTxHash('0xabc123');
    expect(result).toBe('order-1');
  });

  it('returns null for empty array response', async () => {
    mocked().mockResolvedValueOnce(mockResponse([]));

    const result = await getOrderIdByTxHash('0xabc123');
    expect(result).toBeNull();
  });

  it('throws on server error with status and context', async () => {
    mocked().mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 })
    );

    await expect(getOrderIdByTxHash('0xfail')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on empty txHash', async () => {
    await expect(getOrderIdByTxHash('')).rejects.toThrow(/txHash is required/);
  });
});

// -------------------------------------------------------------------
// getOrderStatus
// -------------------------------------------------------------------

describe('getOrderStatus', () => {
  it('parses valid status response', async () => {
    mocked().mockResolvedValueOnce(
      mockResponse({
        orderId: 'order-xyz',
        status: 'Fulfilled',
        give: { chainId: 7565164 },
        take: { chainId: 8453 },
        fulfilledDstEventMetadata: {
          transactionHash: { stringValue: '0xfulfill123' },
        },
      })
    );

    const status = await getOrderStatus('order-xyz');
    expect(status.orderId).toBe('order-xyz');
    expect(status.status).toBe('Fulfilled');
    expect(status.sourceChainId).toBe(7565164);
    expect(status.destinationChainId).toBe(8453);
    expect(status.fulfillTransactionHash).toBe('0xfulfill123');
  });

  it('handles response with direct chain IDs', async () => {
    mocked().mockResolvedValueOnce(
      mockResponse({
        orderId: 'order-abc',
        status: 'Created',
        sourceChainId: 7565164,
        destinationChainId: 8453,
      })
    );

    const status = await getOrderStatus('order-abc');
    expect(status.status).toBe('Created');
    expect(status.sourceChainId).toBe(7565164);
  });

  it('throws on server error', async () => {
    mocked().mockResolvedValueOnce(
      new Response('Bad Gateway', { status: 502 })
    );

    await expect(getOrderStatus('order-fail')).rejects.toThrow(/HTTP 502/);
  });

  it('throws on empty orderId', async () => {
    await expect(getOrderStatus('')).rejects.toThrow(/orderId is required/);
  });
});
